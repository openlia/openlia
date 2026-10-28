package operator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const catalogProvenanceFile = ".openlia-catalog.json"

// Keep a published cache generation stable across preflight and file copying.
// Live development checkouts are explicitly mutable and do not use this lock.
func lockTemplatesCatalogForRead(config Config) (func(), error) {
	root := ResolveTemplatesRoot(config)
	if root != filepath.Join(config.MetaRoot, "templates-cache") {
		return func() {}, nil
	}
	if _, err := os.Stat(filepath.Join(root, catalogProvenanceFile)); os.IsNotExist(err) {
		return func() {}, nil
	}
	file, err := os.Open(filepath.Join(config.MetaRoot, ".templates-sync.lock"))
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_SH|unix.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("templates catalog is being synchronized; retry after sync completes: %w", err)
	}
	return func() { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN); _ = file.Close() }, nil
}

type TemplatesCatalogProvenance struct {
	Schema        int    `json:"schema"`
	Source        string `json:"source"`
	Ref           string `json:"ref"`
	Revision      string `json:"revision,omitempty"`
	Mode          string `json:"mode"` // git or local-worktree
	Dirty         bool   `json:"dirty"`
	ContentSHA256 string `json:"content_sha256"`
}

var templatesRefPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)

func templatesGit(ctx context.Context, dir string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, "git", append([]string{"-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"}, args...)...)
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "GIT_") {
			command.Env = append(command.Env, value)
		}
	}
	command.Env = append(command.Env, "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("templates git %s: %w: %s", args[0], err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func catalogIgnored(path string) bool {
	name := filepath.Base(path)
	return name == ".git" || name == "__pycache__" || name == ".DS_Store" || name == catalogProvenanceFile || strings.HasSuffix(name, ".pyc")
}

// Hash content, not Git internals or generated sync metadata. Reject links and
// special files rather than accidentally reading outside an untrusted catalog.
func templatesTreeHash(root string) (string, error) {
	digest := sha256.New()
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		if catalogIgnored(path) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("catalog symlinks are not supported: %s", path)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("catalog contains a non-regular file: %s", path)
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		fmt.Fprintf(digest, "%s\x00%d\x00", filepath.ToSlash(rel), info.Size())
		_, err = io.Copy(digest, file)
		closeErr := file.Close()
		if err != nil {
			return err
		}
		return closeErr
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func localCatalogProvenance(ctx context.Context, source string) (*TemplatesCatalogProvenance, error) {
	hash, err := templatesTreeHash(source)
	if err != nil {
		return nil, err
	}
	info := &TemplatesCatalogProvenance{Schema: 1, Source: source, Ref: "worktree", Mode: "local-worktree", Dirty: true, ContentSHA256: hash}
	if revision, err := templatesGit(ctx, source, "rev-parse", "HEAD"); err == nil {
		info.Revision = revision
		status, err := templatesGit(ctx, source, "status", "--porcelain", "--untracked-files=normal")
		if err != nil {
			return nil, err
		}
		info.Dirty = status != ""
	}
	return info, nil
}

func currentTemplatesProvenance(config Config) *TemplatesCatalogProvenance {
	root := ResolveTemplatesRoot(config)
	if !isCatalogDirectory(root) {
		return nil
	}
	if data, err := os.ReadFile(filepath.Join(root, catalogProvenanceFile)); err == nil {
		var info TemplatesCatalogProvenance
		if json.Unmarshal(data, &info) == nil && info.Schema == 1 {
			return &info
		}
	}
	// A live checkout is intentionally not represented as an immutable release.
	info, _ := localCatalogProvenance(context.Background(), root)
	return info
}

func recordSkillCatalog(config Config, path, id, source string, result SkillResult) error {
	if result.ResultState != "managed" || (result.Action != "installed" && result.Action != "updated" && result.Action != "unchanged") {
		return nil
	}
	root := ResolveTemplatesRoot(config)
	rel, err := filepath.Rel(root, source)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return nil
	}
	metadata, err := readFullSkillMetadata(path, id)
	if err != nil {
		return err
	}
	metadata.Catalog = currentTemplatesProvenance(config)
	metadata.CatalogArtifactPath = filepath.ToSlash(rel)
	return writeSkillMetadata(path, metadata)
}

func catalogProvenanceForPath(config Config, path string) *TemplatesCatalogProvenance {
	root := ResolveTemplatesRoot(config)
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return nil
	}
	return currentTemplatesProvenance(config)
}

func validateCatalogTree(root string) error {
	if !isCatalogDirectory(root) {
		return fmt.Errorf("catalog must contain features/, profiles/, or skills/")
	}
	if _, err := templatesTreeHash(root); err != nil {
		return err
	}
	manifests, _, err := LoadCatalogFeatures(root)
	if err != nil {
		return err
	}
	if len(manifests) != countSubdirs(filepath.Join(root, "features")) {
		return fmt.Errorf("every catalog feature directory must contain feature.yaml")
	}
	byID := map[string]FeatureManifest{}
	for _, manifest := range manifests {
		if _, exists := byID[manifest.ID]; exists {
			return fmt.Errorf("duplicate catalog feature %s", manifest.ID)
		}
		if _, err := os.Stat(filepath.Join(root, "features", manifest.ID, "feature.yaml")); err != nil {
			return fmt.Errorf("feature directory must match id %s", manifest.ID)
		}
		byID[manifest.ID] = manifest
	}
	active, done := map[string]bool{}, map[string]bool{}
	var visit func(string) error
	visit = func(id string) error {
		if active[id] {
			return fmt.Errorf("cyclic feature dependency at %s", id)
		}
		if done[id] {
			return nil
		}
		manifest, ok := byID[id]
		if !ok {
			return fmt.Errorf("missing required feature %s", id)
		}
		active[id] = true
		for _, required := range manifest.Requires.Features {
			if err := visit(required); err != nil {
				return err
			}
		}
		delete(active, id)
		done[id] = true
		return nil
	}
	for id := range byID {
		if err := visit(id); err != nil {
			return err
		}
	}
	// Check declarations without requiring this runtime to support every catalog
	// item: sync is allowed to discover newer content; install enforces its minimum.
	p := newTemplatePreflight(Config{})
	p.validateOnly = true
	for _, manifest := range manifests {
		for _, skill := range manifest.Skills {
			if err := p.skill(filepath.Join(root, "features", manifest.ID, filepath.FromSlash(skill.Path))); err != nil {
				return err
			}
		}
	}
	entries, _ := os.ReadDir(filepath.Join(root, "skills"))
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			if err := p.skill(filepath.Join(root, "skills", entry.Name())); err != nil {
				return err
			}
		}
	}
	profiles, _ := filepath.Glob(filepath.Join(root, "profiles", "*", "profile.yaml"))
	if len(profiles) != countSubdirs(filepath.Join(root, "profiles")) {
		return fmt.Errorf("every catalog profile directory must contain profile.yaml")
	}
	for _, path := range profiles {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		manifest, err := ParseProfileManifest(data)
		if err != nil {
			return err
		}
		if manifest.ID != filepath.Base(filepath.Dir(path)) {
			return fmt.Errorf("profile directory must match id %s", manifest.ID)
		}
		for _, id := range manifest.Features {
			if _, ok := byID[id]; !ok {
				return fmt.Errorf("profile %s requires missing feature %s", manifest.ID, id)
			}
		}
	}
	if data, err := os.ReadFile(filepath.Join(root, "catalog.json")); err == nil {
		var index struct {
			Schema   int `json:"schema"`
			Features []struct {
				ID      string `json:"id"`
				Version string `json:"version"`
				Path    string `json:"path"`
			} `json:"features"`
		}
		if err := json.Unmarshal(data, &index); err != nil || index.Schema != 1 {
			return fmt.Errorf("invalid catalog.json")
		}
		if len(index.Features) != len(byID) {
			return fmt.Errorf("catalog.json feature index is stale")
		}
		seen := map[string]bool{}
		for _, feature := range index.Features {
			manifest, ok := byID[feature.ID]
			if !ok || seen[feature.ID] || manifest.Version != feature.Version || feature.Path != "features/"+feature.ID {
				return fmt.Errorf("catalog.json entry is stale: %s", feature.ID)
			}
			seen[feature.ID] = true
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return nil
}

func syncTemplatesCatalog(ctx context.Context, config Config) (TemplatesSyncResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return TemplatesSyncResult{}, err
	}
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return TemplatesSyncResult{}, err
	}
	if err := ValidateAbsolutePath(config.MetaRoot, "metadata-root"); err != nil {
		return TemplatesSyncResult{}, err
	}
	source := strings.TrimSpace(config.TemplatesRepo)
	if source == "" {
		source = strings.TrimSpace(os.Getenv("OPENLIA_TEMPLATES_REPO"))
	}
	if source == "" {
		source = DefaultTemplatesRepo
	}
	ref := strings.TrimSpace(config.TemplatesRef)
	if ref == "" {
		ref = strings.TrimSpace(os.Getenv("OPENLIA_TEMPLATES_REF"))
	}
	local := false
	if info, err := os.Stat(source); err == nil && info.IsDir() {
		local = true
	}
	if !local && ref == "" {
		if source != DefaultTemplatesRepo {
			return TemplatesSyncResult{}, fmt.Errorf("custom remote templates repositories require an explicit ref")
		}
		ref = DefaultTemplatesRef
	}
	if ref != "" && (!templatesRefPattern.MatchString(ref) || strings.Contains(ref, "..")) {
		return TemplatesSyncResult{}, fmt.Errorf("invalid templates ref %q", ref)
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return TemplatesSyncResult{}, err
	}
	lock, err := os.OpenFile(filepath.Join(config.MetaRoot, ".templates-sync.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return TemplatesSyncResult{}, err
	}
	defer lock.Close()
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return TemplatesSyncResult{}, fmt.Errorf("templates sync already in progress: %w", err)
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	if err := recoverCatalogActivation(config.MetaRoot); err != nil {
		return TemplatesSyncResult{}, err
	}
	stage, err := os.MkdirTemp(config.MetaRoot, ".templates-stage-*")
	if err != nil {
		return TemplatesSyncResult{}, err
	}
	defer os.RemoveAll(stage)
	cache := filepath.Join(config.MetaRoot, "templates-cache")
	var info *TemplatesCatalogProvenance
	if local && ref == "" {
		source, err = filepath.Abs(source)
		if err != nil {
			return TemplatesSyncResult{}, err
		}
		if source == cache {
			return TemplatesSyncResult{}, fmt.Errorf("templates source must not be the managed cache itself")
		}
		if stat, err := os.Lstat(source); err != nil || stat.Mode()&os.ModeSymlink != 0 {
			return TemplatesSyncResult{}, fmt.Errorf("templates source must be a real directory, not a symlink")
		}
		rel, err := filepath.Rel(source, config.MetaRoot)
		if err != nil || rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))) {
			return TemplatesSyncResult{}, fmt.Errorf("templates source must not contain the metadata/cache directory")
		}
		info, err = localCatalogProvenance(ctx, source)
		if err != nil {
			return TemplatesSyncResult{}, err
		}
		entries, err := os.ReadDir(source)
		if err != nil {
			return TemplatesSyncResult{}, err
		}
		for _, entry := range entries {
			if catalogIgnored(entry.Name()) {
				continue
			}
			from, to := filepath.Join(source, entry.Name()), filepath.Join(stage, entry.Name())
			if entry.IsDir() {
				err = CopyDir(from, to)
			} else {
				err = AtomicCopyFile(from, to, 0o600)
			}
			if err != nil {
				return TemplatesSyncResult{}, err
			}
		}
	} else {
		if _, err := templatesGit(ctx, stage, "init", "--quiet"); err != nil {
			return TemplatesSyncResult{}, err
		}
		if _, err := templatesGit(ctx, stage, "fetch", "--depth=1", "--no-tags", "--", source, ref); err != nil {
			return TemplatesSyncResult{}, err
		}
		if _, err := templatesGit(ctx, stage, "checkout", "--quiet", "--detach", "FETCH_HEAD"); err != nil {
			return TemplatesSyncResult{}, err
		}
		revision, err := templatesGit(ctx, stage, "rev-parse", "HEAD")
		if err != nil {
			return TemplatesSyncResult{}, err
		}
		if len(ref) == 40 && strings.Trim(ref, "0123456789abcdef") == "" && revision != ref {
			return TemplatesSyncResult{}, fmt.Errorf("resolved templates revision differs from requested SHA")
		}
		if _, err := os.Stat(filepath.Join(stage, "catalog.json")); err != nil {
			return TemplatesSyncResult{}, fmt.Errorf("published templates revision is missing catalog.json")
		}
		if err := os.RemoveAll(filepath.Join(stage, ".git")); err != nil {
			return TemplatesSyncResult{}, err
		}
		info = &TemplatesCatalogProvenance{Schema: 1, Source: source, Ref: ref, Revision: revision, Mode: "git"}
	}
	if err := validateCatalogTree(stage); err != nil {
		return TemplatesSyncResult{}, fmt.Errorf("validate staged templates catalog: %w", err)
	}
	hash, err := templatesTreeHash(stage)
	if err != nil {
		return TemplatesSyncResult{}, err
	}
	if info.Mode == "local-worktree" && info.ContentSHA256 != hash {
		return TemplatesSyncResult{}, fmt.Errorf("local templates changed while syncing; retry")
	}
	info.ContentSHA256 = hash
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return TemplatesSyncResult{}, err
	}
	if err := AtomicWriteFile(filepath.Join(stage, catalogProvenanceFile), append(data, '\n'), 0o600); err != nil {
		return TemplatesSyncResult{}, err
	}
	if config.RuntimeUID > 0 && config.RuntimeGID > 0 && os.Geteuid() == 0 {
		if err := ensureRuntimeTreeOwner(stage, config.RuntimeUID, config.RuntimeGID); err != nil {
			return TemplatesSyncResult{}, err
		}
	}
	if err := ctx.Err(); err != nil {
		return TemplatesSyncResult{}, err
	}
	if old, err := os.Lstat(cache); err == nil {
		if !old.IsDir() || old.Mode()&os.ModeSymlink != 0 {
			return TemplatesSyncResult{}, fmt.Errorf("templates cache must be a real directory")
		}
		if existingHash, err := templatesTreeHash(cache); err == nil && existingHash == hash {
			metadataPath := filepath.Join(cache, catalogProvenanceFile)
			if err := AtomicWriteFile(metadataPath, append(data, '\n'), 0o600); err != nil {
				return TemplatesSyncResult{}, err
			}
			if config.RuntimeUID > 0 && config.RuntimeGID > 0 && os.Geteuid() == 0 {
				if err := ensureRuntimeOwner(metadataPath, config.RuntimeUID, config.RuntimeGID, 0o600); err != nil {
					return TemplatesSyncResult{}, err
				}
			}
			return templatesSyncResultForConfig(ctx, config, cache, info)
		}
	} else if !os.IsNotExist(err) {
		return TemplatesSyncResult{}, err
	}
	if _, err := activateTemplatesCatalog(config, stage, info); err != nil {
		return TemplatesSyncResult{}, err
	}
	return templatesSyncResultForConfig(ctx, config, cache, info)
}

func templatesSyncResultForConfig(ctx context.Context, config Config, cache string, info *TemplatesCatalogProvenance) (TemplatesSyncResult, error) {
	state, err := templatesUIRefreshStatus(ctx, config)
	if err != nil {
		return TemplatesSyncResult{}, err
	}
	return templatesSyncResult(cache, info, state.Required, state.Previous), nil
}

func templatesSyncResult(cache string, info *TemplatesCatalogProvenance, refresh bool, previous string) TemplatesSyncResult {
	return TemplatesSyncResult{OK: true, Action: "templates-sync", Source: info.Source, Ref: info.Ref, CacheDir: cache, Catalog: info, UIRefreshRequired: refresh, PreviousCacheDir: previous, ProfilesCount: countSubdirs(filepath.Join(cache, "profiles")), FeaturesCount: countSubdirs(filepath.Join(cache, "features")), SkillsCount: countSubdirs(filepath.Join(cache, "skills"))}
}

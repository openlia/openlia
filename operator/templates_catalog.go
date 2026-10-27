package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	DefaultTemplatesRepo = "https://github.com/openlia/templates.git"
	DefaultTemplatesRef  = "main"
)

type TemplatesSyncResult struct {
	OK            bool   `json:"ok"`
	Action        string `json:"action"`
	Source        string `json:"source"`
	Ref           string `json:"ref"`
	CacheDir      string `json:"cache_dir"`
	ProfilesCount int    `json:"profiles_count"`
	FeaturesCount int    `json:"features_count"`
	SkillsCount   int    `json:"skills_count"`
}

type RebaseResult struct {
	OK               bool     `json:"ok"`
	Action           string   `json:"action"`
	ID               string   `json:"id"`
	Kind             string   `json:"kind"`   // "feature" or "skill"
	Status           string   `json:"status"` // "unchanged", "fast-forward", "merged", "conflict"
	AutoForked       bool     `json:"auto_forked"`
	Conflicts        []string `json:"conflicts,omitempty"`
	MigrationContext string   `json:"migration_context,omitempty"`
}

// ResolveTemplatesRoot returns the directory containing the templates catalog
// (`features/`, `skills/`, `profiles/`).
func ResolveTemplatesRoot(config Config) string {
	for _, candidate := range []string{
		strings.TrimSpace(config.TemplatesRepo),
		strings.TrimSpace(os.Getenv("OPENLIA_TEMPLATES_REPO")),
		strings.TrimSpace(os.Getenv("OPENLIA_TEMPLATES_ROOT")),
	} {
		if candidate == "" {
			continue
		}
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}

	if config.MetaRoot != "" {
		cacheDir := filepath.Join(config.MetaRoot, "templates-cache")
		if info, err := os.Stat(filepath.Join(cacheDir, "features")); err == nil && info.IsDir() {
			return cacheDir
		}
	}

	if config.RepositoryRoot != "" {
		repoFeatures := filepath.Join(config.RepositoryRoot, "features")
		if info, err := os.Stat(repoFeatures); err == nil && info.IsDir() {
			return config.RepositoryRoot
		}
		sibling := filepath.Join(filepath.Dir(config.RepositoryRoot), "openlia_templates")
		if info, err := os.Stat(filepath.Join(sibling, "features")); err == nil && info.IsDir() {
			return sibling
		}
	}

	return config.RepositoryRoot
}

// SyncTemplatesCatalog clones or updates the templates catalog in <MetaRoot>/templates-cache.
func SyncTemplatesCatalog(ctx context.Context, config Config) (TemplatesSyncResult, error) {
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return TemplatesSyncResult{}, err
	}
	source := strings.TrimSpace(config.TemplatesRepo)
	if source == "" {
		source = strings.TrimSpace(os.Getenv("OPENLIA_TEMPLATES_REPO"))
	}
	if source == "" {
		sibling := filepath.Join(filepath.Dir(config.RepositoryRoot), "openlia_templates")
		if info, err := os.Stat(filepath.Join(sibling, "features")); err == nil && info.IsDir() {
			source = sibling
		} else {
			source = DefaultTemplatesRepo
		}
	}
	ref := strings.TrimSpace(config.TemplatesRef)
	if ref == "" {
		ref = strings.TrimSpace(os.Getenv("OPENLIA_TEMPLATES_REF"))
	}
	if ref == "" {
		ref = DefaultTemplatesRef
	}

	cacheDir := filepath.Join(config.MetaRoot, "templates-cache")
	if err := EnsureDir(filepath.Dir(cacheDir), 0o700); err != nil {
		return TemplatesSyncResult{}, err
	}

	if info, err := os.Stat(source); err == nil && info.IsDir() {
		if err := replaceDirectory(source, cacheDir); err != nil {
			return TemplatesSyncResult{}, fmt.Errorf("sync local templates directory: %w", err)
		}
	} else {
		gitDir := filepath.Join(cacheDir, ".git")
		if info, err := os.Stat(gitDir); err == nil && info.IsDir() {
			cmd := exec.CommandContext(ctx, "git", "-C", cacheDir, "pull", "--ff-only", "origin", ref)
			if out, err := cmd.CombinedOutput(); err != nil {
				return TemplatesSyncResult{}, fmt.Errorf("git pull templates catalog: %s: %w", strings.TrimSpace(string(out)), err)
			}
		} else {
			_ = os.RemoveAll(cacheDir)
			cmd := exec.CommandContext(ctx, "git", "clone", "--depth", "1", "--branch", ref, source, cacheDir)
			if out, err := cmd.CombinedOutput(); err != nil {
				return TemplatesSyncResult{}, fmt.Errorf("git clone templates catalog: %s: %w", strings.TrimSpace(string(out)), err)
			}
		}
	}

	profilesCount := countSubdirs(filepath.Join(cacheDir, "profiles"))
	featuresCount := countSubdirs(filepath.Join(cacheDir, "features"))
	skillsCount := countSubdirs(filepath.Join(cacheDir, "skills"))

	return TemplatesSyncResult{
		OK:            true,
		Action:        "templates-sync",
		Source:        source,
		Ref:           ref,
		CacheDir:      cacheDir,
		ProfilesCount: profilesCount,
		FeaturesCount: featuresCount,
		SkillsCount:   skillsCount,
	}, nil
}

func countSubdirs(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			count++
		}
	}
	return count
}

// LoadCatalogSkills returns a map of skillID -> sourceDir across the templates catalog
// (`skills/*` and `features/*/skills/*`) and any bundled `profile/skills/*`.
func LoadCatalogSkills(config Config) (map[string]string, error) {
	out := make(map[string]string)
	templatesRoot := ResolveTemplatesRoot(config)

	for _, root := range []string{
		filepath.Join(config.RepositoryRoot, "profile", "skills"),
		filepath.Join(templatesRoot, "skills"),
	} {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			skDir := filepath.Join(root, entry.Name())
			if _, err := os.Stat(filepath.Join(skDir, "SKILL.md")); err == nil {
				out[entry.Name()] = skDir
			}
		}
	}

	if _, featPaths, err := LoadCatalogFeaturesForConfig(config); err == nil {
		for _, pkgDir := range featPaths {
			skRoot := filepath.Join(pkgDir, "skills")
			entries, err := os.ReadDir(skRoot)
			if err != nil {
				continue
			}
			for _, entry := range entries {
				if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
					continue
				}
				if _, exists := out[entry.Name()]; exists {
					continue
				}
				skDir := filepath.Join(skRoot, entry.Name())
				if _, err := os.Stat(filepath.Join(skDir, "SKILL.md")); err == nil {
					out[entry.Name()] = skDir
				}
			}
		}
	}
	return out, nil
}

// RebaseDirectoryThreeWay performs a 3-way merge of files from oldBaseDir, currentDir, and newBaseDir.
// If currentDir was modified relative to oldBaseDir, it is automatically detected as a fork.
// Non-conflicting changes are merged into mergedOutDir; overlapping line conflicts are returned in conflicts.
func RebaseDirectoryThreeWay(oldBaseDir, currentDir, newBaseDir, mergedOutDir string) (autoForked bool, conflicts []string, err error) {
	oldHash, err := DirectorySHA256(oldBaseDir)
	if err != nil {
		return false, nil, fmt.Errorf("hash old base: %w", err)
	}
	curHash, err := DirectorySHA256(currentDir)
	if err != nil {
		return false, nil, fmt.Errorf("hash current dir: %w", err)
	}
	newHash, err := DirectorySHA256(newBaseDir)
	if err != nil {
		return false, nil, fmt.Errorf("hash new base: %w", err)
	}

	autoForked = curHash != oldHash
	if !autoForked || curHash == newHash {
		if err := replaceDirectory(newBaseDir, mergedOutDir); err != nil {
			return autoForked, nil, err
		}
		return autoForked, nil, nil
	}

	oldFiles, err := collectRelativeFiles(oldBaseDir)
	if err != nil {
		return autoForked, nil, err
	}
	curFiles, err := collectRelativeFiles(currentDir)
	if err != nil {
		return autoForked, nil, err
	}
	newFiles, err := collectRelativeFiles(newBaseDir)
	if err != nil {
		return autoForked, nil, err
	}

	allPathsMap := make(map[string]bool)
	for p := range oldFiles {
		allPathsMap[p] = true
	}
	for p := range curFiles {
		allPathsMap[p] = true
	}
	for p := range newFiles {
		allPathsMap[p] = true
	}
	var allPaths []string
	for p := range allPathsMap {
		allPaths = append(allPaths, p)
	}
	sort.Strings(allPaths)

	if err := removeSafeDirectory(mergedOutDir); err != nil {
		return autoForked, nil, err
	}
	if err := EnsureDir(mergedOutDir, 0o755); err != nil {
		return autoForked, nil, err
	}

	for _, rel := range allPaths {
		oldData, inOld := oldFiles[rel]
		curData, inCur := curFiles[rel]
		newData, inNew := newFiles[rel]
		outPath := filepath.Join(mergedOutDir, filepath.FromSlash(rel))

		switch {
		case inOld && inCur && bytes.Equal(oldData, curData):
			// Unmodified by user: take upstream (or delete if deleted upstream)
			if inNew {
				if err := writeMergedFile(outPath, newData); err != nil {
					return autoForked, nil, err
				}
			}
		case inOld && inNew && bytes.Equal(oldData, newData):
			// Unmodified upstream: keep user's version (or deletion)
			if inCur {
				if err := writeMergedFile(outPath, curData); err != nil {
					return autoForked, nil, err
				}
			}
		case inCur && inNew && bytes.Equal(curData, newData):
			if err := writeMergedFile(outPath, curData); err != nil {
				return autoForked, nil, err
			}
		case !inOld && inCur && !inNew:
			// Added by user only
			if err := writeMergedFile(outPath, curData); err != nil {
				return autoForked, nil, err
			}
		case !inOld && !inCur && inNew:
			// Added by upstream only
			if err := writeMergedFile(outPath, newData); err != nil {
				return autoForked, nil, err
			}
		case inOld && inCur && inNew:
			// Modified by both user and upstream: 3-way line merge
			mergedBytes, mergeErr := mergeInstructionLines(oldData, curData, newData)
			if mergeErr != nil {
				conflicts = append(conflicts, rel)
				continue
			}
			if err := writeMergedFile(outPath, mergedBytes); err != nil {
				return autoForked, nil, err
			}
		default:
			// Modify/delete or add/add conflict
			conflicts = append(conflicts, rel)
		}
	}

	return autoForked, conflicts, nil
}

func collectRelativeFiles(root string) (map[string][]byte, error) {
	out := make(map[string][]byte)
	info, err := os.Stat(root)
	if errors.Is(err, os.ErrNotExist) || (err == nil && !info.IsDir()) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			if p != root && (d.Name() == "__pycache__" || d.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = data
		return nil
	})
	return out, err
}

func writeMergedFile(path string, data []byte) error {
	if err := EnsureDir(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return AtomicWriteFile(path, data, 0o644)
}

func splitLines(text string) []string {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.TrimSuffix(normalized, "\n")
	if normalized == "" {
		return nil
	}
	return strings.Split(normalized, "\n")
}

// RebaseInstalledSkill performs automatic fork detection and 3-way rebase of an
// installed skill against its upstream catalog source.
func RebaseInstalledSkill(config Config, skillID string, now time.Time) (RebaseResult, error) {
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return RebaseResult{}, err
	}
	if err := ValidateSafeComponent(skillID, "skill"); err != nil {
		return RebaseResult{}, err
	}
	catalogSkills, err := LoadCatalogSkills(config)
	if err != nil {
		return RebaseResult{}, err
	}
	newBaseDir, ok := catalogSkills[skillID]
	if !ok {
		return RebaseResult{}, fmt.Errorf("skill %s not found in templates catalog", skillID)
	}
	destination := filepath.Join(config.DataRoot, "skills", skillID)
	if info, err := os.Stat(destination); err != nil || !info.IsDir() {
		return RebaseResult{}, fmt.Errorf("skill %s is not installed", skillID)
	}
	metadataPath := filepath.Join(config.MetaRoot, "managed", "skills", skillID+".json")
	basePath := filepath.Join(config.MetaRoot, "managed", "skills", skillID, "base")
	if info, err := os.Stat(basePath); err != nil || !info.IsDir() {
		if err := replaceDirectory(destination, basePath); err != nil {
			return RebaseResult{}, err
		}
	}

	oldBaseHash, err := DirectorySHA256(basePath)
	if err != nil {
		return RebaseResult{}, err
	}
	curHash, err := DirectorySHA256(destination)
	if err != nil {
		return RebaseResult{}, err
	}
	newBaseHash, err := DirectorySHA256(newBaseDir)
	if err != nil {
		return RebaseResult{}, err
	}

	autoForked := curHash != oldBaseHash
	if autoForked {
		// Automatically record fork lineage if not already recorded
		if meta, err := readFullSkillMetadata(metadataPath, skillID); err == nil {
			if patch, pErr := GenerateSkillPatch(basePath, destination, skillID); pErr == nil {
				patchPath := filepath.Join(config.MetaRoot, filepath.FromSlash(meta.PatchPath))
				if patchHash, wErr := WriteSkillPatch(patchPath, patch); wErr == nil {
					meta.Ownership = "forked"
					meta.ForkSHA256 = "sha256:" + curHash
					meta.PatchSHA256 = patchHash
					if meta.ForkedAt == "" {
						meta.ForkedAt = utcTimestamp(now)
					}
					meta.UpdatedAt = utcTimestamp(now)
					_ = writeSkillMetadata(metadataPath, meta)
				}
			}
		}
	}

	if oldBaseHash == newBaseHash {
		return RebaseResult{
			OK:         true,
			Action:     "skill-update",
			ID:         skillID,
			Kind:       "skill",
			Status:     "unchanged",
			AutoForked: autoForked,
		}, nil
	}

	tmpMerged, err := os.MkdirTemp("", "openlia-skill-rebase-*")
	if err != nil {
		return RebaseResult{}, err
	}
	defer os.RemoveAll(tmpMerged)

	_, conflicts, err := RebaseDirectoryThreeWay(basePath, destination, newBaseDir, tmpMerged)
	if err != nil {
		return RebaseResult{}, err
	}

	if len(conflicts) > 0 {
		// Stage conflict context in /opt/data/.openlia/migrations/<skillID>
		contextRoot := filepath.Join(config.DataRoot, ".openlia", "migrations", skillID)
		_ = removeSafeDirectory(contextRoot)
		_ = EnsureDir(contextRoot, 0o700)
		_ = CopyDir(basePath, filepath.Join(contextRoot, "old-base"))
		_ = CopyDir(destination, filepath.Join(contextRoot, "current-fork"))
		_ = CopyDir(newBaseDir, filepath.Join(contextRoot, "new-base"))
		if patch, pErr := GenerateSkillPatch(basePath, destination, skillID); pErr == nil {
			_, _ = WriteSkillPatch(filepath.Join(contextRoot, "customization.patch"), patch)
		}
		ctxDetails := map[string]any{
			"schema":            1,
			"skill":             skillID,
			"old_base_hash":     "sha256:" + oldBaseHash,
			"current_fork_hash": "sha256:" + curHash,
			"new_base_hash":     "sha256:" + newBaseHash,
			"conflicts":         conflicts,
			"created_at":        utcTimestamp(now),
		}
		if ctxBytes, mErr := json.MarshalIndent(ctxDetails, "", "  "); mErr == nil {
			_ = AtomicWriteFile(filepath.Join(contextRoot, "context.json"), append(ctxBytes, '\n'), 0o600)
		}
		return RebaseResult{
			OK:               true,
			Action:           "skill-update",
			ID:               skillID,
			Kind:             "skill",
			Status:           "conflict",
			AutoForked:       autoForked,
			Conflicts:        conflicts,
			MigrationContext: contextRoot,
		}, nil
	}

	if err := replaceDirectory(tmpMerged, destination); err != nil {
		return RebaseResult{}, err
	}
	if err := normalizeSkill(destination); err != nil {
		return RebaseResult{}, err
	}
	if err := replaceDirectory(newBaseDir, basePath); err != nil {
		return RebaseResult{}, err
	}

	mergedHash, err := DirectorySHA256(destination)
	if err != nil {
		return RebaseResult{}, err
	}
	prof := NewProfileOperator(config)
	if !now.IsZero() {
		prof.Now = func() time.Time { return now.UTC() }
	}
	distVer, distSource := prof.distributionInfo()
	meta := prof.newMetadata(skillID, "sha256:"+newBaseHash, distVer, distSource)
	if patch, pErr := GenerateSkillPatch(basePath, destination, skillID); pErr == nil {
		patchPath := filepath.Join(config.MetaRoot, filepath.FromSlash(meta.PatchPath))
		if patchHash, wErr := WriteSkillPatch(patchPath, patch); wErr == nil {
			meta.PatchSHA256 = patchHash
		}
	}
	if mergedHash != newBaseHash {
		meta.Ownership = "forked"
		meta.ForkSHA256 = "sha256:" + mergedHash
		meta.ForkedAt = utcTimestamp(now)
	}
	_ = writeSkillMetadata(metadataPath, meta)
	_ = ProvisionSkillEnvironment(config, skillID, destination, "", "")

	status := "fast-forward"
	if autoForked {
		status = "merged"
	}
	return RebaseResult{
		OK:         true,
		Action:     "skill-update",
		ID:         skillID,
		Kind:       "skill",
		Status:     status,
		AutoForked: autoForked,
	}, nil
}

package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"openlia/internal/releaseinfo"
)

var (
	DefaultTemplatesRepo = releaseinfo.Default.Templates.Repository
	DefaultTemplatesRef  = releaseinfo.Default.Templates.Revision
)

type TemplatesSyncResult struct {
	OK                bool                        `json:"ok"`
	Action            string                      `json:"action"`
	Source            string                      `json:"source"`
	Ref               string                      `json:"ref"`
	CacheDir          string                      `json:"cache_dir"`
	ProfilesCount     int                         `json:"profiles_count"`
	FeaturesCount     int                         `json:"features_count"`
	SkillsCount       int                         `json:"skills_count"`
	Catalog           *TemplatesCatalogProvenance `json:"catalog"`
	UIRefreshRequired bool                        `json:"ui_refresh_required"`
	PreviousCacheDir  string                      `json:"previous_cache_dir,omitempty"`
}

type ProfileInstructionsSpec struct {
	Soul            string `json:"soul,omitempty"`
	ProfileAgents   string `json:"profile_agents,omitempty"`
	WorkspaceAgents string `json:"workspace_agents,omitempty"`
}

type TemplateProfileManifest struct {
	Schema       int                     `json:"schema"`
	ID           string                  `json:"id"`
	Name         string                  `json:"name"`
	Version      string                  `json:"version"`
	Description  string                  `json:"description"`
	Author       string                  `json:"author,omitempty"`
	License      string                  `json:"license,omitempty"`
	Features     []string                `json:"features,omitempty"`
	Skills       []string                `json:"skills,omitempty"`
	Requires     FeatureRequirements     `json:"requires,omitempty"`
	Instructions ProfileInstructionsSpec `json:"instructions,omitempty"`
}

type ProfileInstallResult struct {
	SkillResults      []SkillResult               `json:"skill_results,omitempty"`
	OK                bool                        `json:"ok"`
	Action            string                      `json:"action"`
	ProfileID         string                      `json:"profile_id"`
	InstalledFeatures []string                    `json:"installed_features"`
	InstalledSkills   []string                    `json:"installed_skills"`
	ProvisionedTools  []string                    `json:"provisioned_tools,omitempty"`
	Catalog           *TemplatesCatalogProvenance `json:"catalog,omitempty"`
}

type SkillInstallResult struct {
	Outcome          string                      `json:"outcome"`
	Skill            SkillResult                 `json:"skill"`
	AvailableCatalog *TemplatesCatalogProvenance `json:"available_catalog,omitempty"`
	OK               bool                        `json:"ok"`
	Action           string                      `json:"action"`
	SkillID          string                      `json:"skill_id"`
	Source           string                      `json:"source"`
	ProvisionedTools []string                    `json:"provisioned_tools,omitempty"`
	Catalog          *TemplatesCatalogProvenance `json:"catalog,omitempty"`
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

func isCatalogDirectory(dir string) bool {
	if dir == "" {
		return false
	}
	for _, sub := range []string{"features", "profiles", "skills"} {
		if info, err := os.Stat(filepath.Join(dir, sub)); err == nil && info.IsDir() {
			return true
		}
	}
	return false
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
		if strings.TrimSpace(config.TemplatesRef) == "" && strings.TrimSpace(os.Getenv("OPENLIA_TEMPLATES_REF")) == "" {
			if info, err := os.Stat(candidate); err == nil && info.IsDir() {
				return candidate
			}
		}
	}

	if config.MetaRoot != "" {
		cacheDir := filepath.Join(config.MetaRoot, "templates-cache")
		if isCatalogDirectory(cacheDir) {
			return cacheDir
		}
	}

	if config.RepositoryRoot != "" {
		if isCatalogDirectory(config.RepositoryRoot) {
			return config.RepositoryRoot
		}
	}

	return config.RepositoryRoot
}

func ensureTemplatesCatalogIfNeeded(config Config) error {
	if err := recoverTemplatesCatalog(config); err != nil {
		return err
	}
	root := ResolveTemplatesRoot(config)
	if isCatalogDirectory(root) {
		// An explicitly selected live directory is not an unidentified legacy
		// cache, even when a local fixture or mounted catalog uses that pathname.
		if strings.TrimSpace(config.TemplatesRef) == "" && strings.TrimSpace(os.Getenv("OPENLIA_TEMPLATES_REF")) == "" {
			for _, source := range []string{config.TemplatesRepo, os.Getenv("OPENLIA_TEMPLATES_REPO"), os.Getenv("OPENLIA_TEMPLATES_ROOT")} {
				if source != "" && filepath.Clean(source) == filepath.Clean(root) {
					return nil
				}
			}
		}
		if root != filepath.Join(config.MetaRoot, "templates-cache") {
			return nil
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
		if ref == "" {
			if stat, err := os.Stat(source); err == nil && stat.IsDir() {
				source, _ = filepath.Abs(source)
				ref = "worktree"
			} else {
				ref = DefaultTemplatesRef
			}
		}
		data, err := os.ReadFile(filepath.Join(root, catalogProvenanceFile))
		var info TemplatesCatalogProvenance
		if err == nil && json.Unmarshal(data, &info) == nil && info.Schema == 1 && info.Source == source && info.Ref == ref {
			return nil
		}
	}
	if config.MetaRoot == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	_, err := SyncTemplatesCatalog(ctx, config)
	return err
}

// ParseProfileManifest parses a profiles/<id>/profile.yaml manifest.
func ParseProfileManifest(data []byte) (TemplateProfileManifest, error) {
	m := TemplateProfileManifest{Schema: 1}
	if err := decodeTypedTemplateYAML(data, &m); err != nil {
		return TemplateProfileManifest{}, err
	}
	if err := ValidateFeatureID(m.ID); err != nil {
		return TemplateProfileManifest{}, fmt.Errorf("invalid profile id %q: %w", m.ID, err)
	}
	if _, err := parseOpenLiaRequirement(data); err != nil {
		return TemplateProfileManifest{}, err
	}
	if m.Schema != 1 {
		return TemplateProfileManifest{}, fmt.Errorf("profile manifest schema must be 1")
	}
	if err := validateEnvironmentManifestPaths(m.Requires); err != nil {
		return TemplateProfileManifest{}, err
	}
	for _, path := range []string{m.Instructions.Soul, m.Instructions.ProfileAgents, m.Instructions.WorkspaceAgents} {
		clean := filepath.Clean(filepath.FromSlash(path))
		if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return TemplateProfileManifest{}, fmt.Errorf("profile instruction path must remain inside its package: %q", path)
		}
	}
	return m, nil
}

// InstallTemplateProfile installs all features, skills, required tools, and starter instructions
// declared in profiles/<profileID>/profile.yaml from the templates catalog.
func InstallTemplateProfile(config Config, profileID string, approvePolicy bool, now time.Time) (ProfileInstallResult, error) {
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return ProfileInstallResult{}, err
	}
	if err := ValidateFeatureID(profileID); err != nil {
		return ProfileInstallResult{}, fmt.Errorf("invalid profile id %q: %w", profileID, err)
	}

	if err := ensureTemplatesCatalogIfNeeded(config); err != nil {
		return ProfileInstallResult{}, err
	}
	unlock, err := lockTemplatesCatalogForRead(config)
	if err != nil {
		return ProfileInstallResult{}, err
	}
	defer unlock()
	templatesRoot := ResolveTemplatesRoot(config)
	profileDir := filepath.Join(templatesRoot, "profiles", profileID)
	manifestBytes, err := os.ReadFile(filepath.Join(profileDir, "profile.yaml"))
	if err != nil {
		return ProfileInstallResult{}, fmt.Errorf("profile not found in templates catalog: %s", profileID)
	}

	manifest, err := ParseProfileManifest(manifestBytes)
	if err != nil {
		return ProfileInstallResult{}, err
	}

	var installedFeatures []string
	var skillResults []SkillResult
	if err := newTemplatePreflight(config).profile(manifest); err != nil {
		return ProfileInstallResult{}, err
	}
	skillSet := make(map[string]bool)
	var installedSkills []string
	toolSet := make(map[string]bool)
	var provisionedTools []string

	addSkill := func(id string) {
		if !skillSet[id] {
			skillSet[id] = true
			installedSkills = append(installedSkills, id)
		}
	}
	addTool := func(t string) {
		if !toolSet[t] {
			toolSet[t] = true
			provisionedTools = append(provisionedTools, t)
		}
	}

	for _, featID := range manifest.Features {
		res, err := FeatureInstall(config, featID, approvePolicy, now)
		if err != nil {
			return ProfileInstallResult{}, fmt.Errorf("install profile feature %s: %w", featID, err)
		}
		installedFeatures = append(installedFeatures, res.FeatureID)
		skillResults = append(skillResults, res.SkillResults...)
		for _, sk := range res.InstalledSkills {
			addSkill(sk)
		}
		for _, tl := range res.ProvisionedTools {
			addTool(tl)
		}
	}

	for _, skillID := range manifest.Skills {
		res, err := SkillInstall(config, skillID, now)
		if err != nil {
			return ProfileInstallResult{}, fmt.Errorf("install profile skill %s: %w", skillID, err)
		}
		skillResults = append(skillResults, res.Skill)
		if res.Skill.ResultState == "managed" {
			addSkill(res.SkillID)
		}
		for _, tl := range res.ProvisionedTools {
			addTool(tl)
		}
	}

	if len(manifest.Requires.Tools) > 0 {
		tools, err := ProvisionRequiredTools(config, manifest.Requires.Tools, "profile:"+manifest.ID)
		if err != nil {
			return ProfileInstallResult{}, fmt.Errorf("provision profile tools for %s: %w", manifest.ID, err)
		}
		for _, tl := range tools {
			addTool(tl)
		}
	}

	// Seed profile instruction files if present and target does not exist yet
	prof := NewProfileOperator(config)
	if !now.IsZero() {
		prof.Now = func() time.Time { return now.UTC() }
	}
	managedRoot := filepath.Join(config.MetaRoot, "managed")
	_ = EnsureDir(managedRoot, 0o700)
	if manifest.Instructions.Soul != "" {
		soulSrc := filepath.Join(profileDir, filepath.FromSlash(manifest.Instructions.Soul))
		if info, err := os.Stat(soulSrc); err == nil && info.Mode().IsRegular() {
			_ = prof.syncSoul(soulSrc, filepath.Join(config.DataRoot, "SOUL.md"), filepath.Join(managedRoot, "SOUL.md.sha256"), 0o600)
		}
	}
	if manifest.Instructions.ProfileAgents != "" {
		agentsSrc := filepath.Join(profileDir, filepath.FromSlash(manifest.Instructions.ProfileAgents))
		if info, err := os.Stat(agentsSrc); err == nil && info.Mode().IsRegular() {
			_ = copyOnce(agentsSrc, filepath.Join(config.DataRoot, "AGENTS.md"), 0o600)
		}
	}
	if manifest.Instructions.WorkspaceAgents != "" {
		wsAgentsSrc := filepath.Join(profileDir, filepath.FromSlash(manifest.Instructions.WorkspaceAgents))
		if info, err := os.Stat(wsAgentsSrc); err == nil && info.Mode().IsRegular() {
			wsDir := featureWorkspaceDir(config)
			_ = EnsureDir(wsDir, 0o700)
			_ = copyOnce(wsAgentsSrc, filepath.Join(wsDir, "AGENTS.md"), 0o600)
		}
	}

	_ = RecordChange(config, "profile-install", "ok", manifest.ID, fmt.Sprintf("installed template profile %s", manifest.ID), now)
	return ProfileInstallResult{
		SkillResults:      skillResults,
		OK:                true,
		Action:            "profile-install",
		ProfileID:         manifest.ID,
		Catalog:           currentTemplatesProvenance(config),
		InstalledFeatures: installedFeatures,
		InstalledSkills:   installedSkills,
		ProvisionedTools:  provisionedTools,
	}, nil
}

// SkillInstall installs a standalone or feature-bundled skill from the templates catalog
// into <DataRoot>/skills/<skillID>, records its base snapshot, and provisions its dependencies.
func SkillInstall(config Config, skillID string, now time.Time) (SkillInstallResult, error) {
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return SkillInstallResult{}, err
	}
	if err := ValidateSafeComponent(skillID, "skill"); err != nil {
		return SkillInstallResult{}, err
	}

	if err := ensureTemplatesCatalogIfNeeded(config); err != nil {
		return SkillInstallResult{}, err
	}
	unlock, err := lockTemplatesCatalogForRead(config)
	if err != nil {
		return SkillInstallResult{}, err
	}
	defer unlock()
	catalogSkills, err := LoadCatalogSkills(config)
	if err != nil {
		return SkillInstallResult{}, err
	}
	srcSkillDir, ok := catalogSkills[skillID]
	if !ok {
		return SkillInstallResult{}, fmt.Errorf("skill %s not found in templates catalog", skillID)
	}
	if err := newTemplatePreflight(config).catalogSkill(srcSkillDir); err != nil {
		return SkillInstallResult{}, err
	}

	skillsRoot := filepath.Join(config.DataRoot, "skills")
	managedSkillsRoot := filepath.Join(config.MetaRoot, "managed", "skills")
	if err := EnsureDir(skillsRoot, 0o700); err != nil {
		return SkillInstallResult{}, err
	}
	if err := EnsureDir(managedSkillsRoot, 0o700); err != nil {
		return SkillInstallResult{}, err
	}

	disabledDir := filepath.Join(skillsRoot, ".openlia-disabled", skillID)
	if _, err := os.Lstat(disabledDir); err == nil {
		_ = os.RemoveAll(disabledDir)
	}

	prof := NewProfileOperator(config)
	if !now.IsZero() {
		prof.Now = func() time.Time { return now.UTC() }
	}
	distVer, distSource := prof.distributionInfo()
	dstSkillDir := filepath.Join(skillsRoot, skillID)
	metaPath := filepath.Join(managedSkillsRoot, skillID+".json")
	skillResult, err := prof.syncSkill(srcSkillDir, dstSkillDir, metaPath, skillID, distVer, distSource)
	if err != nil {
		return SkillInstallResult{}, fmt.Errorf("install skill %s: %w", skillID, err)
	}
	if err := recordSkillCatalog(config, metaPath, skillID, srcSkillDir, skillResult); err != nil {
		return SkillInstallResult{}, err
	}
	if skillResult.ResultState == "managed" {
		if err := ProvisionSkillEnvironment(config, skillID, dstSkillDir, "", ""); err != nil {
			return SkillInstallResult{}, fmt.Errorf("provision skill environment for %s: %w", skillID, err)
		}
	}
	var installedCatalog *TemplatesCatalogProvenance
	if metadata, err := readFullSkillMetadata(metaPath, skillID); err == nil {
		installedCatalog = metadata.Catalog
	}
	skTools, _, _ := ParseSkillRequirements(dstSkillDir)

	if config.RuntimeUID > 0 && config.RuntimeGID > 0 && os.Geteuid() == 0 {
		_ = ensureRuntimeTreeOwner(skillsRoot, config.RuntimeUID, config.RuntimeGID)
		_ = ensureRuntimeTreeOwner(config.MetaRoot, config.RuntimeUID, config.RuntimeGID)
	}

	_ = RecordChange(config, "skill-install", "ok", skillID, fmt.Sprintf("installed skill %s", skillID), now)
	return SkillInstallResult{
		Outcome:          skillResult.Action,
		Skill:            skillResult,
		AvailableCatalog: catalogProvenanceForPath(config, srcSkillDir),
		OK:               true,
		Action:           "skill-install",
		SkillID:          skillID,
		Source:           "catalog",
		Catalog:          installedCatalog,
		ProvisionedTools: skTools,
	}, nil
}

// SyncTemplatesCatalog clones or updates the templates catalog in <MetaRoot>/templates-cache.
func SyncTemplatesCatalog(ctx context.Context, config Config) (TemplatesSyncResult, error) {
	return syncTemplatesCatalog(ctx, config)
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
	if err := ensureTemplatesCatalogIfNeeded(config); err != nil {
		return RebaseResult{}, err
	}
	unlock, err := lockTemplatesCatalogForRead(config)
	if err != nil {
		return RebaseResult{}, err
	}
	defer unlock()
	catalogSkills, err := LoadCatalogSkills(config)
	if err != nil {
		return RebaseResult{}, err
	}
	newBaseDir, ok := catalogSkills[skillID]
	if !ok {
		return RebaseResult{}, fmt.Errorf("skill %s not found in templates catalog", skillID)
	}
	if err := newTemplatePreflight(config).catalogSkill(newBaseDir); err != nil {
		return RebaseResult{}, err
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
	meta.Catalog = catalogProvenanceForPath(config, newBaseDir)
	if meta.Catalog != nil {
		rel, _ := filepath.Rel(ResolveTemplatesRoot(config), newBaseDir)
		meta.CatalogArtifactPath = filepath.ToSlash(rel)
	}
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

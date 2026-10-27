package operator

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"openlia/internal/toolcatalog"
	"openlia/operator/migration/intake"
	"openlia/operator/migration/security"
)

var featureIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// LeanBaseCoreDomains are the core roots in the minimal OpenLia workspace.
var LeanBaseCoreDomains = []string{
	"inbox",
	"sources",
}

// LeanBaseAllDirs are the default directories created on a fresh bootstrap.
var LeanBaseAllDirs = []string{
	"inbox",
	"inbox/ingestion",
	"sources",
	"sources/artifacts",
	"sources/records",
}

type FeatureRequirements struct {
	CoreDomains []string `json:"core_domains,omitempty"`
	Features    []string `json:"features,omitempty"`
	Tools       []string `json:"tools,omitempty"`
	Python      string   `json:"python,omitempty"`
	Bun         string   `json:"bun,omitempty"`
}

type WorkspaceDomain struct {
	Path              string   `json:"path"`
	Kind              string   `json:"kind"`
	Label             string   `json:"label"`
	Purpose           string   `json:"purpose"`
	Lifecycle         string   `json:"lifecycle,omitempty"`
	Route             string   `json:"route,omitempty"`
	Tags              []string `json:"tags,omitempty"`
	Template          string   `json:"template,omitempty"`
	IncludeInBriefing bool     `json:"include_in_briefing,omitempty"`
	BriefingCategory  string   `json:"briefing_category,omitempty"`
	Skills            []string `json:"skills,omitempty"`
	Feature           string   `json:"feature,omitempty"`
}

type FeatureSkillSpec struct {
	ID               string   `json:"id"`
	Path             string   `json:"path"`
	WorkspaceDomains []string `json:"workspace_domains,omitempty"`
}

type FeaturePolicySpec struct {
	AllowedDomains []string `json:"allowed_domains,omitempty"`
	AllowedActions []string `json:"allowed_actions,omitempty"`
}

type FeatureManifest struct {
	Schema      int                 `json:"schema"`
	ID          string              `json:"id"`
	Name        string              `json:"name"`
	Version     string              `json:"version"`
	Description string              `json:"description"`
	Author      string              `json:"author,omitempty"`
	License     string              `json:"license,omitempty"`
	Requires    FeatureRequirements `json:"requires,omitempty"`
	Domains     []WorkspaceDomain   `json:"domains"`
	Skills      []FeatureSkillSpec  `json:"skills,omitempty"`
	Policy      FeaturePolicySpec   `json:"policy,omitempty"`
}

type InstalledFeatureRecord struct {
	Schema      int             `json:"schema"`
	ID          string          `json:"id"`
	Source      string          `json:"source"` // "builtin" or "imported"
	InstalledAt string          `json:"installed_at"`
	UpdatedAt   string          `json:"updated_at"`
	Manifest    FeatureManifest `json:"manifest"`
}

type FeatureStatus struct {
	ID          string              `json:"id"`
	Name        string              `json:"name"`
	Version     string              `json:"version"`
	Description string              `json:"description"`
	Author      string              `json:"author,omitempty"`
	License     string              `json:"license,omitempty"`
	Source      string              `json:"source"`
	State       string              `json:"state"` // "installed", "partial", "available"
	Domains     []string            `json:"domains"`
	Skills      []string            `json:"skills"`
	Requires    FeatureRequirements `json:"requires,omitempty"`
	Policy      FeaturePolicySpec   `json:"policy,omitempty"`
	InstalledAt string              `json:"installed_at,omitempty"`
}

type FeatureListResult struct {
	OK       bool            `json:"ok"`
	Action   string          `json:"action"`
	Features []FeatureStatus `json:"features"`
}

type FeatureShowResult struct {
	OK       bool            `json:"ok"`
	Action   string          `json:"action"`
	Status   FeatureStatus   `json:"status"`
	Manifest FeatureManifest `json:"manifest"`
}

type FeatureInstallResult struct {
	OK               bool     `json:"ok"`
	Action           string   `json:"action"`
	FeatureID        string   `json:"feature_id"`
	InstalledDomains []string `json:"installed_domains"`
	InstalledSkills  []string `json:"installed_skills"`
	ProvisionedTools []string `json:"provisioned_tools,omitempty"`
	PolicyUpdated    bool     `json:"policy_updated"`
}

type FeatureRemoveResult struct {
	OK             bool     `json:"ok"`
	Action         string   `json:"action"`
	FeatureID      string   `json:"feature_id"`
	RemovedDomains []string `json:"removed_domains"`
	DisabledSkills []string `json:"disabled_skills"`
}

type FeaturePackageOptions struct {
	FeatureID      string
	Name           string
	Version        string
	Description    string
	Author         string
	License        string
	Domains        []string
	Skills         []string
	OutputPath     string
	IncludeRecords bool
}

type FeaturePackageResult struct {
	OK         bool     `json:"ok"`
	Action     string   `json:"action"`
	FeatureID  string   `json:"feature_id"`
	OutputPath string   `json:"output_path"`
	Domains    []string `json:"domains"`
	Skills     []string `json:"skills"`
	FilesCount int      `json:"files_count"`
}

func ValidateFeatureID(id string) error {
	if !featureIDPattern.MatchString(id) {
		return fmt.Errorf("invalid feature id %q: must match ^[a-z0-9][a-z0-9-]*$", id)
	}
	return nil
}

// ParseFeatureManifest parses a feature.yaml manifest.
func ParseFeatureManifest(data []byte) (FeatureManifest, error) {
	var m FeatureManifest
	m.Schema = 1
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")

	section := ""
	subSection := ""
	var curDomain *WorkspaceDomain
	var curSkill *FeatureSkillSpec
	domainListField := ""
	skillListField := ""

	flushDomain := func() {
		if curDomain != nil {
			m.Domains = append(m.Domains, *curDomain)
			curDomain = nil
		}
		domainListField = ""
	}
	flushSkill := func() {
		if curSkill != nil {
			m.Skills = append(m.Skills, *curSkill)
			curSkill = nil
		}
		skillListField = ""
	}

	for _, rawLine := range lines {
		trimmed := strings.TrimSpace(rawLine)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(rawLine) - len(strings.TrimLeft(rawLine, " "))

		if indent == 0 {
			flushDomain()
			flushSkill()
			subSection = ""
			key, val, ok := splitYAMLKeyValue(trimmed)
			if !ok {
				continue
			}
			switch key {
			case "schema":
				if v, err := strconv.Atoi(val); err == nil {
					m.Schema = v
				}
				section = ""
			case "id":
				m.ID = unquoteYAMLScalar(val)
				section = ""
			case "name":
				m.Name = unquoteYAMLScalar(val)
				section = ""
			case "version":
				m.Version = unquoteYAMLScalar(val)
				section = ""
			case "description":
				m.Description = unquoteYAMLScalar(val)
				section = ""
			case "author":
				m.Author = unquoteYAMLScalar(val)
				section = ""
			case "license":
				m.License = unquoteYAMLScalar(val)
				section = ""
			case "requires", "domains", "skills", "policy":
				section = key
			default:
				section = ""
			}
			continue
		}

		switch section {
		case "requires":
			if indent == 2 && !strings.HasPrefix(trimmed, "- ") {
				key, val, ok := splitYAMLKeyValue(trimmed)
				if !ok {
					continue
				}
				subSection = key
				if val != "" {
					switch key {
					case "core_domains":
						m.Requires.CoreDomains = append(m.Requires.CoreDomains, parseInlineYAMLList(val)...)
					case "features":
						m.Requires.Features = append(m.Requires.Features, parseInlineYAMLList(val)...)
					case "tools":
						m.Requires.Tools = append(m.Requires.Tools, parseInlineYAMLList(val)...)
					case "python":
						m.Requires.Python = unquoteYAMLScalar(val)
					case "bun":
						m.Requires.Bun = unquoteYAMLScalar(val)
					}
				}
			} else if strings.HasPrefix(trimmed, "- ") {
				item := unquoteYAMLScalar(strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
				if item != "" {
					switch subSection {
					case "core_domains":
						m.Requires.CoreDomains = append(m.Requires.CoreDomains, item)
					case "features":
						m.Requires.Features = append(m.Requires.Features, item)
					case "tools":
						m.Requires.Tools = append(m.Requires.Tools, item)
					}
				}
			}

		case "domains":
			if indent == 2 && strings.HasPrefix(trimmed, "- ") {
				flushDomain()
				curDomain = &WorkspaceDomain{Kind: "extension"}
				rest := strings.TrimSpace(strings.TrimPrefix(trimmed, "- "))
				if key, val, ok := splitYAMLKeyValue(rest); ok {
					applyDomainField(curDomain, key, val, &domainListField)
				}
			} else if curDomain != nil && indent == 4 && !strings.HasPrefix(trimmed, "- ") {
				domainListField = ""
				if key, val, ok := splitYAMLKeyValue(trimmed); ok {
					applyDomainField(curDomain, key, val, &domainListField)
				}
			} else if curDomain != nil && indent >= 4 && strings.HasPrefix(trimmed, "- ") {
				item := unquoteYAMLScalar(strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
				if item != "" {
					switch domainListField {
					case "tags":
						curDomain.Tags = append(curDomain.Tags, item)
					case "skills":
						curDomain.Skills = append(curDomain.Skills, item)
					}
				}
			}

		case "skills":
			if indent == 2 && strings.HasPrefix(trimmed, "- ") {
				flushSkill()
				curSkill = &FeatureSkillSpec{}
				rest := strings.TrimSpace(strings.TrimPrefix(trimmed, "- "))
				if key, val, ok := splitYAMLKeyValue(rest); ok {
					applySkillField(curSkill, key, val, &skillListField)
				}
			} else if curSkill != nil && indent == 4 && !strings.HasPrefix(trimmed, "- ") {
				skillListField = ""
				if key, val, ok := splitYAMLKeyValue(trimmed); ok {
					applySkillField(curSkill, key, val, &skillListField)
				}
			} else if curSkill != nil && indent >= 4 && strings.HasPrefix(trimmed, "- ") {
				item := unquoteYAMLScalar(strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
				if item != "" && skillListField == "workspace_domains" {
					curSkill.WorkspaceDomains = append(curSkill.WorkspaceDomains, item)
				}
			}

		case "policy":
			if indent == 2 && !strings.HasPrefix(trimmed, "- ") {
				key, val, ok := splitYAMLKeyValue(trimmed)
				if !ok {
					continue
				}
				subSection = key
				if val != "" {
					items := parseInlineYAMLList(val)
					if key == "allowed_domains" {
						m.Policy.AllowedDomains = append(m.Policy.AllowedDomains, items...)
					} else if key == "allowed_actions" {
						m.Policy.AllowedActions = append(m.Policy.AllowedActions, items...)
					}
				}
			} else if strings.HasPrefix(trimmed, "- ") {
				item := unquoteYAMLScalar(strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
				if item != "" {
					if subSection == "allowed_domains" {
						m.Policy.AllowedDomains = append(m.Policy.AllowedDomains, item)
					} else if subSection == "allowed_actions" {
						m.Policy.AllowedActions = append(m.Policy.AllowedActions, item)
					}
				}
			}
		}
	}
	flushDomain()
	flushSkill()

	if err := ValidateFeatureManifest(m); err != nil {
		return FeatureManifest{}, err
	}
	return m, nil
}

func ValidateFeatureManifest(m FeatureManifest) error {
	if m.Schema != 1 {
		return fmt.Errorf("feature manifest schema must be 1, got %d", m.Schema)
	}
	if err := ValidateFeatureID(m.ID); err != nil {
		return err
	}
	if strings.TrimSpace(m.Name) == "" {
		return fmt.Errorf("feature %s name is required", m.ID)
	}
	if strings.TrimSpace(m.Version) == "" {
		return fmt.Errorf("feature %s version is required", m.ID)
	}
	if strings.TrimSpace(m.Description) == "" {
		return fmt.Errorf("feature %s description is required", m.ID)
	}
	for _, d := range m.Domains {
		if strings.TrimSpace(d.Path) == "" || strings.HasPrefix(d.Path, "/") || strings.Contains(d.Path, "..") {
			return fmt.Errorf("feature %s has invalid domain path %q", m.ID, d.Path)
		}
		if d.Kind == "" {
			d.Kind = "extension"
		}
		if d.Kind != "extension" {
			return fmt.Errorf("feature %s domain %s must have kind 'extension'", m.ID, d.Path)
		}
		if strings.TrimSpace(d.Label) == "" || strings.TrimSpace(d.Purpose) == "" || strings.TrimSpace(d.Lifecycle) == "" {
			return fmt.Errorf("feature %s domain %s requires label, purpose, and lifecycle", m.ID, d.Path)
		}
	}
	for _, s := range m.Skills {
		if err := ValidateSafeComponent(s.ID, "skill"); err != nil {
			return err
		}
		if strings.TrimSpace(s.Path) == "" || strings.HasPrefix(s.Path, "/") || strings.Contains(s.Path, "..") {
			return fmt.Errorf("feature %s skill %s has invalid path %q", m.ID, s.ID, s.Path)
		}
	}
	for _, tool := range m.Requires.Tools {
		if err := toolcatalog.ValidateToolName(tool); err != nil {
			return fmt.Errorf("feature %s: %w", m.ID, err)
		}
	}
	return nil
}

func RenderFeatureManifest(m FeatureManifest) []byte {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("schema: %d\n", m.Schema))
	b.WriteString(fmt.Sprintf("id: %s\n", formatYAMLScalar(m.ID)))
	b.WriteString(fmt.Sprintf("name: %s\n", formatYAMLScalar(m.Name)))
	b.WriteString(fmt.Sprintf("version: %s\n", formatYAMLScalar(m.Version)))
	b.WriteString(fmt.Sprintf("description: %s\n", formatYAMLScalar(m.Description)))
	if m.Author != "" {
		b.WriteString(fmt.Sprintf("author: %s\n", formatYAMLScalar(m.Author)))
	}
	if m.License != "" {
		b.WriteString(fmt.Sprintf("license: %s\n", formatYAMLScalar(m.License)))
	}
	b.WriteString("requires:\n")
	if len(m.Requires.CoreDomains) == 0 {
		b.WriteString("  core_domains: []\n")
	} else {
		b.WriteString("  core_domains:\n")
		for _, cd := range m.Requires.CoreDomains {
			b.WriteString(fmt.Sprintf("    - %s\n", formatYAMLScalar(cd)))
		}
	}
	if len(m.Requires.Features) == 0 {
		b.WriteString("  features: []\n")
	} else {
		b.WriteString("  features:\n")
		for _, f := range m.Requires.Features {
			b.WriteString(fmt.Sprintf("    - %s\n", formatYAMLScalar(f)))
		}
	}
	if len(m.Requires.Tools) > 0 {
		b.WriteString("  tools:\n")
		for _, t := range m.Requires.Tools {
			b.WriteString(fmt.Sprintf("    - %s\n", formatYAMLScalar(t)))
		}
	}
	if m.Requires.Python != "" {
		b.WriteString(fmt.Sprintf("  python: %s\n", formatYAMLScalar(m.Requires.Python)))
	}
	if m.Requires.Bun != "" {
		b.WriteString(fmt.Sprintf("  bun: %s\n", formatYAMLScalar(m.Requires.Bun)))
	}
	if len(m.Domains) == 0 {
		b.WriteString("domains: []\n")
	} else {
		b.WriteString("domains:\n")
		for _, d := range m.Domains {
			writeDomainYAML(&b, d)
		}
	}
	if len(m.Skills) == 0 {
		b.WriteString("skills: []\n")
	} else {
		b.WriteString("skills:\n")
		for _, s := range m.Skills {
			b.WriteString(fmt.Sprintf("  - id: %s\n", formatYAMLScalar(s.ID)))
			b.WriteString(fmt.Sprintf("    path: %s\n", formatYAMLScalar(s.Path)))
			if len(s.WorkspaceDomains) > 0 {
				b.WriteString("    workspace_domains:\n")
				for _, wd := range s.WorkspaceDomains {
					b.WriteString(fmt.Sprintf("      - %s\n", formatYAMLScalar(wd)))
				}
			}
		}
	}
	if len(m.Policy.AllowedDomains) > 0 || len(m.Policy.AllowedActions) > 0 {
		b.WriteString("policy:\n")
		if len(m.Policy.AllowedDomains) > 0 {
			b.WriteString("  allowed_domains:\n")
			for _, ad := range m.Policy.AllowedDomains {
				b.WriteString(fmt.Sprintf("    - %s\n", formatYAMLScalar(ad)))
			}
		}
		if len(m.Policy.AllowedActions) > 0 {
			b.WriteString("  allowed_actions:\n")
			for _, aa := range m.Policy.AllowedActions {
				b.WriteString(fmt.Sprintf("    - %s\n", formatYAMLScalar(aa)))
			}
		}
	}
	return []byte(b.String())
}

func writeDomainYAML(b *strings.Builder, d WorkspaceDomain) {
	b.WriteString(fmt.Sprintf("  - path: %s\n", formatYAMLScalar(d.Path)))
	b.WriteString(fmt.Sprintf("    kind: %s\n", formatYAMLScalar(d.Kind)))
	b.WriteString(fmt.Sprintf("    label: %s\n", formatYAMLScalar(d.Label)))
	b.WriteString(fmt.Sprintf("    purpose: %s\n", formatYAMLScalar(d.Purpose)))
	if d.Lifecycle != "" {
		b.WriteString(fmt.Sprintf("    lifecycle: %s\n", formatYAMLScalar(d.Lifecycle)))
	}
	if d.Route != "" {
		b.WriteString(fmt.Sprintf("    route: %s\n", formatYAMLScalar(d.Route)))
	}
	if len(d.Tags) > 0 {
		b.WriteString("    tags:\n")
		for _, tag := range d.Tags {
			b.WriteString(fmt.Sprintf("      - %s\n", formatYAMLScalar(tag)))
		}
	}
	if d.Template != "" {
		b.WriteString(fmt.Sprintf("    template: %s\n", formatYAMLScalar(d.Template)))
	}
	if d.IncludeInBriefing {
		b.WriteString("    include_in_briefing: true\n")
	}
	if d.BriefingCategory != "" {
		b.WriteString(fmt.Sprintf("    briefing_category: %s\n", formatYAMLScalar(d.BriefingCategory)))
	}
	if len(d.Skills) > 0 {
		b.WriteString("    skills:\n")
		for _, sk := range d.Skills {
			b.WriteString(fmt.Sprintf("      - %s\n", formatYAMLScalar(sk)))
		}
	}
	if d.Feature != "" {
		b.WriteString(fmt.Sprintf("    feature: %s\n", formatYAMLScalar(d.Feature)))
	}
}

func ParseWorkspaceDomains(data []byte) ([]WorkspaceDomain, error) {
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	var result []WorkspaceDomain
	inDomains := false
	var cur *WorkspaceDomain
	listField := ""

	flush := func() {
		if cur != nil && cur.Path != "" {
			result = append(result, *cur)
			cur = nil
		}
		listField = ""
	}

	for _, rawLine := range lines {
		trimmed := strings.TrimSpace(rawLine)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(rawLine) - len(strings.TrimLeft(rawLine, " "))
		if indent == 0 {
			flush()
			key, _, ok := splitYAMLKeyValue(trimmed)
			inDomains = ok && key == "domains"
			continue
		}
		if !inDomains {
			continue
		}
		if indent == 2 && strings.HasPrefix(trimmed, "- ") {
			flush()
			cur = &WorkspaceDomain{}
			rest := strings.TrimSpace(strings.TrimPrefix(trimmed, "- "))
			if key, val, ok := splitYAMLKeyValue(rest); ok {
				applyDomainField(cur, key, val, &listField)
			}
		} else if cur != nil && indent == 4 && !strings.HasPrefix(trimmed, "- ") {
			listField = ""
			if key, val, ok := splitYAMLKeyValue(trimmed); ok {
				applyDomainField(cur, key, val, &listField)
			}
		} else if cur != nil && indent >= 4 && strings.HasPrefix(trimmed, "- ") {
			item := unquoteYAMLScalar(strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
			if item != "" {
				switch listField {
				case "tags":
					cur.Tags = append(cur.Tags, item)
				case "skills":
					cur.Skills = append(cur.Skills, item)
				}
			}
		}
	}
	flush()
	return result, nil
}

func RenderWorkspaceRegistry(domains []WorkspaceDomain) []byte {
	var b strings.Builder
	b.WriteString("$schema: ./workspace.schema.json\n")
	b.WriteString("version: 1\n\n")
	b.WriteString("# This registry is user-owned. The agent designs semantic extensions; the user\n")
	b.WriteString("# approves their scoped purpose, path, lifecycle, and template/schema plan.\n")
	b.WriteString("domains:\n")
	for _, d := range domains {
		writeDomainYAML(&b, d)
	}
	return []byte(b.String())
}

func RegisteredDomainPaths(workspaceDir string) (map[string]bool, error) {
	info, err := os.Stat(workspaceDir)
	if errors.Is(err, os.ErrNotExist) || (err == nil && !info.IsDir()) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool)

	// Include any LeanBaseAllDirs that exist in workspaceDir
	for _, dirRel := range LeanBaseAllDirs {
		if dirRel == "sources/artifacts" || dirRel == "sources/records" {
			continue
		}
		if st, statErr := os.Stat(filepath.Join(workspaceDir, filepath.FromSlash(dirRel))); statErr == nil && st.IsDir() {
			out[dirRel] = true
		}
	}

	// Discover directories containing templates, schemas, or project manifests
	_ = filepath.WalkDir(workspaceDir, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.IsDir() {
			if p != workspaceDir && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if strings.HasSuffix(name, "-template.md") || strings.HasSuffix(name, ".schema.json") || name == "project-manifest.toml" {
			relDir, relErr := filepath.Rel(workspaceDir, filepath.Dir(p))
			if relErr == nil && relDir != "." {
				relSlash := filepath.ToSlash(relDir)
				if relSlash == "sources/records" {
					relSlash = "sources"
				}
				out[relSlash] = true
			}
		}
		return nil
	})

	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

func LoadCatalogFeaturesForConfig(config Config) ([]FeatureManifest, map[string]string, error) {
	return LoadCatalogFeatures(ResolveTemplatesRoot(config))
}

func LoadCatalogFeatures(repoRoot string) ([]FeatureManifest, map[string]string, error) {
	featuresDir := filepath.Join(repoRoot, "features")
	if info, err := os.Stat(featuresDir); err != nil || !info.IsDir() {
		for _, candidate := range []string{
			strings.TrimSpace(os.Getenv("OPENLIA_TEMPLATES_REPO")),
			strings.TrimSpace(os.Getenv("OPENLIA_TEMPLATES_ROOT")),
			filepath.Join(filepath.Dir(repoRoot), "openlia_templates"),
		} {
			if candidate == "" {
				continue
			}
			candFeatures := filepath.Join(candidate, "features")
			if cInfo, cErr := os.Stat(candFeatures); cErr == nil && cInfo.IsDir() {
				featuresDir = candFeatures
				break
			}
		}
	}
	entries, err := os.ReadDir(featuresDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, map[string]string{}, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read features catalog: %w", err)
	}
	var manifests []FeatureManifest
	paths := make(map[string]string)
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		dirPath := filepath.Join(featuresDir, entry.Name())
		manifestFile := filepath.Join(dirPath, "feature.yaml")
		data, err := os.ReadFile(manifestFile)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, nil, fmt.Errorf("read %s: %w", manifestFile, err)
		}
		manifest, err := ParseFeatureManifest(data)
		if err != nil {
			return nil, nil, fmt.Errorf("parse %s: %w", manifestFile, err)
		}
		manifests = append(manifests, manifest)
		paths[manifest.ID] = dirPath
	}
	sort.Slice(manifests, func(i, j int) bool {
		return manifests[i].ID < manifests[j].ID
	})
	return manifests, paths, nil
}

func loadInstalledFeatureRecords(metaRoot string) (map[string]InstalledFeatureRecord, error) {
	dir := filepath.Join(metaRoot, "managed", "features")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]InstalledFeatureRecord{}, nil
	}
	if err != nil {
		return nil, err
	}
	records := make(map[string]InstalledFeatureRecord)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var rec InstalledFeatureRecord
		if json.Unmarshal(data, &rec) == nil && rec.ID != "" {
			records[rec.ID] = rec
		}
	}
	return records, nil
}

func computeFeatureStatus(config Config, m FeatureManifest, source string, installedRec *InstalledFeatureRecord, registered map[string]bool) FeatureStatus {
	var domainPaths []string
	matchedDomains := 0
	for _, d := range m.Domains {
		domainPaths = append(domainPaths, d.Path)
		if registered != nil && registered[d.Path] {
			matchedDomains++
		}
	}
	var skillIDs []string
	matchedSkills := 0
	for _, s := range m.Skills {
		skillIDs = append(skillIDs, s.ID)
		skillDir := filepath.Join(config.DataRoot, "skills", s.ID)
		if info, err := os.Stat(skillDir); err == nil && info.IsDir() {
			matchedSkills++
		}
	}

	totalItems := len(domainPaths) + len(skillIDs)
	matchedItems := matchedDomains + matchedSkills
	state := "available"
	if totalItems > 0 && matchedItems == totalItems {
		state = "installed"
	} else if matchedItems > 0 {
		state = "partial"
	}

	installedAt := ""
	if installedRec != nil {
		installedAt = installedRec.InstalledAt
		if installedRec.Source != "" {
			source = installedRec.Source
		}
	}

	return FeatureStatus{
		ID:          m.ID,
		Name:        m.Name,
		Version:     m.Version,
		Description: m.Description,
		Author:      m.Author,
		License:     m.License,
		Source:      source,
		State:       state,
		Domains:     domainPaths,
		Skills:      skillIDs,
		Requires:    m.Requires,
		Policy:      m.Policy,
		InstalledAt: installedAt,
	}
}

func normalizeAndValidateFeatureConfig(config *Config) error {
	if err := ValidateAbsolutePath(config.RepositoryRoot, "repository-root"); err != nil {
		return err
	}
	if err := ValidateAbsolutePath(config.DataRoot, "data-root"); err != nil {
		return err
	}
	if config.MetaRoot == "" {
		config.MetaRoot = filepath.Join(config.DataRoot, ".openlia", "meta")
	}
	return nil
}

func featureWorkspaceDir(config Config) string {
	if wsRoot := os.Getenv("OPENLIA_WORKSPACE_ROOT"); wsRoot != "" {
		return wsRoot
	}
	return filepath.Join(config.DataRoot, "workspace")
}

func FeatureList(config Config) (FeatureListResult, error) {
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return FeatureListResult{}, err
	}
	catalog, _, err := LoadCatalogFeaturesForConfig(config)
	if err != nil {
		return FeatureListResult{}, err
	}
	installedRecords, err := loadInstalledFeatureRecords(config.MetaRoot)
	if err != nil {
		return FeatureListResult{}, err
	}
	workspaceDir := featureWorkspaceDir(config)
	registered, _ := RegisteredDomainPaths(workspaceDir)

	seen := make(map[string]bool)
	var statuses []FeatureStatus
	for _, m := range catalog {
		seen[m.ID] = true
		var rec *InstalledFeatureRecord
		if r, ok := installedRecords[m.ID]; ok {
			rec = &r
		}
		statuses = append(statuses, computeFeatureStatus(config, m, "builtin", rec, registered))
	}
	for id, rec := range installedRecords {
		if seen[id] {
			continue
		}
		statuses = append(statuses, computeFeatureStatus(config, rec.Manifest, rec.Source, &rec, registered))
	}
	sort.Slice(statuses, func(i, j int) bool {
		return statuses[i].ID < statuses[j].ID
	})
	return FeatureListResult{
		OK:       true,
		Action:   "features-list",
		Features: statuses,
	}, nil
}

func FeatureShow(config Config, featureID string) (FeatureShowResult, error) {
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return FeatureShowResult{}, err
	}
	if err := ValidateFeatureID(featureID); err != nil {
		return FeatureShowResult{}, err
	}
	manifest, _, source, rec, err := resolveFeatureManifest(config, featureID)
	if err != nil {
		return FeatureShowResult{}, err
	}
	workspaceDir := featureWorkspaceDir(config)
	registered, _ := RegisteredDomainPaths(workspaceDir)
	status := computeFeatureStatus(config, manifest, source, rec, registered)
	return FeatureShowResult{
		OK:       true,
		Action:   "features-show",
		Status:   status,
		Manifest: manifest,
	}, nil
}

func resolveFeatureManifest(config Config, featureID string) (FeatureManifest, string, string, *InstalledFeatureRecord, error) {
	ensureTemplatesCatalogIfNeeded(config)
	_, paths, err := LoadCatalogFeaturesForConfig(config)
	if err != nil {
		return FeatureManifest{}, "", "", nil, err
	}
	installedRecords, _ := loadInstalledFeatureRecords(config.MetaRoot)
	var rec *InstalledFeatureRecord
	if r, ok := installedRecords[featureID]; ok {
		rec = &r
	}
	if dirPath, ok := paths[featureID]; ok {
		data, err := os.ReadFile(filepath.Join(dirPath, "feature.yaml"))
		if err != nil {
			return FeatureManifest{}, "", "", nil, err
		}
		m, err := ParseFeatureManifest(data)
		if err != nil {
			return FeatureManifest{}, "", "", nil, err
		}
		return m, dirPath, "builtin", rec, nil
	}
	if rec != nil {
		pkgDir := filepath.Join(config.MetaRoot, "managed", "features", featureID, "package")
		return rec.Manifest, pkgDir, rec.Source, rec, nil
	}
	return FeatureManifest{}, "", "", nil, fmt.Errorf("feature not found: %s", featureID)
}

func FeatureInstall(config Config, featureID string, approvePolicy bool, now time.Time) (FeatureInstallResult, error) {
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return FeatureInstallResult{}, err
	}
	if err := ValidateFeatureID(featureID); err != nil {
		return FeatureInstallResult{}, err
	}
	manifest, pkgDir, source, existingRec, err := resolveFeatureManifest(config, featureID)
	if err != nil {
		return FeatureInstallResult{}, err
	}
	return installFeatureFromDir(config, manifest, pkgDir, source, existingRec, approvePolicy, now)
}

func installFeatureFromDir(config Config, manifest FeatureManifest, pkgDir string, source string, existingRec *InstalledFeatureRecord, approvePolicy bool, now time.Time) (FeatureInstallResult, error) {
	// Install required features first
	for _, reqFeat := range manifest.Requires.Features {
		if reqFeat == manifest.ID {
			continue
		}
		if _, err := FeatureInstall(config, reqFeat, approvePolicy, now); err != nil {
			return FeatureInstallResult{}, fmt.Errorf("install required feature %s: %w", reqFeat, err)
		}
	}

	workspaceDir := featureWorkspaceDir(config)
	if err := EnsureDir(workspaceDir, 0o700); err != nil {
		return FeatureInstallResult{}, err
	}

	// 1. Copy workspace templates/schemas from pkgDir/workspace
	featureWorkspaceDir := filepath.Join(pkgDir, "workspace")
	if info, err := os.Stat(featureWorkspaceDir); err == nil && info.IsDir() {
		if err := seedFeatureWorkspaceFiles(featureWorkspaceDir, workspaceDir); err != nil {
			return FeatureInstallResult{}, fmt.Errorf("seed feature workspace files: %w", err)
		}
	}

	// Ensure all domain directories exist
	var installedDomains []string
	for _, d := range manifest.Domains {
		if err := EnsureDir(filepath.Join(workspaceDir, filepath.FromSlash(d.Path)), 0o700); err != nil {
			return FeatureInstallResult{}, err
		}
		installedDomains = append(installedDomains, d.Path)
	}

	policyUpdated := false

	// 2. Install bundled skills into DataRoot/skills
	var installedSkills []string
	if len(manifest.Skills) > 0 {
		skillsRoot := filepath.Join(config.DataRoot, "skills")
		managedSkillsRoot := filepath.Join(config.MetaRoot, "managed", "skills")
		if err := EnsureDir(skillsRoot, 0o700); err != nil {
			return FeatureInstallResult{}, err
		}
		if err := EnsureDir(managedSkillsRoot, 0o700); err != nil {
			return FeatureInstallResult{}, err
		}
		prof := NewProfileOperator(config)
		if !now.IsZero() {
			prof.Now = func() time.Time { return now.UTC() }
		}
		distVer, distSource := prof.distributionInfo()
		for _, sk := range manifest.Skills {
			srcSkillDir := filepath.Join(pkgDir, filepath.FromSlash(sk.Path))
			if info, err := os.Stat(srcSkillDir); err != nil || !info.IsDir() {
				return FeatureInstallResult{}, fmt.Errorf("feature %s skill directory missing: %s", manifest.ID, sk.Path)
			}
			dstSkillDir := filepath.Join(skillsRoot, sk.ID)
			disabledDir := filepath.Join(skillsRoot, ".openlia-disabled", sk.ID)
			if _, err := os.Lstat(disabledDir); err == nil {
				_ = os.RemoveAll(disabledDir)
			}
			metaPath := filepath.Join(managedSkillsRoot, sk.ID+".json")
			if _, err := prof.syncSkill(srcSkillDir, dstSkillDir, metaPath, sk.ID, distVer, distSource); err != nil {
				return FeatureInstallResult{}, fmt.Errorf("install feature skill %s: %w", sk.ID, err)
			}
			if err := ProvisionSkillEnvironment(config, sk.ID, dstSkillDir, manifest.Requires.Python, manifest.Requires.Bun); err != nil {
				return FeatureInstallResult{}, fmt.Errorf("provision skill environment for %s: %w", sk.ID, err)
			}
			installedSkills = append(installedSkills, sk.ID)
		}
	}

	// 3. Provision required system tools into /opt/data/.local
	var provisionedTools []string
	if len(manifest.Requires.Tools) > 0 {
		tools, err := ProvisionRequiredTools(config, manifest.Requires.Tools, "feature:"+manifest.ID)
		if err != nil {
			return FeatureInstallResult{}, fmt.Errorf("provision required tools for %s: %w", manifest.ID, err)
		}
		provisionedTools = tools
	}

	// 4. Snapshot base feature workspace files for 3-way rebase
	if info, err := os.Stat(featureWorkspaceDir); err == nil && info.IsDir() {
		baseWorkspaceSnap := filepath.Join(config.MetaRoot, "managed", "features", manifest.ID, "base")
		_ = replaceDirectory(featureWorkspaceDir, baseWorkspaceSnap)
	}

	// 5. Write feature provenance record
	featuresMetaDir := filepath.Join(config.MetaRoot, "managed", "features")
	if err := EnsureDir(featuresMetaDir, 0o700); err != nil {
		return FeatureInstallResult{}, err
	}
	stamp := utcTimestamp(now)
	installedAt := stamp
	if existingRec != nil && existingRec.InstalledAt != "" {
		installedAt = existingRec.InstalledAt
	}
	rec := InstalledFeatureRecord{
		Schema:      1,
		ID:          manifest.ID,
		Source:      source,
		InstalledAt: installedAt,
		UpdatedAt:   stamp,
		Manifest:    manifest,
	}
	recBytes, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return FeatureInstallResult{}, err
	}
	if err := AtomicWriteFile(filepath.Join(featuresMetaDir, manifest.ID+".json"), append(recBytes, '\n'), 0o600); err != nil {
		return FeatureInstallResult{}, err
	}
	if config.RuntimeUID > 0 && config.RuntimeGID > 0 && os.Geteuid() == 0 {
		_ = ensureRuntimeTreeOwner(workspaceDir, config.RuntimeUID, config.RuntimeGID)
		_ = ensureRuntimeTreeOwner(filepath.Join(config.DataRoot, "skills"), config.RuntimeUID, config.RuntimeGID)
		_ = ensureRuntimeTreeOwner(config.MetaRoot, config.RuntimeUID, config.RuntimeGID)
	}

	_ = RecordChange(config, "feature-install", "ok", manifest.ID, fmt.Sprintf("installed feature %s", manifest.ID), now)
	return FeatureInstallResult{
		OK:               true,
		Action:           "feature-install",
		FeatureID:        manifest.ID,
		InstalledDomains: installedDomains,
		InstalledSkills:  installedSkills,
		ProvisionedTools: provisionedTools,
		PolicyUpdated:    policyUpdated,
	}, nil
}

// FeatureImport imports a feature package from a .zip archive or directory.
func FeatureImport(config Config, archiveOrDirPath string, approvePolicy bool, now time.Time) (FeatureInstallResult, error) {
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return FeatureInstallResult{}, err
	}
	info, err := os.Lstat(archiveOrDirPath)
	if err != nil {
		return FeatureInstallResult{}, fmt.Errorf("inspect feature source: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return FeatureInstallResult{}, fmt.Errorf("feature import source must not be a symlink")
	}

	tmpDir, err := os.MkdirTemp("", "openlia-feature-import-*")
	if err != nil {
		return FeatureInstallResult{}, err
	}
	defer os.RemoveAll(tmpDir)

	if info.IsDir() {
		if err := copyAndValidateFeatureDir(archiveOrDirPath, tmpDir); err != nil {
			return FeatureInstallResult{}, err
		}
	} else {
		if err := extractAndValidateFeatureZip(archiveOrDirPath, tmpDir); err != nil {
			return FeatureInstallResult{}, err
		}
	}

	manifestBytes, err := os.ReadFile(filepath.Join(tmpDir, "feature.yaml"))
	if err != nil {
		return FeatureInstallResult{}, fmt.Errorf("imported feature package is missing feature.yaml")
	}
	manifest, err := ParseFeatureManifest(manifestBytes)
	if err != nil {
		return FeatureInstallResult{}, fmt.Errorf("invalid feature.yaml: %w", err)
	}

	// Persist imported package under MetaRoot/managed/features/<id>/package
	pkgStorageDir := filepath.Join(config.MetaRoot, "managed", "features", manifest.ID, "package")
	if err := replaceDirectory(tmpDir, pkgStorageDir); err != nil {
		return FeatureInstallResult{}, fmt.Errorf("store imported feature package: %w", err)
	}

	installedRecords, _ := loadInstalledFeatureRecords(config.MetaRoot)
	var existingRec *InstalledFeatureRecord
	if r, ok := installedRecords[manifest.ID]; ok {
		existingRec = &r
	}

	res, err := installFeatureFromDir(config, manifest, pkgStorageDir, "imported", existingRec, approvePolicy, now)
	if err != nil {
		return FeatureInstallResult{}, err
	}
	res.Action = "feature-import"
	return res, nil
}

// FeaturePackage packages selected domains and skills (or an existing feature) into a portable .zip archive.
func FeaturePackage(config Config, opts FeaturePackageOptions) (FeaturePackageResult, error) {
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return FeaturePackageResult{}, err
	}
	if err := ValidateFeatureID(opts.FeatureID); err != nil {
		return FeaturePackageResult{}, err
	}
	workspaceDir := featureWorkspaceDir(config)
	skillsRoot := filepath.Join(config.DataRoot, "skills")

	var allDomains []WorkspaceDomain
	if regBytes, err := os.ReadFile(filepath.Join(workspaceDir, "workspace.yaml")); err == nil {
		if parsed, parseErr := ParseWorkspaceDomains(regBytes); parseErr == nil {
			allDomains = append(allDomains, parsed...)
		}
	}
	if installedRecs, err := loadInstalledFeatureRecords(config.MetaRoot); err == nil {
		for _, rec := range installedRecs {
			allDomains = append(allDomains, rec.Manifest.Domains...)
		}
	}
	if catalog, _, err := LoadCatalogFeaturesForConfig(config); err == nil {
		for _, m := range catalog {
			allDomains = append(allDomains, m.Domains...)
		}
	}
	domainMap := make(map[string]WorkspaceDomain, len(allDomains))
	for _, d := range allDomains {
		if _, exists := domainMap[d.Path]; !exists {
			domainMap[d.Path] = d
		}
	}

	// If no explicit domains were passed, try resolving from an installed/catalog feature with opts.FeatureID
	selectedDomainPaths := opts.Domains
	selectedSkills := opts.Skills
	var baseManifest *FeatureManifest
	if len(selectedDomainPaths) == 0 && len(selectedSkills) == 0 {
		if m, _, _, _, err := resolveFeatureManifest(config, opts.FeatureID); err == nil {
			baseManifest = &m
			for _, d := range m.Domains {
				selectedDomainPaths = append(selectedDomainPaths, d.Path)
			}
			for _, s := range m.Skills {
				selectedSkills = append(selectedSkills, s.ID)
			}
		} else {
			for _, d := range allDomains {
				if d.Feature == opts.FeatureID {
					selectedDomainPaths = append(selectedDomainPaths, d.Path)
				}
			}
		}
	}
	if len(selectedDomainPaths) == 0 && len(selectedSkills) == 0 {
		return FeaturePackageResult{}, fmt.Errorf("feature package requires at least one domain (--domains) or skill (--skills)")
	}

	var packagedDomains []WorkspaceDomain
	skillSet := make(map[string]bool)
	for _, s := range selectedSkills {
		skillSet[s] = true
	}

	for _, dp := range selectedDomainPaths {
		dp = strings.Trim(filepath.ToSlash(dp), "/")
		d, ok := domainMap[dp]
		if !ok {
			d = WorkspaceDomain{
				Path:      dp,
				Kind:      "extension",
				Label:     filepath.Base(dp),
				Purpose:   fmt.Sprintf("Records for %s", dp),
				Lifecycle: "active -> archived",
				Feature:   opts.FeatureID,
			}
		} else {
			d.Kind = "extension"
			if d.Lifecycle == "" {
				d.Lifecycle = "active -> archived"
			}
			d.Feature = opts.FeatureID
		}
		for _, sk := range d.Skills {
			skillSet[sk] = true
		}
		packagedDomains = append(packagedDomains, d)
	}

	var finalSkillIDs []string
	for sk := range skillSet {
		finalSkillIDs = append(finalSkillIDs, sk)
	}
	sort.Strings(finalSkillIDs)

	var skillSpecs []FeatureSkillSpec
	for _, skID := range finalSkillIDs {
		if err := ValidateSafeComponent(skID, "skill"); err != nil {
			return FeaturePackageResult{}, err
		}
		var wsDomains []string
		for _, d := range packagedDomains {
			wsDomains = append(wsDomains, d.Path)
		}
		skillSpecs = append(skillSpecs, FeatureSkillSpec{
			ID:               skID,
			Path:             "skills/" + skID,
			WorkspaceDomains: wsDomains,
		})
	}

	name := opts.Name
	if name == "" && baseManifest != nil {
		name = baseManifest.Name
	}
	if name == "" {
		name = opts.FeatureID
	}
	version := opts.Version
	if version == "" && baseManifest != nil {
		version = baseManifest.Version
	}
	if version == "" {
		version = "0.1.0"
	}
	description := opts.Description
	if description == "" && baseManifest != nil {
		description = baseManifest.Description
	}
	if description == "" {
		description = fmt.Sprintf("Packaged OpenLia feature %s", opts.FeatureID)
	}

	var allowedRoots []string
	seenRoots := make(map[string]bool)
	for _, d := range packagedDomains {
		root := strings.Split(d.Path, "/")[0]
		if !seenRoots[root] {
			seenRoots[root] = true
			allowedRoots = append(allowedRoots, root)
		}
	}

	manifest := FeatureManifest{
		Schema:      1,
		ID:          opts.FeatureID,
		Name:        name,
		Version:     version,
		Description: description,
		Author:      opts.Author,
		License:     opts.License,
		Requires: FeatureRequirements{
			CoreDomains: []string{"inbox", "archive"},
		},
		Domains: packagedDomains,
		Skills:  skillSpecs,
		Policy: FeaturePolicySpec{
			AllowedDomains: allowedRoots,
		},
	}
	if baseManifest != nil && len(baseManifest.Policy.AllowedActions) > 0 {
		manifest.Policy.AllowedActions = baseManifest.Policy.AllowedActions
	}

	outputPath := opts.OutputPath
	if outputPath == "" {
		outputPath = filepath.Join(config.DataRoot, opts.FeatureID+"-feature.zip")
	}

	if err := EnsureDir(filepath.Dir(outputPath), 0o755); err != nil {
		return FeaturePackageResult{}, err
	}
	outFile, err := os.OpenFile(outputPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return FeaturePackageResult{}, err
	}
	defer outFile.Close()

	zw := zip.NewWriter(outFile)
	filesCount := 0

	// Write feature.yaml
	fw, err := zw.Create("feature.yaml")
	if err != nil {
		_ = zw.Close()
		return FeaturePackageResult{}, err
	}
	if _, err := fw.Write(RenderFeatureManifest(manifest)); err != nil {
		_ = zw.Close()
		return FeaturePackageResult{}, err
	}
	filesCount++

	// Write workspace domain templates & schemas
	addedZipPaths := map[string]bool{"feature.yaml": true}
	for _, d := range packagedDomains {
		domainFsDir := filepath.Join(workspaceDir, filepath.FromSlash(d.Path))
		entries, err := os.ReadDir(domainFsDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			fname := entry.Name()
			isTemplateOrSchema := strings.HasSuffix(fname, "-template.md") || strings.HasSuffix(fname, ".schema.json")
			if !isTemplateOrSchema && !opts.IncludeRecords {
				continue
			}
			if strings.HasPrefix(fname, ".") {
				continue
			}
			fullPath := filepath.Join(domainFsDir, fname)
			content, err := os.ReadFile(fullPath)
			if err != nil {
				continue
			}
			if intake.DetectSecretContent(d.Path+"/"+fname, content) {
				continue
			}
			zipRel := filepath.ToSlash(filepath.Join("workspace", d.Path, fname))
			if addedZipPaths[zipRel] {
				continue
			}
			addedZipPaths[zipRel] = true
			w, err := zw.Create(zipRel)
			if err != nil {
				_ = zw.Close()
				return FeaturePackageResult{}, err
			}
			if _, err := w.Write(content); err != nil {
				_ = zw.Close()
				return FeaturePackageResult{}, err
			}
			filesCount++
		}
	}

	// Write skills
	for _, skID := range finalSkillIDs {
		skDir := filepath.Join(skillsRoot, skID)
		if info, err := os.Stat(skDir); err != nil || !info.IsDir() {
			// Fallback to catalog skill dir if packaging a builtin feature
			if baseManifest != nil {
				if _, catalogPaths, err := LoadCatalogFeatures(config.RepositoryRoot); err == nil {
					if catDir, ok := catalogPaths[opts.FeatureID]; ok {
						skDir = filepath.Join(catDir, "skills", skID)
					}
				}
			}
		}
		if info, err := os.Stat(skDir); err == nil && info.IsDir() {
			err := filepath.WalkDir(skDir, func(p string, d fs.DirEntry, walkErr error) error {
				if walkErr != nil {
					return walkErr
				}
				if d.IsDir() {
					if strings.HasPrefix(d.Name(), ".") || d.Name() == "__pycache__" {
						return filepath.SkipDir
					}
					return nil
				}
				if d.Type()&os.ModeSymlink != 0 || strings.HasPrefix(d.Name(), ".") {
					return nil
				}
				rel, err := filepath.Rel(skDir, p)
				if err != nil {
					return err
				}
				content, err := os.ReadFile(p)
				if err != nil {
					return err
				}
				zipRel := filepath.ToSlash(filepath.Join("skills", skID, rel))
				if addedZipPaths[zipRel] {
					return nil
				}
				addedZipPaths[zipRel] = true
				w, err := zw.Create(zipRel)
				if err != nil {
					return err
				}
				if _, err := w.Write(content); err != nil {
					return err
				}
				filesCount++
				return nil
			})
			if err != nil {
				_ = zw.Close()
				return FeaturePackageResult{}, err
			}
		}
	}

	if err := zw.Close(); err != nil {
		return FeaturePackageResult{}, err
	}

	var domainNames []string
	for _, d := range packagedDomains {
		domainNames = append(domainNames, d.Path)
	}
	return FeaturePackageResult{
		OK:         true,
		Action:     "feature-package",
		FeatureID:  opts.FeatureID,
		OutputPath: outputPath,
		Domains:    domainNames,
		Skills:     finalSkillIDs,
		FilesCount: filesCount,
	}, nil
}

// FeatureRemove removes an installed feature's domain registrations and disables its skills,
// without deleting any user records.
func FeatureRemove(config Config, featureID string, now time.Time) (FeatureRemoveResult, error) {
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return FeatureRemoveResult{}, err
	}
	if err := ValidateFeatureID(featureID); err != nil {
		return FeatureRemoveResult{}, err
	}
	manifest, _, _, _, err := resolveFeatureManifest(config, featureID)
	if err != nil {
		return FeatureRemoveResult{}, err
	}

	workspaceDir := featureWorkspaceDir(config)
	var removedDomains []string
	for _, d := range manifest.Domains {
		removedDomains = append(removedDomains, d.Path)
	}

	// 1. Remove starter templates/schemas while preserving any user records
	for i := len(manifest.Domains) - 1; i >= 0; i-- {
		d := manifest.Domains[i]
		domainDir := filepath.Join(workspaceDir, filepath.FromSlash(d.Path))
		cleanEmptyTemplateDomainDir(domainDir)
	}

	// 4. Disable skills
	var disabledSkills []string
	skillsRoot := filepath.Join(config.DataRoot, "skills")
	for _, sk := range manifest.Skills {
		src := filepath.Join(skillsRoot, sk.ID)
		dst := filepath.Join(skillsRoot, ".openlia-disabled", sk.ID)
		if info, err := os.Lstat(src); err == nil && info.IsDir() {
			_ = EnsureDir(filepath.Dir(dst), 0o700)
			_ = os.RemoveAll(dst)
			if err := os.Rename(src, dst); err == nil {
				disabledSkills = append(disabledSkills, sk.ID)
			}
		}
	}

	// 5. Remove managed feature record
	_ = os.Remove(filepath.Join(config.MetaRoot, "managed", "features", featureID+".json"))
	_ = RecordChange(config, "feature-remove", "ok", featureID, fmt.Sprintf("removed feature %s", featureID), now)

	return FeatureRemoveResult{
		OK:             true,
		Action:         "feature-remove",
		FeatureID:      featureID,
		RemovedDomains: removedDomains,
		DisabledSkills: disabledSkills,
	}, nil
}

// DetectFeaturesForPaths returns the sorted built-in feature IDs whose domains contain any of the given workspace-relative paths.
func DetectFeaturesForPaths(repoRoot string, relPaths []string) ([]string, error) {
	catalog, _, err := LoadCatalogFeatures(repoRoot)
	if err != nil {
		return nil, err
	}
	matched := make(map[string]bool)
	for _, rawPath := range relPaths {
		clean := strings.Trim(filepath.ToSlash(rawPath), "/")
		if clean == "" {
			continue
		}
		for _, m := range catalog {
			for _, d := range m.Domains {
				if clean == d.Path || strings.HasPrefix(clean, d.Path+"/") {
					matched[m.ID] = true
				}
			}
		}
	}
	var ids []string
	for id := range matched {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}

// SeedAllFeatureTemplatesIntoDir copies all built-in feature workspace templates & schemas into targetWorkspaceDir
// using non-destructive copyOnce. Used by InitMigrationV2 so the proposal repo has all domain templates available.
func SeedAllFeatureTemplatesIntoDir(repoRoot, targetWorkspaceDir string) error {
	_, paths, err := LoadCatalogFeatures(repoRoot)
	if err != nil {
		return err
	}
	for _, pkgDir := range paths {
		wsDir := filepath.Join(pkgDir, "workspace")
		if info, err := os.Stat(wsDir); err == nil && info.IsDir() {
			if err := seedFeatureWorkspaceFiles(wsDir, targetWorkspaceDir); err != nil {
				return err
			}
		}
	}
	return nil
}

// MergeCatalogSkillsIntoDir copies both installed skills (from liveSkillsDir) and all built-in feature skills
// (from repoRoot/features/*/skills/*) into destSkillsDir so the migration worker has all vertical skills available.
func MergeCatalogSkillsIntoDir(repoRoot, liveSkillsDir, destSkillsDir string) error {
	if err := EnsureDir(destSkillsDir, 0o700); err != nil {
		return err
	}
	if info, err := os.Stat(liveSkillsDir); err == nil && info.IsDir() {
		entries, err := os.ReadDir(liveSkillsDir)
		if err == nil {
			for _, entry := range entries {
				if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
					continue
				}
				_ = CopyDir(filepath.Join(liveSkillsDir, entry.Name()), filepath.Join(destSkillsDir, entry.Name()))
			}
		}
	}
	_, paths, err := LoadCatalogFeatures(repoRoot)
	if err != nil {
		return err
	}
	for _, pkgDir := range paths {
		skRoot := filepath.Join(pkgDir, "skills")
		entries, err := os.ReadDir(skRoot)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			dst := filepath.Join(destSkillsDir, entry.Name())
			if _, err := os.Stat(dst); errors.Is(err, os.ErrNotExist) {
				if err := CopyDir(filepath.Join(skRoot, entry.Name()), dst); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func seedFeatureWorkspaceFiles(featureWorkspaceDir, workspaceDir string) error {
	return filepath.Walk(featureWorkspaceDir, func(path string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(featureWorkspaceDir, path)
		if err != nil {
			return err
		}
		if filepath.Base(rel) == ".gitkeep" {
			return EnsureDir(filepath.Join(workspaceDir, filepath.Dir(rel)), 0o700)
		}
		dest := filepath.Join(workspaceDir, rel)
		if err := EnsureDir(filepath.Dir(dest), 0o700); err != nil {
			return err
		}
		return copyOnce(path, dest, 0o600)
	})
}

func mergeFeatureDomainsIntoRegistry(workspaceDir string, newDomains []WorkspaceDomain) error {
	regPath := filepath.Join(workspaceDir, "workspace.yaml")
	var existing []WorkspaceDomain
	if data, err := os.ReadFile(regPath); err == nil {
		existing, _ = ParseWorkspaceDomains(data)
	}
	seen := make(map[string]int, len(existing))
	for i, d := range existing {
		seen[d.Path] = i
	}
	changed := false
	for _, nd := range newDomains {
		if idx, ok := seen[nd.Path]; ok {
			if existing[idx].Feature == "" && nd.Feature != "" {
				existing[idx].Feature = nd.Feature
				changed = true
			}
			if len(existing[idx].Skills) == 0 && len(nd.Skills) > 0 {
				existing[idx].Skills = nd.Skills
				changed = true
			}
			continue
		}
		existing = append(existing, nd)
		seen[nd.Path] = len(existing) - 1
		changed = true
	}
	if !changed && len(existing) > 0 {
		return nil
	}
	return AtomicWriteFile(regPath, RenderWorkspaceRegistry(existing), 0o600)
}

func mergeFeaturePolicy(workspaceDir string, policySpec FeaturePolicySpec) (bool, error) {
	policyFile := filepath.Join(workspaceDir, "assistant-policy.yaml")
	data, err := os.ReadFile(policyFile)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	updated, changed := insertPolicyItems(string(data), policySpec.AllowedDomains, policySpec.AllowedActions)
	if !changed {
		return false, nil
	}
	if err := AtomicWriteFile(policyFile, []byte(updated), 0o600); err != nil {
		return false, err
	}
	return true, nil
}

func insertPolicyItems(content string, addDomains []string, addActions []string) (string, bool) {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	changed := false

	if len(addDomains) > 0 {
		var c bool
		lines, c = appendYAMLBlockListItems(lines, "delegation", "workspace", "allowed_domains", addDomains)
		if c {
			changed = true
		}
	}
	if len(addActions) > 0 {
		var c bool
		lines, c = appendYAMLBlockListItems(lines, "delegation", "workspace", "allowed_actions", addActions)
		if c {
			changed = true
		}
	}
	return strings.Join(lines, "\n"), changed
}

func appendYAMLBlockListItems(lines []string, l0, l1, listKey string, itemsToAdd []string) ([]string, bool) {
	inL0 := false
	inL1 := false
	inList := false
	lastItemIdx := -1
	listHeaderIdx := -1
	existing := make(map[string]bool)

	for i, rawLine := range lines {
		trimmed := strings.TrimSpace(rawLine)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(rawLine) - len(strings.TrimLeft(rawLine, " "))
		if indent == 0 {
			if inList {
				break
			}
			k, _, _ := splitYAMLKeyValue(trimmed)
			inL0 = (k == l0)
			inL1 = false
			continue
		}
		if !inL0 {
			continue
		}
		if indent == 2 {
			if inList {
				break
			}
			k, _, _ := splitYAMLKeyValue(trimmed)
			inL1 = (k == l1)
			continue
		}
		if !inL1 {
			continue
		}
		if indent == 4 && !strings.HasPrefix(trimmed, "- ") {
			if inList {
				break
			}
			k, _, _ := splitYAMLKeyValue(trimmed)
			if k == listKey {
				inList = true
				listHeaderIdx = i
			}
			continue
		}
		if inList && indent >= 6 && strings.HasPrefix(trimmed, "- ") {
			val := unquoteYAMLScalar(strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
			existing[val] = true
			lastItemIdx = i
		}
	}

	if listHeaderIdx < 0 {
		return lines, false
	}
	insertAt := lastItemIdx
	if insertAt < 0 {
		insertAt = listHeaderIdx
	}

	var newLines []string
	for _, item := range itemsToAdd {
		if !existing[item] {
			existing[item] = true
			newLines = append(newLines, "      - "+formatYAMLScalar(item))
		}
	}
	if len(newLines) == 0 {
		return lines, false
	}

	out := make([]string, 0, len(lines)+len(newLines))
	out = append(out, lines[:insertAt+1]...)
	out = append(out, newLines...)
	out = append(out, lines[insertAt+1:]...)
	return out, true
}

func removeFeaturePolicyDomains(workspaceDir string, domainsToRemove []string) error {
	policyFile := filepath.Join(workspaceDir, "assistant-policy.yaml")
	data, err := os.ReadFile(policyFile)
	if err != nil {
		return nil
	}
	removeMap := make(map[string]bool, len(domainsToRemove))
	for _, d := range domainsToRemove {
		removeMap[d] = true
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	var out []string
	inDelegation := false
	inWorkspace := false
	inAllowedDomains := false

	for _, rawLine := range lines {
		trimmed := strings.TrimSpace(rawLine)
		indent := len(rawLine) - len(strings.TrimLeft(rawLine, " "))
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			if indent == 0 {
				k, _, _ := splitYAMLKeyValue(trimmed)
				inDelegation = (k == "delegation")
				inWorkspace = false
				inAllowedDomains = false
			} else if inDelegation && indent == 2 {
				k, _, _ := splitYAMLKeyValue(trimmed)
				inWorkspace = (k == "workspace")
				inAllowedDomains = false
			} else if inWorkspace && indent == 4 && !strings.HasPrefix(trimmed, "- ") {
				k, _, _ := splitYAMLKeyValue(trimmed)
				inAllowedDomains = (k == "allowed_domains")
			} else if inAllowedDomains && indent >= 6 && strings.HasPrefix(trimmed, "- ") {
				val := unquoteYAMLScalar(strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
				if removeMap[val] {
					continue
				}
			}
		}
		out = append(out, rawLine)
	}
	return AtomicWriteFile(policyFile, []byte(strings.Join(out, "\n")), 0o600)
}

func cleanEmptyTemplateDomainDir(domainDir string) {
	entries, err := os.ReadDir(domainDir)
	if err != nil {
		return
	}
	hasUserFiles := false
	for _, entry := range entries {
		if entry.IsDir() {
			hasUserFiles = true
			continue
		}
		name := entry.Name()
		if name == ".gitkeep" || strings.HasSuffix(name, "-template.md") || strings.HasSuffix(name, ".schema.json") || name == "project-manifest.toml" || name == "ui.openui" {
			_ = os.Remove(filepath.Join(domainDir, name))
			continue
		}
		hasUserFiles = true
	}
	if !hasUserFiles {
		_ = os.Remove(domainDir)
	}
}

func copyAndValidateFeatureDir(srcDir, dstDir string) error {
	return filepath.WalkDir(srcDir, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlinks are not permitted in feature packages: %s", p)
		}
		rel, err := filepath.Rel(srcDir, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		if err := validateFeaturePackageEntry(relSlash); err != nil {
			return err
		}
		target := filepath.Join(dstDir, rel)
		if d.IsDir() {
			return EnsureDir(target, 0o700)
		}
		content, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if intake.DetectSecretContent(relSlash, content) {
			return fmt.Errorf("feature package file %s rejected: secret or credential pattern detected", relSlash)
		}
		if err := EnsureDir(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		return AtomicWriteFile(target, content, 0o600)
	})
}

func extractAndValidateFeatureZip(zipPath, dstDir string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("open feature archive: %w", err)
	}
	defer zr.Close()

	const maxFileSize = 10 * 1024 * 1024
	for _, f := range zr.File {
		if f.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlinks are not permitted in feature archives: %s", f.Name)
		}
		cleanRel := filepath.ToSlash(filepath.Clean(f.Name))
		if strings.HasPrefix(cleanRel, "/") || strings.HasPrefix(cleanRel, "../") || cleanRel == ".." {
			return fmt.Errorf("unsafe path in feature archive: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			continue
		}
		if err := validateFeaturePackageEntry(cleanRel); err != nil {
			return err
		}
		if f.UncompressedSize64 > maxFileSize {
			return fmt.Errorf("file %s exceeds maximum size in feature archive", cleanRel)
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		content, err := io.ReadAll(io.LimitReader(rc, maxFileSize+1))
		_ = rc.Close()
		if err != nil {
			return err
		}
		if len(content) > maxFileSize {
			return fmt.Errorf("file %s exceeds maximum size in feature archive", cleanRel)
		}
		if intake.DetectSecretContent(cleanRel, content) {
			return fmt.Errorf("feature archive file %s rejected: secret or credential pattern detected", cleanRel)
		}
		target := filepath.Join(dstDir, filepath.FromSlash(cleanRel))
		if err := EnsureDir(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if err := AtomicWriteFile(target, content, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func validateFeaturePackageEntry(relSlash string) error {
	parts := strings.Split(relSlash, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("invalid path segment in feature package: %s", relSlash)
		}
	}
	if strings.HasPrefix(relSlash, "workspace/") {
		wsRel := strings.TrimPrefix(relSlash, "workspace/")
		if security.IsProtectedWorkspacePath(wsRel) {
			return fmt.Errorf("feature package cannot override protected workspace file: %s", wsRel)
		}
	}
	return nil
}

func splitYAMLKeyValue(line string) (string, string, bool) {
	idx := strings.Index(line, ":")
	if idx <= 0 {
		return "", "", false
	}
	key := strings.TrimSpace(line[:idx])
	val := strings.TrimSpace(line[idx+1:])
	val = stripInlineYAMLComment(val)
	return key, val, true
}

func stripInlineYAMLComment(val string) string {
	if val == "" {
		return ""
	}
	inSingle := false
	inDouble := false
	for i := 0; i < len(val); i++ {
		c := val[i]
		if c == '\'' && !inDouble {
			inSingle = !inSingle
		} else if c == '"' && !inSingle {
			inDouble = !inDouble
		} else if c == '#' && !inSingle && !inDouble {
			if i == 0 || val[i-1] == ' ' || val[i-1] == '\t' {
				return strings.TrimSpace(val[:i])
			}
		}
	}
	return strings.TrimSpace(val)
}

func unquoteYAMLScalar(val string) string {
	val = strings.TrimSpace(val)
	if len(val) >= 2 {
		if (val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'') {
			return val[1 : len(val)-1]
		}
	}
	if val == "null" || val == "~" {
		return ""
	}
	return val
}

func parseInlineYAMLList(val string) []string {
	val = strings.TrimSpace(val)
	if !strings.HasPrefix(val, "[") || !strings.HasSuffix(val, "]") {
		return nil
	}
	inner := strings.TrimSpace(val[1 : len(val)-1])
	if inner == "" {
		return nil
	}
	parts := strings.Split(inner, ",")
	var out []string
	for _, p := range parts {
		item := unquoteYAMLScalar(p)
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}

func formatYAMLScalar(val string) string {
	if val == "" {
		return `""`
	}
	if strings.ContainsAny(val, ":#{}[]&*!|>'\"%@`") && !strings.Contains(val, " -> ") {
		return strconv.Quote(val)
	}
	return val
}

func applyDomainField(d *WorkspaceDomain, key, val string, listField *string) {
	switch key {
	case "path":
		d.Path = unquoteYAMLScalar(val)
	case "kind":
		d.Kind = unquoteYAMLScalar(val)
	case "label":
		d.Label = unquoteYAMLScalar(val)
	case "purpose":
		d.Purpose = unquoteYAMLScalar(val)
	case "lifecycle":
		d.Lifecycle = unquoteYAMLScalar(val)
	case "route":
		d.Route = unquoteYAMLScalar(val)
	case "template":
		d.Template = unquoteYAMLScalar(val)
	case "include_in_briefing":
		d.IncludeInBriefing = (unquoteYAMLScalar(val) == "true")
	case "briefing_category":
		d.BriefingCategory = unquoteYAMLScalar(val)
	case "feature":
		d.Feature = unquoteYAMLScalar(val)
	case "tags":
		if val == "" {
			*listField = "tags"
		} else {
			d.Tags = append(d.Tags, parseInlineYAMLList(val)...)
		}
	case "skills":
		if val == "" {
			*listField = "skills"
		} else {
			d.Skills = append(d.Skills, parseInlineYAMLList(val)...)
		}
	}
}

func applySkillField(s *FeatureSkillSpec, key, val string, listField *string) {
	switch key {
	case "id":
		s.ID = unquoteYAMLScalar(val)
	case "path":
		s.Path = unquoteYAMLScalar(val)
	case "workspace_domains":
		if val == "" {
			*listField = "workspace_domains"
		} else {
			s.WorkspaceDomains = append(s.WorkspaceDomains, parseInlineYAMLList(val)...)
		}
	}
}

// IsKnownBoilerplateTemplate checks if relPath is a standard OpenLia schema or unmodified starter template.
func IsKnownBoilerplateTemplate(repoRoot, relPath string, content []byte) (bool, string) {
	clean := strings.Trim(filepath.ToSlash(relPath), "/")
	base := filepath.Base(clean)

	if base == ".gitkeep" || base == ".gitignore" {
		return true, "workspace directory marker or ignore file"
	}
	if strings.HasSuffix(base, ".schema.json") {
		return true, "openlia json schema boilerplate"
	}
	// Root workspace metadata files when migrating an existing OpenLia workspace
	if clean == "README.md" || clean == "AGENTS.md" || clean == "SOUL.md" || clean == "workspace.yaml" || clean == "assistant-policy.yaml" {
		return true, "openlia root workspace metadata"
	}
	if !strings.HasSuffix(base, "-template.md") && clean != "calendar/reminders.rem" && clean != "sources/document-passwords.toml" {
		return false, ""
	}
	if repoRoot == "" {
		return false, ""
	}

	// Check against workspace-template/<clean>
	candidatePaths := []string{
		filepath.Join(repoRoot, "workspace-template", filepath.FromSlash(clean)),
	}
	if _, catPaths, err := LoadCatalogFeatures(repoRoot); err == nil {
		for _, pkgDir := range catPaths {
			candidatePaths = append(candidatePaths, filepath.Join(pkgDir, "workspace", filepath.FromSlash(clean)))
		}
	}
	normalizedContent := bytes.TrimSpace(bytes.ReplaceAll(content, []byte("\r\n"), []byte("\n")))
	for _, cand := range candidatePaths {
		if candBytes, err := os.ReadFile(cand); err == nil {
			normalizedCand := bytes.TrimSpace(bytes.ReplaceAll(candBytes, []byte("\r\n"), []byte("\n")))
			if bytes.Equal(normalizedContent, normalizedCand) {
				return true, "unmodified openlia starter template"
			}
		}
	}
	return false, ""
}

// RebaseInstalledFeature performs a 3-way rebase of an installed feature's workspace templates/schemas
// and bundled skills against the latest upstream templates catalog.
func RebaseInstalledFeature(config Config, featureID string, now time.Time) (RebaseResult, error) {
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return RebaseResult{}, err
	}
	if err := ValidateFeatureID(featureID); err != nil {
		return RebaseResult{}, err
	}
	manifest, pkgDir, source, existingRec, err := resolveFeatureManifest(config, featureID)
	if err != nil {
		return RebaseResult{}, err
	}
	if existingRec == nil {
		return RebaseResult{}, fmt.Errorf("feature %s is not installed", featureID)
	}

	workspaceDir := featureWorkspaceDir(config)
	newBaseWs := filepath.Join(pkgDir, "workspace")
	oldBaseWs := filepath.Join(config.MetaRoot, "managed", "features", featureID, "base")

	overallStatus := "fast-forward"
	autoForked := false
	var allConflicts []string
	var migContext string
	if info, err := os.Stat(newBaseWs); err == nil && info.IsDir() {
		if _, err := os.Stat(oldBaseWs); err == nil {
			tmpCurrent, err := os.MkdirTemp("", "openlia-feature-current-*")
			if err != nil {
				return RebaseResult{}, err
			}
			defer os.RemoveAll(tmpCurrent)

			for _, root := range []string{oldBaseWs, newBaseWs} {
				_ = filepath.WalkDir(root, func(p string, d os.DirEntry, walkErr error) error {
					if walkErr != nil || d.IsDir() {
						return walkErr
					}
					rel, err := filepath.Rel(root, p)
					if err != nil {
						return nil
					}
					wsFile := filepath.Join(workspaceDir, rel)
					if data, err := os.ReadFile(wsFile); err == nil {
						dst := filepath.Join(tmpCurrent, rel)
						_ = EnsureDir(filepath.Dir(dst), 0o700)
						_ = os.WriteFile(dst, data, 0o600)
					}
					return nil
				})
			}

			tmpMerged, err := os.MkdirTemp("", "openlia-feature-merged-*")
			if err != nil {
				return RebaseResult{}, err
			}
			defer os.RemoveAll(tmpMerged)

			forked, conflicts, err := RebaseDirectoryThreeWay(oldBaseWs, tmpCurrent, newBaseWs, tmpMerged)
			if err != nil {
				return RebaseResult{}, err
			}
			if forked {
				autoForked = true
				overallStatus = "merged"
			}
			if len(conflicts) > 0 {
				overallStatus = "conflict"
				allConflicts = append(allConflicts, conflicts...)
				migStaging := filepath.Join(config.DataRoot, ".openlia", "migrations", "feature-"+featureID)
				_ = removeSafeDirectory(migStaging)
				_ = EnsureDir(migStaging, 0o700)
				_ = CopyDir(oldBaseWs, filepath.Join(migStaging, "old-base"))
				_ = CopyDir(tmpCurrent, filepath.Join(migStaging, "current-fork"))
				_ = CopyDir(newBaseWs, filepath.Join(migStaging, "new-base"))
				migContext = migStaging
			} else {
				_ = filepath.WalkDir(tmpMerged, func(p string, d os.DirEntry, walkErr error) error {
					if walkErr != nil || d.IsDir() {
						return walkErr
					}
					rel, err := filepath.Rel(tmpMerged, p)
					if err != nil {
						return nil
					}
					data, err := os.ReadFile(p)
					if err != nil {
						return err
					}
					dst := filepath.Join(workspaceDir, rel)
					if err := EnsureDir(filepath.Dir(dst), 0o700); err != nil {
						return err
					}
					return AtomicWriteFile(dst, data, 0o600)
				})
				_ = replaceDirectory(newBaseWs, oldBaseWs)
			}
		} else {
			if err := seedFeatureWorkspaceFiles(newBaseWs, workspaceDir); err != nil {
				return RebaseResult{}, err
			}
			_ = replaceDirectory(newBaseWs, oldBaseWs)
		}
	}

	// Rebase bundled skills as well
	for _, sk := range manifest.Skills {
		skRes, err := RebaseInstalledSkill(config, sk.ID, now)
		if err == nil {
			if skRes.AutoForked {
				autoForked = true
			}
			if skRes.Status == "conflict" {
				overallStatus = "conflict"
				allConflicts = append(allConflicts, skRes.Conflicts...)
				if migContext == "" {
					migContext = skRes.MigrationContext
				}
			} else if skRes.Status == "merged" && overallStatus != "conflict" {
				overallStatus = "merged"
			}
		}
	}

	if overallStatus != "conflict" {
		_, err := installFeatureFromDir(config, manifest, pkgDir, source, existingRec, false, now)
		if err != nil {
			return RebaseResult{}, err
		}
	}

	return RebaseResult{
		OK:               true,
		Action:           "feature-update",
		ID:               featureID,
		Kind:             "feature",
		Status:           overallStatus,
		AutoForked:       autoForked,
		Conflicts:        allConflicts,
		MigrationContext: migContext,
	}, nil
}

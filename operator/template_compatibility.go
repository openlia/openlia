package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Start with a deliberately small contract: one minimum stable runtime release.
// Do not silently interpret arbitrary semver ranges or development revisions.
var minimumOpenLiaPattern = regexp.MustCompile(`^>=(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var runtimeVersionPattern = regexp.MustCompile(`^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)

func decodeTemplateYAML(data []byte, value any) error {
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(value); err != nil {
		if err == io.EOF {
			return nil
		}
		return err
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("template manifest/frontmatter must contain exactly one YAML document")
	}
	return nil
}

// Decode the full YAML mapping, then use the model's existing JSON field tags.
// This handles flow/block style, aliases, and merge keys without silently
// dropping fields or coercing numbers into strings.
func decodeTypedTemplateYAML(data []byte, value any) error {
	var document map[string]any
	if err := decodeTemplateYAML(data, &document); err != nil {
		return err
	}
	if document == nil {
		return fmt.Errorf("template manifest/frontmatter must be a mapping")
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return err
	}
	return json.Unmarshal(encoded, value)
}

func validateOpenLiaRequirement(requirement string) error {
	if requirement != "" && !minimumOpenLiaPattern.MatchString(requirement) {
		return fmt.Errorf("requires.openlia must be a minimum stable version such as \">=1.2.3\", got %q", requirement)
	}
	return nil
}

// Read this field with a YAML decoder rather than the legacy line parsers so
// inline mappings, duplicates, and invalid scalar types cannot bypass checks.
func parseOpenLiaRequirement(data []byte) (string, error) {
	var document struct {
		Requires map[string]yaml.Node `yaml:"requires"`
	}
	if err := decodeTemplateYAML(data, &document); err != nil {
		return "", fmt.Errorf("parse compatibility requirements: %w", err)
	}
	node, exists := document.Requires["openlia"]
	if !exists {
		return "", nil
	}
	if node.Kind == yaml.AliasNode && node.Alias != nil {
		node = *node.Alias
	}
	if node.Kind != yaml.ScalarNode || node.Tag != "!!str" || node.Value == "" {
		return "", fmt.Errorf("requires.openlia must be a nonempty minimum version string")
	}
	return node.Value, validateOpenLiaRequirement(node.Value)
}

func runtimeMeetsMinimum(version, requirement string) (bool, error) {
	if err := validateOpenLiaRequirement(requirement); err != nil {
		return false, err
	}
	actual := runtimeVersionPattern.FindStringSubmatch(version)
	if actual == nil {
		return false, fmt.Errorf("invalid deployed runtime version %q", version)
	}
	if actual[4] != "" {
		for _, part := range strings.Split(actual[4][1:], ".") {
			if len(part) > 1 && part[0] == '0' && strings.Trim(part, "0123456789") == "" {
				return false, fmt.Errorf("invalid deployed runtime version %q", version)
			}
		}
	}
	minimum := minimumOpenLiaPattern.FindStringSubmatch(requirement)
	if minimum == nil {
		return true, nil
	}
	for i := 1; i <= 3; i++ {
		if len(actual[i]) != len(minimum[i]) {
			return len(actual[i]) > len(minimum[i]), nil
		}
		if actual[i] != minimum[i] {
			return actual[i] > minimum[i], nil
		}
	}
	return actual[4] == "", nil // A prerelease is below its stable release.
}

func deployedTemplatesRuntimeVersion(config Config) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := NewCompose(config, nil).Run(ctx, "exec", "-T", "workspace-ui", "cat", "/opt/openlia/runtime-release.json")
	if err != nil {
		return "", fmt.Errorf("cannot read deployed Workspace UI release identity: %w", err)
	}
	var identity struct {
		Schema  int    `json:"schema"`
		OpenLia string `json:"openlia"`
	}
	if err := json.Unmarshal(result.Stdout, &identity); err != nil || identity.Schema != 1 || identity.OpenLia == "" {
		return "", fmt.Errorf("deployed Workspace UI release identity is missing or invalid")
	}
	return identity.OpenLia, nil
}

type templatePreflight struct {
	validateOnly bool
	config       Config
	version      func() (string, error)
	active       map[string]bool
	done         map[string]bool
}

func newTemplatePreflight(config Config) *templatePreflight {
	var version string
	var versionErr error
	loaded := false
	return &templatePreflight{
		config: config,
		version: func() (string, error) {
			if !loaded {
				version, versionErr = deployedTemplatesRuntimeVersion(config)
				loaded = true
			}
			return version, versionErr
		},
		active: map[string]bool{}, done: map[string]bool{},
	}
}

func (p *templatePreflight) check(label, requirement string) error {
	if err := validateOpenLiaRequirement(requirement); err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	if requirement == "" || p.validateOnly {
		return nil
	}
	version, err := p.version()
	if err != nil {
		return fmt.Errorf("%s requires OpenLia %s: %w; deploy a compatible Workspace UI before retrying; no installed workspace files were changed", label, requirement, err)
	}
	ok, err := runtimeMeetsMinimum(version, requirement)
	if err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	if !ok {
		return fmt.Errorf("%s requires OpenLia %s; detected deployed runtime %s; upgrade the deployment before retrying; no installed workspace files were changed", label, requirement, version)
	}
	return nil
}

func (p *templatePreflight) feature(manifest FeatureManifest, pkgDir string) error {
	if p.active[manifest.ID] {
		return fmt.Errorf("cyclic feature dependency at %s", manifest.ID)
	}
	if p.done[manifest.ID] {
		return nil
	}
	p.active[manifest.ID] = true
	defer delete(p.active, manifest.ID)
	if err := p.check("feature "+manifest.ID+" "+manifest.Version, manifest.Requires.OpenLia); err != nil {
		return err
	}
	for _, id := range manifest.Requires.Features {
		if err := p.featureID(id); err != nil {
			return err
		}
	}
	for _, skill := range manifest.Skills {
		if err := p.skill(filepath.Join(pkgDir, filepath.FromSlash(skill.Path))); err != nil {
			return err
		}
	}
	p.done[manifest.ID] = true
	return nil
}

func (p *templatePreflight) featureID(id string) error {
	if err := ValidateFeatureID(id); err != nil {
		return err
	}
	manifest, dir, _, _, err := resolveFeatureManifest(p.config, id)
	if err != nil {
		return err
	}
	return p.feature(manifest, dir)
}

func (p *templatePreflight) skill(dir string) error {
	requirements, err := readSkillRequirements(dir)
	if err != nil {
		return fmt.Errorf("skill %s: %w", filepath.Base(dir), err)
	}
	return p.check("skill "+filepath.Base(dir), requirements.OpenLia)
}

// A bundled skill installed directly must also satisfy its owning feature.
func (p *templatePreflight) catalogSkill(dir string) error {
	owner := filepath.Dir(filepath.Dir(dir))
	data, err := os.ReadFile(filepath.Join(owner, "feature.yaml"))
	if err == nil {
		manifest, err := ParseFeatureManifest(data)
		if err != nil {
			return err
		}
		if err := p.feature(manifest, owner); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return p.skill(dir)
}

func (p *templatePreflight) profile(manifest TemplateProfileManifest) error {
	if err := p.check("profile "+manifest.ID, manifest.Requires.OpenLia); err != nil {
		return err
	}
	for _, id := range manifest.Features {
		if err := p.featureID(id); err != nil {
			return err
		}
	}
	skills, err := LoadCatalogSkills(p.config)
	if err != nil {
		return err
	}
	for _, id := range manifest.Skills {
		dir, ok := skills[id]
		if !ok {
			return fmt.Errorf("skill %s not found in templates catalog", id)
		}
		if err := p.catalogSkill(dir); err != nil {
			return err
		}
	}
	return nil
}

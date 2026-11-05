package operator

// Minion distribution owns code, never a recipient's configuration or records.
// Keep this contract in parity with server/minion-distribution.ts.
import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"openlia/operator/migration/intake"
)

const minionPackageFile = "minion.package.json"
const maxMinionPackageFileBytes = 10 * 1024 * 1024

type minionDistribution struct {
	Schema int      `json:"schema"`
	Files  []string `json:"files"`
}

type minionPackage struct {
	ID       string
	Dir      string
	Files    []string
	Config   *jsonschema.Schema
	Defaults map[string]any
}

type MinionInstallStatus struct {
	ID                    string `json:"id"`
	ConfigurationRequired bool   `json:"configuration_required"`
}

// Only exact app roots can be selected, never the whole namespace or its state.
func minionDomainID(rel string) (string, bool, error) {
	parts := strings.Split(rel, "/")
	if parts[0] != "minions" {
		return "", false, nil
	}
	if len(parts) != 2 || ValidateFeatureID(parts[1]) != nil {
		return "", true, fmt.Errorf("select an exact minions/<slug> domain, not %q", rel)
	}
	return parts[1], true, nil
}

func portableMinionFile(rel string) bool {
	if rel == "" || strings.ContainsAny(rel, "\\:\x00") || filepath.IsAbs(rel) {
		return false
	}
	for _, part := range strings.Split(rel, "/") {
		lower := strings.ToLower(part)
		if part == "" || part == "." || part == ".." || strings.HasPrefix(part, ".") {
			return false
		}
		switch lower {
		case "config.json", "data", "state", "cache", "caches", "logs", "uploads", "tmp", "temp",
			"node_modules", "__pycache__", "venv", "env", "dist", "build", "coverage":
			return false
		}
		if strings.HasSuffix(lower, ".pyc") || strings.HasSuffix(lower, ".log") ||
			strings.HasSuffix(lower, ".pem") || strings.HasSuffix(lower, ".key") ||
			strings.Contains(lower, "credential") || strings.Contains(lower, "secret") ||
			strings.Contains(lower, "token") || strings.Contains(lower, "id_rsa") || strings.Contains(lower, "id_ed25519") {
			return false
		}
	}
	return true
}

// Reject symlinks in every existing component, including the root. Missing
// destination suffixes are allowed; file creation remains exclusive below.
func minionSafePath(root, rel string) (string, error) {
	if filepath.IsAbs(rel) || strings.ContainsAny(rel, "\\:\x00") {
		return "", fmt.Errorf("unsafe Minion path %q", rel)
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("unsafe Minion path %q", rel)
		}
	}
	full, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", err
	}
	base, _ := filepath.Abs(root)
	for current := full; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("symlinks are not permitted in Minion paths: %s", current)
		}
		if err != nil && !os.IsNotExist(err) {
			return "", err
		}
		if current == base {
			break
		}
	}
	return full, nil
}

func readMinionFile(root, rel string) ([]byte, error) {
	path, err := minionSafePath(root, rel)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxMinionPackageFileBytes {
		return nil, fmt.Errorf("invalid or oversized Minion package file %s", rel)
	}
	data, err := os.ReadFile(path)
	if err == nil && intake.DetectSecretContent(rel, data) {
		return nil, fmt.Errorf("Minion package file %s rejected: credential pattern detected", rel)
	}
	return data, err
}

type offlineMinionSchemaLoader struct{}

func (offlineMinionSchemaLoader) Load(url string) (any, error) {
	return nil, fmt.Errorf("external schema references are not permitted: %s", url)
}

func compileMinionConfig(data []byte) (*jsonschema.Schema, map[string]any, error) {
	var schema map[string]any
	if err := json.Unmarshal(data, &schema); err != nil || schema == nil || schema["type"] != "object" {
		return nil, nil, fmt.Errorf("config.schema.json must declare an object schema")
	}
	if draft, ok := schema["$schema"]; ok && draft != "https://json-schema.org/draft/2020-12/schema" {
		return nil, nil, fmt.Errorf("config.schema.json must use Draft 2020-12")
	}
	required, _ := schema["required"].([]any)
	hasTrigger := false
	for _, key := range required {
		if key == "trigger" {
			hasTrigger = true
		}
	}
	if !hasTrigger {
		return nil, nil, fmt.Errorf("config.schema.json must require trigger")
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	compiler.UseLoader(offlineMinionSchemaLoader{})
	if err := compiler.AddResource("urn:openlia:minion:config", schema); err != nil {
		return nil, nil, err
	}
	compiled, err := compiler.Compile("urn:openlia:minion:config")
	if err != nil {
		return nil, nil, fmt.Errorf("config.schema.json: %w", err)
	}
	defaults, _ := minionSchemaDefault(schema).(map[string]any)
	if defaults == nil {
		defaults = map[string]any{}
	}
	// Never turn on automatic work merely by installing a package.
	defaults["trigger"] = map[string]any{"on_new_entry": false}
	if _, present := defaults["data_views"]; present {
		defaults["data_views"] = map[string]any{"briefing": []any{}, "scopes": map[string]any{}}
	}
	if compiled.Validate(defaults) != nil {
		defaults = nil // Required user settings are reported, not invented.
	}
	return compiled, defaults, nil
}

// Resolve explicit defaults and direct object properties only. Ambiguous
// oneOf/$ref defaults are intentionally left for the configuration UI.
func minionSchemaDefault(schema map[string]any) any {
	if value, ok := schema["default"]; ok {
		return value
	}
	properties, _ := schema["properties"].(map[string]any)
	if schema["type"] != "object" {
		return nil
	}
	result := map[string]any{}
	for key, raw := range properties {
		if child, ok := raw.(map[string]any); ok {
			if value, explicit := child["default"]; explicit {
				result[key] = value
			} else if value := minionSchemaDefault(child); value != nil {
				result[key] = value
			}
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func readMinionPackage(dir, id string, strict bool) (minionPackage, error) {
	result := minionPackage{ID: id, Dir: dir}
	data, err := readMinionFile(dir, minionPackageFile)
	if err != nil {
		return result, fmt.Errorf("Minion %s needs a reviewed %s: %w", id, minionPackageFile, err)
	}
	var manifest minionDistribution
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return result, fmt.Errorf("%s: %w", minionPackageFile, err)
	}
	if decoder.Decode(new(any)) != io.EOF || manifest.Schema != 1 || len(manifest.Files) == 0 {
		return result, fmt.Errorf("invalid %s (expected schema: 1 and explicit files)", minionPackageFile)
	}
	seen := map[string]bool{minionPackageFile: true}
	seenFold := map[string]bool{minionPackageFile: true}
	for _, rel := range manifest.Files {
		if !portableMinionFile(rel) || seenFold[strings.ToLower(rel)] {
			return result, fmt.Errorf("unsafe or duplicate Minion distribution file %q", rel)
		}
		if _, err := readMinionFile(dir, rel); err != nil {
			return result, err
		}
		seen[rel] = true
		seenFold[strings.ToLower(rel)] = true
	}
	for _, name := range []string{"README.md", "dashboard.openui", "input.openui", "input.schema.json", "config.schema.json"} {
		if !seen[name] {
			return result, fmt.Errorf("Minion distribution missing required file %s", name)
		}
	}
	if seen["main.py"] == seen["main.ts"] || seen["input.py"] == seen["input.ts"] || seen["main.py"] != seen["input.py"] {
		return result, fmt.Errorf("Minion distribution requires exactly one runtime and its input entrypoint")
	}
	hasTests := false
	for path := range seen {
		if strings.HasPrefix(path, "tests/") {
			hasTests = true
		}
		result.Files = append(result.Files, path)
	}
	if !hasTests {
		return result, fmt.Errorf("Minion distribution must include tests/")
	}
	sort.Strings(result.Files)
	schema, _ := readMinionFile(dir, "config.schema.json")
	result.Config, result.Defaults, err = compileMinionConfig(schema)
	if err != nil {
		return result, err
	}
	if strict {
		err = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			rel, _ := filepath.Rel(dir, path)
			if rel == "." {
				return nil
			}
			rel = filepath.ToSlash(rel)
			if entry.Type()&os.ModeSymlink != 0 || !portableMinionFile(rel) || (!entry.IsDir() && !seen[rel]) {
				return fmt.Errorf("Minion package contains undeclared or local-only path %s", rel)
			}
			return nil
		})
	}
	return result, err
}

func featureMinionPackages(workspace string, domains []WorkspaceDomain) ([]minionPackage, error) {
	selected := map[string]bool{}
	for _, domain := range domains {
		id, isMinion, err := minionDomainID(domain.Path)
		if err != nil {
			return nil, err
		}
		if isMinion {
			selected[id] = true
		}
	}
	root, err := minionSafePath(workspace, "minions")
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) && len(selected) == 0 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var packages []minionPackage
	for _, entry := range entries {
		id := entry.Name()
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !selected[id] || ValidateFeatureID(id) != nil {
			return nil, fmt.Errorf("feature must declare each Minion as an exact domain: minions/%s", id)
		}
		pkg, err := readMinionPackage(filepath.Join(root, id), id, true)
		if err != nil {
			return nil, err
		}
		packages = append(packages, pkg)
		delete(selected, id)
	}
	if len(selected) != 0 {
		return nil, fmt.Errorf("feature declares a missing Minion package")
	}
	return packages, nil
}

func initializeFeatureMinions(workspace string, packages []minionPackage, initialize bool) ([]MinionInstallStatus, error) {
	var statuses []MinionInstallStatus
	for _, pkg := range packages {
		path, err := minionSafePath(workspace, "minions/"+pkg.ID+"/config.json")
		if err != nil {
			return nil, err
		}
		if _, err := os.Lstat(path); os.IsNotExist(err) && pkg.Defaults != nil && initialize {
			data, _ := json.MarshalIndent(pkg.Defaults, "", "  ")
			file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil && !os.IsExist(err) {
				return nil, err
			}
			if err == nil {
				_, err = file.Write(append(data, '\n'))
				closeErr := file.Close()
				if err != nil {
					return nil, err
				}
				if closeErr != nil {
					return nil, closeErr
				}
			}
		}
		data, err := os.ReadFile(path)
		var config any
		pending := err != nil || json.Unmarshal(data, &config) != nil || pkg.Config.Validate(config) != nil || !validMinionConfigTrigger(config)
		statuses = append(statuses, MinionInstallStatus{ID: pkg.ID, ConfigurationRequired: pending})
	}
	return statuses, nil
}

func validMinionConfigTrigger(value any) bool {
	config, ok := value.(map[string]any)
	if !ok {
		return false
	}
	switch trigger := config["trigger"].(type) {
	case string:
		return trigger == "entry" || trigger == "cron" || trigger == "both"
	case map[string]any:
		if len(trigger) == 0 {
			return false
		}
		for key, value := range trigger {
			switch key {
			case "on_new_entry":
				if _, ok := value.(bool); !ok {
					return false
				}
			case "cron":
				if text, ok := value.(string); !ok || strings.TrimSpace(text) == "" {
					return false
				}
			default:
				return false
			}
		}
		return true
	}
	return false
}

func preflightFeatureMinionDestinations(config Config, featureID string, packages []minionPackage) error {
	if len(packages) == 0 {
		return nil
	}
	records, err := loadInstalledFeatureRecords(config.MetaRoot)
	if err != nil {
		return err
	}
	owned := map[string]bool{}
	for _, domain := range records[featureID].Manifest.Domains {
		owned[domain.Path] = true
	}
	workspace := featureWorkspaceDir(config)
	for _, pkg := range packages {
		rel := "minions/" + pkg.ID
		path, err := minionSafePath(workspace, rel)
		if err != nil {
			return err
		}
		if _, err := os.Lstat(path); err == nil && !owned[rel] {
			return fmt.Errorf("Minion %s already exists and is not owned by feature %s", pkg.ID, featureID)
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
		for _, file := range append(append([]string{}, pkg.Files...), "config.json") {
			if _, err := minionSafePath(workspace, rel+"/"+file); err != nil {
				return err
			}
		}
	}
	return nil
}

// Old releases may have accidentally snapshotted local app state. Never feed it
// to the rebase engine, even when updating to a now-safe package.
func minionManagedWorkspacePath(rel string) bool {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if parts[0] != "minions" || len(parts) < 3 {
		return true
	}
	return portableMinionFile(strings.Join(parts[2:], "/"))
}

func sanitizedFeatureBase(source, destination string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(source, path)
		if rel == "." {
			return EnsureDir(destination, 0o700)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink in managed feature base: %s", rel)
		}
		if !minionManagedWorkspacePath(rel) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		target := filepath.Join(destination, rel)
		if entry.IsDir() {
			return EnsureDir(target, 0o700)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return AtomicWriteFile(target, data, 0o600)
	})
}

func featureHasMinions(manifest FeatureManifest) bool {
	for _, domain := range manifest.Domains {
		if _, app, _ := minionDomainID(domain.Path); app {
			return true
		}
	}
	return false
}

// Reinstall/import must not reset the upstream base under customized code.
func reinstallMinionFeature(config Config, manifest FeatureManifest, dir, source string, existingRec *InstalledFeatureRecord, now time.Time) (FeatureInstallResult, error) {
	result, err := rebaseFeatureFromDir(config, manifest, dir, source, existingRec, now)
	if err != nil {
		return FeatureInstallResult{}, err
	}
	if result.Status == "conflict" {
		return FeatureInstallResult{}, fmt.Errorf("Minion feature update has conflicts; review %s", result.MigrationContext)
	}
	packages, err := featureMinionPackages(filepath.Join(dir, "workspace"), manifest.Domains)
	if err != nil {
		return FeatureInstallResult{}, err
	}
	statuses, err := initializeFeatureMinions(featureWorkspaceDir(config), packages, false)
	response := FeatureInstallResult{OK: err == nil, Action: "feature-install", FeatureID: manifest.ID, Minions: statuses}
	for _, domain := range manifest.Domains {
		response.InstalledDomains = append(response.InstalledDomains, domain.Path)
	}
	return response, err
}

func removeObsoleteMinionCode(old, merged, workspace string) error {
	return filepath.WalkDir(old, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(old, path)
		rel = filepath.ToSlash(rel)
		if !strings.HasPrefix(rel, "minions/") || !minionManagedWorkspacePath(rel) {
			return nil
		}
		if _, err := os.Lstat(filepath.Join(merged, filepath.FromSlash(rel))); !os.IsNotExist(err) {
			return err
		}
		target, err := minionSafePath(workspace, rel)
		if err != nil {
			return err
		}
		if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	})
}

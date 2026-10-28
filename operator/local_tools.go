package operator

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"openlia/internal/toolcatalog"
)

type InstalledToolRecord struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	BinaryPath  string   `json:"binary_path"`
	ExposedPath string   `json:"exposed_path"`
	RequiredBy  []string `json:"required_by"`
	InstalledAt string   `json:"installed_at"`
}

type InstalledEnvRecord struct {
	SkillID        string `json:"skill_id"`
	PythonManifest string `json:"python_manifest,omitempty"`
	BunManifest    string `json:"bun_manifest,omitempty"`
	EnvDir         string `json:"env_dir"`
	UpdatedAt      string `json:"updated_at"`
}

type LocalToolsState struct {
	Schema int                            `json:"schema"`
	Tools  map[string]InstalledToolRecord `json:"tools"`
	Envs   map[string]InstalledEnvRecord  `json:"envs"`
}

type ToolOverrideSpec struct {
	Version    string
	BinaryPath string
}

// EnsureLocalToolDirs initializes /opt/data/.local/{bin,manifests,tools,envs}.
func EnsureLocalToolDirs(dataRoot string, uid, gid int) error {
	localRoot := filepath.Join(dataRoot, ".local")
	for _, sub := range []struct {
		rel  string
		mode os.FileMode
	}{
		{"", 0o755},
		{"bin", 0o755},
		{"manifests", 0o700},
		{"tools", 0o755},
		{"envs", 0o755},
	} {
		dir := filepath.Join(localRoot, sub.rel)
		if err := EnsureDir(dir, sub.mode); err != nil {
			return err
		}
		if uid > 0 && gid > 0 {
			if err := ensureRuntimeOwner(dir, uid, gid, sub.mode); err != nil {
				return err
			}
		}
	}
	return nil
}

func localToolsStatePath(dataRoot string) string {
	return filepath.Join(dataRoot, ".local", "manifests", "state.json")
}

func localToolsOverridesPath(dataRoot string) string {
	return filepath.Join(dataRoot, ".local", "manifests", "overrides.yaml")
}

func LoadLocalToolsState(dataRoot string) (LocalToolsState, error) {
	state := LocalToolsState{
		Schema: 1,
		Tools:  make(map[string]InstalledToolRecord),
		Envs:   make(map[string]InstalledEnvRecord),
	}
	data, err := os.ReadFile(localToolsStatePath(dataRoot))
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return state, err
	}
	if state.Tools == nil {
		state.Tools = make(map[string]InstalledToolRecord)
	}
	if state.Envs == nil {
		state.Envs = make(map[string]InstalledEnvRecord)
	}
	if state.Schema == 0 {
		state.Schema = 1
	}
	return state, nil
}

func SaveLocalToolsState(dataRoot string, state LocalToolsState) error {
	if err := EnsureDir(filepath.Join(dataRoot, ".local", "manifests"), 0o700); err != nil {
		return err
	}
	state.Schema = 1
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return AtomicWriteFile(localToolsStatePath(dataRoot), append(data, '\n'), 0o600)
}

func loadLocalToolsOverrides(dataRoot string) map[string]ToolOverrideSpec {
	overrides := make(map[string]ToolOverrideSpec)
	data, err := os.ReadFile(localToolsOverridesPath(dataRoot))
	if err != nil {
		return overrides
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	inTools := false
	currentTool := ""
	for _, rawLine := range lines {
		trimmed := strings.TrimSpace(rawLine)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(rawLine) - len(strings.TrimLeft(rawLine, " "))
		if indent == 0 {
			k, _, ok := splitYAMLKeyValue(trimmed)
			inTools = ok && k == "tools"
			currentTool = ""
			continue
		}
		if !inTools {
			continue
		}
		if indent == 2 {
			k, _, ok := splitYAMLKeyValue(trimmed)
			if ok {
				currentTool = strings.TrimSpace(k)
			}
			continue
		}
		if indent >= 4 && currentTool != "" {
			k, val, ok := splitYAMLKeyValue(trimmed)
			if !ok {
				continue
			}
			spec := overrides[currentTool]
			switch k {
			case "version":
				spec.Version = unquoteYAMLScalar(val)
			case "binary_path":
				spec.BinaryPath = unquoteYAMLScalar(val)
			}
			overrides[currentTool] = spec
		}
	}
	return overrides
}

// ProvisionRequiredTools ensures that each requested tool in tools is provisioned into
// /opt/data/.local/tools/<tool>/<version>/bin/<tool>, linked into /opt/data/.local/bin/<tool>,
// and recorded in /opt/data/.local/manifests/state.json.
func ProvisionRequiredTools(config Config, tools []string, requiredBy string) ([]string, error) {
	if len(tools) == 0 {
		return nil, nil
	}
	if err := EnsureLocalToolDirs(config.DataRoot, config.RuntimeUID, config.RuntimeGID); err != nil {
		return nil, err
	}
	overrides := loadLocalToolsOverrides(config.DataRoot)
	state, err := LoadLocalToolsState(config.DataRoot)
	if err != nil {
		return nil, err
	}

	var provisioned []string
	nowStamp := utcTimestamp(time.Now().UTC())
	for _, rawTool := range tools {
		toolName := strings.TrimSpace(strings.ToLower(rawTool))
		if toolName == "" {
			continue
		}
		override, hasOverride := overrides[toolName]
		spec, ok := toolcatalog.LookupTool(toolName)
		if !ok && !hasOverride {
			return nil, toolcatalog.ValidateToolName(toolName)
		}
		if !ok {
			spec = toolcatalog.ToolSpec{
				Name:           toolName,
				DefaultVersion: "custom",
				Binary:         toolName,
			}
		}
		version := spec.DefaultVersion
		if hasOverride && override.Version != "" {
			version = override.Version
		}
		if err := ValidateSafeComponent(toolName, "tool"); err != nil {
			return nil, err
		}

		toolBinDir := filepath.Join(config.DataRoot, ".local", "tools", toolName, version, "bin")
		if err := EnsureDir(toolBinDir, 0o755); err != nil {
			return nil, err
		}
		toolBinPath := filepath.Join(toolBinDir, spec.Binary)
		exposedPath := filepath.Join(config.DataRoot, ".local", "bin", spec.Binary)

		if err := materializeToolBinary(spec.Binary, toolBinPath, exposedPath, override.BinaryPath); err != nil {
			return nil, fmt.Errorf("provision tool %s: %w", toolName, err)
		}

		existing := state.Tools[toolName]
		reqBySet := make(map[string]bool)
		for _, r := range existing.RequiredBy {
			if r != "" {
				reqBySet[r] = true
			}
		}
		if requiredBy != "" {
			reqBySet[requiredBy] = true
		}
		var reqByList []string
		for r := range reqBySet {
			reqByList = append(reqByList, r)
		}
		sort.Strings(reqByList)
		installedAt := existing.InstalledAt
		if installedAt == "" {
			installedAt = nowStamp
		}
		state.Tools[toolName] = InstalledToolRecord{
			Name:        toolName,
			Version:     version,
			BinaryPath:  filepath.ToSlash(filepath.Join(".local", "tools", toolName, version, "bin", spec.Binary)),
			ExposedPath: filepath.ToSlash(filepath.Join(".local", "bin", spec.Binary)),
			RequiredBy:  reqByList,
			InstalledAt: installedAt,
		}
		provisioned = append(provisioned, toolName)
	}

	if err := SaveLocalToolsState(config.DataRoot, state); err != nil {
		return nil, err
	}
	return provisioned, nil
}

func materializeToolBinary(binaryName, toolBinPath, exposedPath, overrideBinaryPath string) error {
	targetSystemBin := overrideBinaryPath
	if targetSystemBin == "" {
		if found, err := exec.LookPath(binaryName); err == nil && filepath.Clean(found) != filepath.Clean(exposedPath) {
			targetSystemBin = found
		}
	}

	var script string
	if targetSystemBin != "" {
		script = fmt.Sprintf("#!/bin/sh\nexec %q \"$@\"\n", targetSystemBin)
	} else {
		script = fmt.Sprintf("#!/bin/sh\nfor candidate in /usr/bin/%s /usr/local/bin/%s /bin/%s; do\n  if [ -x \"$candidate\" ]; then\n    exec \"$candidate\" \"$@\"\n  fi\ndone\necho \"openlia: %s is registered in /opt/data/.local/tools but binary is not installed on host\" >&2\nexit 127\n", binaryName, binaryName, binaryName, binaryName)
	}
	if err := AtomicWriteFile(toolBinPath, []byte(script), 0o755); err != nil {
		return err
	}
	if err := os.Chmod(toolBinPath, 0o755); err != nil {
		return err
	}
	_ = os.Remove(exposedPath)
	relTarget, relErr := filepath.Rel(filepath.Dir(exposedPath), toolBinPath)
	if relErr == nil {
		if err := os.Symlink(relTarget, exposedPath); err == nil {
			return nil
		}
	}
	if err := AtomicCopyFile(toolBinPath, exposedPath, 0o755); err != nil {
		return err
	}
	return os.Chmod(exposedPath, 0o755)
}

// ParseSkillRequirements parses optional `requires.tools`, `requires.python`, and `requires.bun`
// from a skill's SKILL.md YAML frontmatter.
func ParseSkillRequirements(skillDir string) (tools []string, pythonManifest string, bunManifest string) {
	requirements, _ := readSkillRequirements(skillDir)
	return requirements.Tools, requirements.Python, requirements.Bun
}

func readSkillRequirements(skillDir string) (FeatureRequirements, error) {
	data, err := os.ReadFile(filepath.Join(skillDir, "SKILL.md"))
	if err != nil {
		return FeatureRequirements{}, err
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return FeatureRequirements{}, nil
	}
	lines := strings.Split(text[4:], "\n")
	for i, line := range lines {
		if line != "---" {
			continue
		}
		frontmatter := []byte(strings.Join(lines[:i], "\n"))
		if strings.TrimSpace(string(frontmatter)) == "" {
			return FeatureRequirements{}, nil
		}
		var document struct {
			Requires FeatureRequirements `json:"requires"`
		}
		if err := decodeTypedTemplateYAML(frontmatter, &document); err != nil {
			return FeatureRequirements{}, err
		}
		if _, err := parseOpenLiaRequirement(frontmatter); err != nil {
			return FeatureRequirements{}, err
		}
		return document.Requires, validateEnvironmentManifestPaths(document.Requires)
	}
	return FeatureRequirements{}, fmt.Errorf("skill %s has unclosed frontmatter", filepath.Base(skillDir))
}

func validateEnvironmentManifestPaths(requirements FeatureRequirements) error {
	for name, path := range map[string]string{"python": requirements.Python, "bun": requirements.Bun} {
		if path == "" {
			continue
		}
		clean := filepath.Clean(filepath.FromSlash(path))
		if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return fmt.Errorf("requires.%s must be a safe relative manifest path", name)
		}
	}
	return nil
}

// ProvisionSkillEnvironment provisions any tool, Python (uv), or Bun environment
// dependencies declared by a skill or its parent feature.
func ProvisionSkillEnvironment(config Config, skillID, skillDir, pythonManifest, bunManifest string) error {
	requirements, err := readSkillRequirements(skillDir)
	if err != nil {
		return err
	}
	skTools, skPy, skBun := requirements.Tools, requirements.Python, requirements.Bun
	if len(skTools) > 0 {
		if _, err := ProvisionRequiredTools(config, skTools, "skill:"+skillID); err != nil {
			return err
		}
	}
	if pythonManifest == "" {
		pythonManifest = skPy
	}
	if bunManifest == "" {
		bunManifest = skBun
	}
	if pythonManifest == "" && bunManifest == "" {
		return nil
	}

	if err := EnsureLocalToolDirs(config.DataRoot, config.RuntimeUID, config.RuntimeGID); err != nil {
		return err
	}
	envDir := filepath.Join(config.DataRoot, ".local", "envs", skillID)
	if err := EnsureDir(envDir, 0o755); err != nil {
		return err
	}

	if pythonManifest != "" {
		cleanPy := filepath.Clean(filepath.FromSlash(pythonManifest))
		if strings.HasPrefix(cleanPy, "..") || filepath.IsAbs(cleanPy) {
			return fmt.Errorf("skill %s has unsafe python manifest path %q", skillID, pythonManifest)
		}
		srcPy := filepath.Join(skillDir, cleanPy)
		if info, err := os.Stat(srcPy); err == nil && info.Mode().IsRegular() {
			_ = AtomicCopyFile(srcPy, filepath.Join(envDir, filepath.Base(cleanPy)), 0o600)
		}
	}
	if bunManifest != "" {
		cleanBun := filepath.Clean(filepath.FromSlash(bunManifest))
		if strings.HasPrefix(cleanBun, "..") || filepath.IsAbs(cleanBun) {
			return fmt.Errorf("skill %s has unsafe bun manifest path %q", skillID, bunManifest)
		}
		srcBun := filepath.Join(skillDir, cleanBun)
		if info, err := os.Stat(srcBun); err == nil && info.Mode().IsRegular() {
			_ = AtomicCopyFile(srcBun, filepath.Join(envDir, filepath.Base(cleanBun)), 0o600)
		}
	}

	state, err := LoadLocalToolsState(config.DataRoot)
	if err != nil {
		return err
	}
	state.Envs[skillID] = InstalledEnvRecord{
		SkillID:        skillID,
		PythonManifest: pythonManifest,
		BunManifest:    bunManifest,
		EnvDir:         filepath.ToSlash(filepath.Join(".local", "envs", skillID)),
		UpdatedAt:      utcTimestamp(time.Now().UTC()),
	}
	return SaveLocalToolsState(config.DataRoot, state)
}

// ReprovisionLocalStore re-materializes /opt/data/.local/{bin,tools,envs} from
// /opt/data/.local/manifests/state.json after a backup restore.
func ReprovisionLocalStore(config Config) error {
	state, err := LoadLocalToolsState(config.DataRoot)
	if err != nil {
		return err
	}
	if len(state.Tools) == 0 && len(state.Envs) == 0 {
		return nil
	}
	if err := EnsureLocalToolDirs(config.DataRoot, config.RuntimeUID, config.RuntimeGID); err != nil {
		return err
	}
	overrides := loadLocalToolsOverrides(config.DataRoot)
	for toolName, rec := range state.Tools {
		spec, ok := toolcatalog.LookupTool(toolName)
		if !ok {
			spec = toolcatalog.ToolSpec{
				Name:           toolName,
				DefaultVersion: rec.Version,
				Binary:         toolName,
			}
		}
		version := rec.Version
		if version == "" {
			version = spec.DefaultVersion
		}
		override := overrides[toolName]
		if override.Version != "" {
			version = override.Version
		}
		toolBinDir := filepath.Join(config.DataRoot, ".local", "tools", toolName, version, "bin")
		if err := EnsureDir(toolBinDir, 0o755); err != nil {
			return err
		}
		toolBinPath := filepath.Join(toolBinDir, spec.Binary)
		exposedPath := filepath.Join(config.DataRoot, ".local", "bin", spec.Binary)
		if err := materializeToolBinary(spec.Binary, toolBinPath, exposedPath, override.BinaryPath); err != nil {
			return err
		}
	}
	for skillID, envRec := range state.Envs {
		skillDir := filepath.Join(config.DataRoot, "skills", skillID)
		_ = ProvisionSkillEnvironment(config, skillID, skillDir, envRec.PythonManifest, envRec.BunManifest)
	}
	return nil
}

package operator

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProfileSyncPreservesCustomizedSkillsAndTracksMetadata(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	skillSource := filepath.Join(repo, "profile", "skills", "example")
	if err := os.MkdirAll(skillSource, 0o755); err != nil {
		t.Fatal(err)
	}
	for path, contents := range map[string]string{
		filepath.Join(repo, "profile", "SOUL.md"):                       "soul\n",
		filepath.Join(repo, "profile", "AGENTS.md"):                     "agents\n",
		filepath.Join(repo, "profile", "config.yaml"):                   "config\n",
		filepath.Join(repo, "profile", "skills", "example", "SKILL.md"): "skill\n",
		filepath.Join(repo, "release", "manifest.json"):                 `{"openlia":"test"}`,
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	config := testConfig(repo, runtime)
	p := NewProfileOperator(config)
	p.Now = func() time.Time { return time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC) }
	first, err := p.Sync()
	if err != nil {
		t.Fatal(err)
	}
	if first.Skills.Installed != 1 || first.Skills.Results[0].Action != "installed" {
		t.Fatalf("unexpected initial sync: %+v", first)
	}
	second, err := p.Sync()
	if err != nil {
		t.Fatal(err)
	}
	if second.Skills.Unchanged != 1 || second.Skills.Results[0].Provenance != "valid" {
		t.Fatalf("unexpected unchanged sync: %+v", second)
	}
	destination := filepath.Join(config.DataRoot, "skills", "example", "SKILL.md")
	if err := os.WriteFile(destination, []byte("customized\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	customized, err := p.Sync()
	if err != nil {
		t.Fatal(err)
	}
	if customized.Skills.Customized != 1 || customized.Skills.Results[0].Reason != "local_modifications_detected" {
		t.Fatalf("customization was not blocked: %+v", customized)
	}
	if err := os.Remove(filepath.Join(config.MetaRoot, "managed", "skills", "example.json")); err != nil {
		t.Fatal(err)
	}
	unmanaged, err := p.Sync()
	if err != nil {
		t.Fatal(err)
	}
	if unmanaged.Skills.Unmanaged != 1 || unmanaged.Skills.Results[0].Reason != "metadata_missing" {
		t.Fatalf("missing provenance was not reported: %+v", unmanaged)
	}
}

func TestProfileSyncRendersFallbackProviders(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	configPath := filepath.Join(repo, "profile", "config.yaml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repo, "profile", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	configTemplate := "model:\n  provider: copilot\n\n" + fallbackBlockStart + "\nfallback_providers: []\n" + fallbackBlockEnd + "\n"
	if err := os.WriteFile(configPath, []byte(configTemplate), 0o644); err != nil {
		t.Fatal(err)
	}
	config := testConfig(repo, runtime)
	config.FallbackProviders = []FallbackProviderConfig{
		{Provider: "custom", Model: "gateway-model", BaseURL: "http://locho-laptop:11434/v1", KeyEnv: "OPENAI_GATEWAY_API_KEY"},
		{Provider: "openai-api", Model: "official-model"},
	}
	if _, err := NewProfileOperator(config).Sync(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(config.DataRoot, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	want := "base_url: \"http://locho-laptop:11434/v1\"\n    key_env: \"OPENAI_GATEWAY_API_KEY\"\n  - provider: \"openai-api\"\n    model: \"official-model\""
	if !strings.Contains(string(data), want) {
		t.Fatalf("fallback providers were not rendered:\n%s", data)
	}
}

func TestProfileSyncRendersRuntimeProviderAndModel(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	configPath := filepath.Join(repo, "profile", "config.yaml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repo, "profile", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("model:\n  provider: ${OPENLIA_PROVIDER}\n  default: ${OPENLIA_MODEL}\nplugins:\n  entries:\n    openlia-ingestion:\n      settings:\n        max_concurrent_jobs: ${OPENLIA_INGESTION_MAX_CONCURRENT_JOBS}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	config := testConfig(repo, runtime)
	config.Provider = "copilot"
	config.Model = "gpt-5.6-luna"
	config.IngestionMaxConcurrentJobs = 3
	if _, err := NewProfileOperator(config).Sync(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(config.DataRoot, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "${OPENLIA_") || !strings.Contains(text, "provider: copilot") || !strings.Contains(text, "default: gpt-5.6-luna") || !strings.Contains(text, "max_concurrent_jobs: 3") {
		t.Fatalf("runtime config placeholders were not rendered:\n%s", data)
	}
}

func TestProfileSyncUpdatesManagedOutputLanguage(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	for path, contents := range map[string]string{
		filepath.Join(repo, "profile", "SOUL.md"):       "# Soul\n\nProfile guidance.\n\n" + outputLanguageBlockStart + "\nUse `en` as the default language.\n" + outputLanguageBlockEnd + "\n",
		filepath.Join(repo, "profile", "AGENTS.md"):     "agents\n",
		filepath.Join(repo, "profile", "config.yaml"):   "config\n",
		filepath.Join(repo, "release", "manifest.json"): `{"openlia":"test"}`,
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	config := testConfig(repo, runtime)
	if err := os.MkdirAll(filepath.Join(repo, "profile", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	config.OutputLanguage = "en"
	if _, err := NewProfileOperator(config).Sync(); err != nil {
		t.Fatal(err)
	}
	soulPath := filepath.Join(config.DataRoot, "SOUL.md")
	data, err := os.ReadFile(soulPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "Use `en` as the default language") {
		t.Fatalf("default output language was not rendered:\n%s", data)
	}

	config.OutputLanguage = "vi"
	if _, err := NewProfileOperator(config).Sync(); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(soulPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "Use `vi` as the default language") || strings.Contains(string(data), "Use `en` as the default language") {
		t.Fatalf("updated output language was not rendered:\n%s", data)
	}

	if err := os.WriteFile(soulPath, append([]byte("custom guidance\n"), data...), 0o600); err != nil {
		t.Fatal(err)
	}
	config.OutputLanguage = "en"
	if _, err := NewProfileOperator(config).Sync(); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(soulPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "custom guidance") || !strings.Contains(string(data), "Use `en` as the default language") {
		t.Fatalf("custom guidance or updated language was lost:\n%s", data)
	}
}

func TestProfileSyncSeedsMissingWorkspaceTemplatesPreservingExistingFiles(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	for path, contents := range map[string]string{
		filepath.Join(repo, "profile", "SOUL.md"):                                                      "soul\n",
		filepath.Join(repo, "profile", "AGENTS.md"):                                                    "agents\n",
		filepath.Join(repo, "profile", "config.yaml"):                                                  "config\n",
		filepath.Join(repo, "release", "manifest.json"):                                                `{"openlia":"test"}`,
		filepath.Join(repo, "workspace-template", "knowledge", "claims", "claim-template.md"):          "new claim template\n",
		filepath.Join(repo, "workspace-template", "knowledge", "claims", "claim-template.schema.json"): "new claim schema\n",
		filepath.Join(repo, "workspace-template", "goals", "goal-template.md"):                         "default goal template\n",
		filepath.Join(repo, "workspace-template", "goals", "goal-template.schema.json"):                "default goal schema\n",
		filepath.Join(repo, "workspace-template", "tasks", "task-template.md"):                         "default task template\n",
		filepath.Join(repo, "workspace-template", "tasks", "task-template.schema.json"):                "default task schema\n",
		filepath.Join(repo, "workspace-template", "existing.md"):                                       "template original\n",
		filepath.Join(repo, "workspace-template", "AGENTS.md"):                                         "agents template\n",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(repo, "profile", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := testConfig(repo, runtime)
	memoriesDir := filepath.Join(config.DataRoot, "memories")
	if err := os.MkdirAll(memoriesDir, 0o700); err != nil {
		t.Fatal(err)
	}
	userMemFile := filepath.Join(memoriesDir, "USER.md")
	if err := os.WriteFile(userMemFile, []byte("Name: Existing User.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(config.DataRoot, "workspace")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	existingUserFile := filepath.Join(workspace, "existing.md")
	if err := os.WriteFile(existingUserFile, []byte("user customized content\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	legacyTemplate := filepath.Join(workspace, "knowledge", "claim-record.md")
	if err := os.MkdirAll(filepath.Dir(legacyTemplate), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyTemplate, []byte("legacy user template\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	customSchema := filepath.Join(workspace, "goals", "goal-template.schema.json")
	if err := os.MkdirAll(filepath.Dir(customSchema), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(customSchema, []byte("user customized schema\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	customTemplate := filepath.Join(workspace, "tasks", "task-template.md")
	if err := os.MkdirAll(filepath.Dir(customTemplate), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(customTemplate, []byte("user customized template\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	p := NewProfileOperator(config)
	p.Now = func() time.Time { return time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC) }
	if _, err := p.Sync(); err != nil {
		t.Fatalf("Sync() failed: %v", err)
	}

	// 1. Newly introduced template file should be seeded
	seededFile := filepath.Join(workspace, "knowledge", "claims", "claim-template.md")
	seededData, err := os.ReadFile(seededFile)
	if err != nil {
		t.Fatalf("missing seeded template file: %v", err)
	}
	if string(seededData) != "new claim template\n" {
		t.Fatalf("unexpected seeded template data: %q", string(seededData))
	}
	seededSchema, err := os.ReadFile(filepath.Join(workspace, "knowledge", "claims", "claim-template.schema.json"))
	if err != nil || string(seededSchema) != "new claim schema\n" {
		t.Fatalf("missing seeded claim schema: %q, %v", seededSchema, err)
	}
	seededGoalTemplate, err := os.ReadFile(filepath.Join(workspace, "goals", "goal-template.md"))
	if err != nil || string(seededGoalTemplate) != "default goal template\n" {
		t.Fatalf("missing default goal template: %q, %v", seededGoalTemplate, err)
	}
	preservedSchema, err := os.ReadFile(customSchema)
	if err != nil || string(preservedSchema) != "user customized schema\n" {
		t.Fatalf("custom goal schema was overwritten: %q, %v", preservedSchema, err)
	}
	seededTaskSchema, err := os.ReadFile(filepath.Join(workspace, "tasks", "task-template.schema.json"))
	if err != nil || string(seededTaskSchema) != "default task schema\n" {
		t.Fatalf("missing default task schema: %q, %v", seededTaskSchema, err)
	}
	preservedTemplate, err := os.ReadFile(customTemplate)
	if err != nil || string(preservedTemplate) != "user customized template\n" {
		t.Fatalf("custom task template was overwritten: %q, %v", preservedTemplate, err)
	}
	legacyData, err := os.ReadFile(legacyTemplate)
	if err != nil || string(legacyData) != "legacy user template\n" {
		t.Fatalf("existing legacy template was not preserved: %q, %v", legacyData, err)
	}

	// 2. Existing user file must be preserved intact without overwrite
	existingData, err := os.ReadFile(existingUserFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(existingData) != "user customized content\n" {
		t.Fatalf("existing user file was overwritten! got: %q", string(existingData))
	}

	// 3. Hermes owns runtime memory; profile sync must not seed USER.md.
	userData, err := os.ReadFile(userMemFile)
	if err != nil {
		t.Fatalf("user memory file was not preserved: %v", err)
	}
	if string(userData) != "Name: Existing User.\n" {
		t.Fatalf("profile sync changed Hermes-owned USER.md: %q", string(userData))
	}
}

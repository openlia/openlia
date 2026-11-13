package operator

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProfileSyncSeedsAndPreservesInstructionFiles(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	for path, contents := range map[string]string{
		filepath.Join(repo, "profile", "SOUL.md"):       "# Soul\n\n" + outputLanguageBlockStart + "\nUse `en` as the default language.\n" + outputLanguageBlockEnd + "\n",
		filepath.Join(repo, "profile", "AGENTS.md"):     "# Agents\n",
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
	p := NewProfileOperator(config)
	p.Now = func() time.Time { return time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC) }
	if _, err := p.Sync(); err != nil {
		t.Fatal(err)
	}
	agentsPath := filepath.Join(config.DataRoot, "AGENTS.md")
	if err := os.WriteFile(agentsPath, []byte("# Custom Agents\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Sync(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(agentsPath)
	if err != nil || string(data) != "# Custom Agents\n" {
		t.Fatalf("existing AGENTS.md was overwritten: %q, err=%v", data, err)
	}
}

func TestProfileSyncRendersFallbackProvidersAndRuntimeSettings(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	for path, contents := range map[string]string{
		filepath.Join(repo, "profile", "SOUL.md"):   "soul\n",
		filepath.Join(repo, "profile", "AGENTS.md"): "agents\n",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	config := testConfig(repo, runtime)
	config.Provider = "copilot"
	config.Model = "gpt-5.6-luna"
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
	text := string(data)
	for _, want := range []string{
		"provider: \"copilot\"",
		"default: \"gpt-5.6-luna\"",
		"enabled: true",
		"command: \"/usr/local/bin/openlia-secret-source\"",
		"base_url: \"http://locho-laptop:11434/v1\"",
		"key_env: \"OPENAI_GATEWAY_API_KEY\"",
		"provider: \"openai-api\"",
		"model: \"official-model\"",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("config.yaml missing %q:\n%s", want, text)
		}
	}
}

func TestRenderFallbackBlockReplacesInlineAndStaleFallbackDeclarations(t *testing.T) {
	providers := []FallbackProviderConfig{{Provider: "custom", Model: "gateway-model"}}
	for _, data := range [][]byte{
		[]byte("fallback_providers: []\nmodel:\n  provider: copilot\n" + fallbackBlockStart + "\nfallback_providers: []\n" + fallbackBlockEnd + "\n"),
		[]byte("fallback_providers:\n  - provider: stale\n" + fallbackBlockStart + "\nfallback_providers: []\n" + fallbackBlockEnd + "\n"),
	} {
		updated, err := renderFallbackBlock(data, providers)
		if err != nil {
			t.Fatal(err)
		}
		text := string(updated)
		if strings.Count(text, "fallback_providers:") != 1 {
			t.Fatalf("expected one fallback_providers declaration, got:\n%s", text)
		}
		if !strings.Contains(text, fallbackBlockStart) || !strings.Contains(text, fallbackBlockEnd) || !strings.Contains(text, "provider: \"custom\"\n    model: \"gateway-model\"") {
			t.Fatalf("fallback providers or managed markers were not rendered:\n%s", text)
		}
	}
}

func TestProfileSyncUpdatesManagedOutputLanguage(t *testing.T) {
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	for path, contents := range map[string]string{
		filepath.Join(repo, "profile", "SOUL.md"):       "# Soul\n\nProfile guidance.\n\n" + outputLanguageBlockStart + "\nUse `en` as the default language.\n" + outputLanguageBlockEnd + "\n",
		filepath.Join(repo, "profile", "AGENTS.md"):     "agents\n",
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

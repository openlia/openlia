package operator

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProvisionRequiredToolsAndReprovisionOnRestore(t *testing.T) {
	tmp := t.TempDir()
	cfg := Config{
		RepositoryRoot: tmp,
		DataRoot:       filepath.Join(tmp, "hermes"),
		MetaRoot:       filepath.Join(tmp, "meta"),
	}

	provisioned, err := ProvisionRequiredTools(cfg, []string{"hledger", "remind"}, "feature:personal-finance")
	if err != nil {
		t.Fatalf("ProvisionRequiredTools failed: %v", err)
	}
	if len(provisioned) != 2 {
		t.Fatalf("expected 2 provisioned tools, got %v", provisioned)
	}

	for _, bin := range []string{"hledger", "remind"} {
		exposed := filepath.Join(cfg.DataRoot, ".local", "bin", bin)
		info, err := os.Stat(exposed)
		if err != nil {
			t.Fatalf("expected %s in .local/bin: %v", bin, err)
		}
		if info.Mode()&0o111 == 0 {
			t.Fatalf("expected %s to be executable, mode=%v", bin, info.Mode())
		}
	}

	state, err := LoadLocalToolsState(cfg.DataRoot)
	if err != nil {
		t.Fatalf("LoadLocalToolsState: %v", err)
	}
	if _, ok := state.Tools["hledger"]; !ok {
		t.Fatalf("expected hledger in state.json, got %+v", state.Tools)
	}

	// Simulate backup restore where .local/tools and .local/bin were excluded
	_ = os.RemoveAll(filepath.Join(cfg.DataRoot, ".local", "tools"))
	_ = os.RemoveAll(filepath.Join(cfg.DataRoot, ".local", "bin"))

	if err := ReprovisionLocalStore(cfg); err != nil {
		t.Fatalf("ReprovisionLocalStore failed: %v", err)
	}
	for _, bin := range []string{"hledger", "remind"} {
		if _, err := os.Stat(filepath.Join(cfg.DataRoot, ".local", "bin", bin)); err != nil {
			t.Fatalf("expected %s to be re-materialized after ReprovisionLocalStore: %v", bin, err)
		}
	}
}

func TestProvisionSkillEnvironmentFromFrontmatter(t *testing.T) {
	tmp := t.TempDir()
	cfg := Config{
		RepositoryRoot: tmp,
		DataRoot:       filepath.Join(tmp, "hermes"),
		MetaRoot:       filepath.Join(tmp, "meta"),
	}
	skillDir := filepath.Join(cfg.DataRoot, "skills", "custom-analytics")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	skillMD := "---\nname: custom-analytics\nrequires:\n  tools:\n    - jq\n    - sqlite3\n  python: requirements.txt\n---\n# Custom Analytics\n"
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(skillMD), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "requirements.txt"), []byte("pyyaml>=6.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := ProvisionSkillEnvironment(cfg, "custom-analytics", skillDir, "", ""); err != nil {
		t.Fatalf("ProvisionSkillEnvironment failed: %v", err)
	}

	state, err := LoadLocalToolsState(cfg.DataRoot)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := state.Tools["jq"]; !ok {
		t.Fatalf("expected jq in state.Tools")
	}
	if _, ok := state.Tools["sqlite3"]; !ok {
		t.Fatalf("expected sqlite3 in state.Tools")
	}
	if envRec, ok := state.Envs["custom-analytics"]; !ok || envRec.PythonManifest != "requirements.txt" {
		t.Fatalf("unexpected env record: %+v", envRec)
	}
}

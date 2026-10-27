package operator

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSyncTemplatesCatalogAndThreeWaySkillRebase(t *testing.T) {
	tmp := t.TempDir()
	templatesDir := filepath.Join(tmp, "templates")
	skillSrc := filepath.Join(templatesDir, "skills", "custom-skill")
	if err := os.MkdirAll(skillSrc, 0o755); err != nil {
		t.Fatal(err)
	}
	v1Content := "---\nname: custom-skill\n---\n# Custom Skill\n\nLine 1\nLine 2\nLine 3\n"
	if err := os.WriteFile(filepath.Join(skillSrc, "SKILL.md"), []byte(v1Content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(templatesDir, "features"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(templatesDir, "profiles"), 0o755); err != nil {
		t.Fatal(err)
	}

	cfg := Config{
		RepositoryRoot: filepath.Join(tmp, "repo"),
		DataRoot:       filepath.Join(tmp, "hermes"),
		MetaRoot:       filepath.Join(tmp, "meta"),
		TemplatesRepo:  templatesDir,
	}
	if err := os.MkdirAll(cfg.RepositoryRoot, 0o755); err != nil {
		t.Fatal(err)
	}

	syncRes, err := SyncTemplatesCatalog(context.Background(), cfg)
	if err != nil {
		t.Fatalf("SyncTemplatesCatalog failed: %v", err)
	}
	if !syncRes.OK || syncRes.SkillsCount != 1 {
		t.Fatalf("unexpected sync result: %+v", syncRes)
	}

	// Install skill v1
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	prof := NewProfileOperator(cfg)
	prof.Now = func() time.Time { return now }
	if err := EnsureDir(filepath.Join(cfg.DataRoot, "skills"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDir(filepath.Join(cfg.MetaRoot, "managed", "skills"), 0o700); err != nil {
		t.Fatal(err)
	}
	dstSkill := filepath.Join(cfg.DataRoot, "skills", "custom-skill")
	metaPath := filepath.Join(cfg.MetaRoot, "managed", "skills", "custom-skill.json")
	if _, err := prof.syncSkill(skillSrc, dstSkill, metaPath, "custom-skill", "0.1.0", "catalog"); err != nil {
		t.Fatalf("syncSkill v1: %v", err)
	}

	// User edits Line 3 in installed skill (without running `skills fork` manually)
	userContent := "---\nname: custom-skill\n---\n# Custom Skill\n\nLine 1\nLine 2\nLine 3 (user edit)\n"
	if err := os.WriteFile(filepath.Join(dstSkill, "SKILL.md"), []byte(userContent), 0o644); err != nil {
		t.Fatal(err)
	}

	// Upstream updates Line 1 in templates catalog
	v2Content := "---\nname: custom-skill\n---\n# Custom Skill\n\nLine 1 (upstream v2)\nLine 2\nLine 3\n"
	if err := os.WriteFile(filepath.Join(skillSrc, "SKILL.md"), []byte(v2Content), 0o644); err != nil {
		t.Fatal(err)
	}

	// RebaseInstalledSkill should auto-detect fork and cleanly 3-way merge Line 1 + Line 3!
	rebaseRes, err := RebaseInstalledSkill(cfg, "custom-skill", now.Add(time.Minute))
	if err != nil {
		t.Fatalf("RebaseInstalledSkill failed: %v", err)
	}
	if !rebaseRes.AutoForked || rebaseRes.Status != "merged" {
		t.Fatalf("expected auto_forked=true and status=merged, got %+v", rebaseRes)
	}

	mergedBytes, err := os.ReadFile(filepath.Join(dstSkill, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	wantMerged := "---\nname: custom-skill\n---\n# Custom Skill\n\nLine 1 (upstream v2)\nLine 2\nLine 3 (user edit)\n"
	if string(mergedBytes) != wantMerged {
		t.Fatalf("merged content mismatch:\ngot:\n%s\nwant:\n%s", string(mergedBytes), wantMerged)
	}

	// Now create an overlapping conflict on Line 3
	v3Content := "---\nname: custom-skill\n---\n# Custom Skill\n\nLine 1 (upstream v2)\nLine 2\nLine 3 (upstream conflicting edit)\n"
	if err := os.WriteFile(filepath.Join(skillSrc, "SKILL.md"), []byte(v3Content), 0o644); err != nil {
		t.Fatal(err)
	}
	conflictRes, err := RebaseInstalledSkill(cfg, "custom-skill", now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("RebaseInstalledSkill conflict run failed: %v", err)
	}
	if conflictRes.Status != "conflict" || len(conflictRes.Conflicts) != 1 || conflictRes.Conflicts[0] != "SKILL.md" {
		t.Fatalf("expected conflict on SKILL.md, got %+v", conflictRes)
	}
	if _, err := os.Stat(filepath.Join(conflictRes.MigrationContext, "context.json")); err != nil {
		t.Fatalf("expected conflict context.json to be staged: %v", err)
	}
}

package operator

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestForkPreservesCustomizedSkillAcrossProfileUpdate(t *testing.T) {
	config, now := migrationTestConfig(t)
	profile := NewProfileOperator(config)
	if _, err := profile.Sync(); err != nil {
		t.Fatal(err)
	}
	active := filepath.Join(config.DataRoot, "skills", "example", "SKILL.md")
	if err := os.WriteFile(active, []byte("user fork\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := ForkSkill(config, "example", now)
	if err != nil {
		t.Fatal(err)
	}
	if result.Ownership != "forked" {
		t.Fatalf("ownership = %q, want forked", result.Ownership)
	}
	if err := os.WriteFile(filepath.Join(config.RepositoryRoot, "profile", "skills", "example", "SKILL.md"), []byte("upstream v2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	syncResult, err := profile.Sync()
	if err != nil {
		t.Fatal(err)
	}
	if syncResult.Skills.Forked != 1 || syncResult.Skills.UpdatesAvailable != 1 {
		t.Fatalf("unexpected fork sync result: %+v", syncResult.Skills)
	}
	if _, err := os.Stat(filepath.Join(config.DataRoot, ".openlia", "migrations", "example", "context.json")); err != nil {
		t.Fatalf("migration context was not staged: %v", err)
	}
	contents, err := os.ReadFile(active)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "user fork\n" {
		t.Fatalf("active fork was overwritten: %q", contents)
	}
}

func TestProtectedSystemSkillsCannotBeForkedOrTampered(t *testing.T) {
	for _, name := range []string{protectedSkillName, workspaceTemplateSkillName, inlineOpenUISkillName, minionAuthoringSkillName} {
		t.Run(name, func(t *testing.T) {
			config, now := migrationTestConfig(t)
			systemSkill := filepath.Join(config.RepositoryRoot, "profile", "system-skills", name, "SKILL.md")
			if err := os.MkdirAll(filepath.Dir(systemSkill), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(systemSkill, []byte("system\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := NewProfileOperator(config).Sync(); err != nil {
				t.Fatal(err)
			}
			if _, err := ForkSkill(config, name, now); err == nil {
				t.Fatal("protected system skill was forked")
			}
			protectedPath := filepath.Join(config.SystemSkillsRoot, name, "SKILL.md")
			if _, err := os.Stat(protectedPath); err != nil {
				t.Fatalf("protected skill was not synchronized: %v", err)
			}
			if err := os.WriteFile(protectedPath, []byte("tampered\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := NewProfileOperator(config).Sync(); err != nil {
				t.Fatal(err)
			}
			contents, err := os.ReadFile(protectedPath)
			if err != nil {
				t.Fatal(err)
			}
			if string(contents) != "system\n" {
				t.Fatalf("protected skill was not restored: %q", contents)
			}
		})
	}
}

func TestApplySkillMigrationUpdatesForkAndLineage(t *testing.T) {
	config, now := migrationTestConfig(t)
	profile := NewProfileOperator(config)
	if _, err := profile.Sync(); err != nil {
		t.Fatal(err)
	}
	active := filepath.Join(config.DataRoot, "skills", "example", "SKILL.md")
	if err := os.WriteFile(active, []byte("user fork\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ForkSkill(config, "example", now); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(config.RepositoryRoot, "profile", "skills", "example", "SKILL.md")
	if err := os.WriteFile(source, []byte("upstream v2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	contextResult, err := PrepareSkillMigration(config, "example", now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	proposalRoot := filepath.Join(config.DataRoot, ".openlia", "proposals", "proposal-1")
	if err := os.MkdirAll(proposalRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	newBase := filepath.Join(contextResult.Context, "new-base")
	proposed := filepath.Join(proposalRoot, "proposed")
	if err := CopyDir(newBase, proposed); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proposed, "SKILL.md"), []byte("upstream v2\nuser customization\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	patch, err := GenerateSkillPatch(newBase, proposed, "example")
	if err != nil {
		t.Fatal(err)
	}
	patchPath := filepath.Join(proposalRoot, "customization.patch")
	patchHash, err := WriteSkillPatch(patchPath, patch)
	if err != nil {
		t.Fatal(err)
	}
	proposedHash, err := DirectorySHA256(proposed)
	if err != nil {
		t.Fatal(err)
	}
	contextData, err := os.ReadFile(filepath.Join(contextResult.Context, "context.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contextDetails SkillMigrationContext
	if err := json.Unmarshal(contextData, &contextDetails); err != nil {
		t.Fatal(err)
	}
	proposal := SkillMigrationProposal{
		Schema:           migrationProtocolSchema,
		ID:               "proposal-1",
		Skill:            "example",
		State:            "pending",
		OldBaseHash:      contextDetails.OldBaseHash,
		CurrentForkHash:  contextDetails.CurrentForkHash,
		OldPatchHash:     contextDetails.CurrentPatchHash,
		NewBaseHash:      contextDetails.NewBaseHash,
		NewPatchHash:     patchHash,
		ProposedForkHash: "sha256:" + proposedHash,
		CreatedAt:        utcTimestamp(now),
	}
	proposalData, err := json.Marshal(proposal)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proposalRoot, "proposal.json"), append(proposalData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := ApplySkillMigration(config, "proposal-1", now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "applied" {
		t.Fatalf("migration state = %q, want applied", result.State)
	}
	contents, err := os.ReadFile(active)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "upstream v2\nuser customization\n" {
		t.Fatalf("migrated skill = %q", contents)
	}
	metadata, err := readFullSkillMetadata(filepath.Join(config.MetaRoot, "managed", "skills", "example.json"), "example")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Ownership != "forked" || metadata.ForkSHA256 != result.ForkHash || metadata.PatchSHA256 != result.PatchHash {
		t.Fatalf("metadata was not updated: %+v", metadata)
	}
}

func migrationTestConfig(t *testing.T) (Config, time.Time) {
	t.Helper()
	repo := t.TempDir()
	runtime := filepath.Join(t.TempDir(), "runtime")
	for path, contents := range map[string]string{
		filepath.Join(repo, "profile", "SOUL.md"):                       "soul\n",
		filepath.Join(repo, "profile", "AGENTS.md"):                     "agents\n",
		filepath.Join(repo, "profile", "config.yaml"):                   "config\n",
		filepath.Join(repo, "profile", "skills", "example", "SKILL.md"): "base\n",
		filepath.Join(repo, "release", "manifest.json"):                 `{"openlia":"test"}`,
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return testConfig(repo, runtime), time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC)
}

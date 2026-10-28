package operator

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestTemplatesCompleteYAMLContract(t *testing.T) {
	data, err := os.ReadFile("../tests/fixtures/templates/feature-flow.yaml")
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := ParseFeatureManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Skills) != 1 || len(manifest.Domains) != 1 || len(manifest.Requires.Tools) != 1 || manifest.Requires.Python != "requirements.txt" || manifest.Requires.Bun != "package.json" || !manifest.Domains[0].IncludeInBriefing || !reflect.DeepEqual(manifest.Policy.AllowedDomains, manifest.Skills[0].WorkspaceDomains) {
		t.Fatalf("fields were dropped: %+v", manifest)
	}
	block, err := ParseFeatureManifest(RenderFeatureManifest(manifest))
	flowJSON, _ := json.Marshal(manifest)
	blockJSON, _ := json.Marshal(block)
	if err != nil || string(flowJSON) != string(blockJSON) {
		t.Fatalf("flow/block mismatch: %+v %v", block, err)
	}
	profile, err := ParseProfileManifest([]byte("schema: 1\nid: example\nfeatures: [yaml-contract]\nskills: [yaml-child]\nrequires: {tools: [remind], openlia: '>=0.1.0'}\ninstructions: {soul: SOUL.md, workspace_agents: WORKSPACE_AGENTS.md}\n"))
	if err != nil || profile.Instructions.WorkspaceAgents != "WORKSPACE_AGENTS.md" || len(profile.Requires.Tools) != 1 {
		t.Fatalf("profile flow fields lost: %+v %v", profile, err)
	}
	if _, err := ParseProfileManifest([]byte("id: unsafe\ninstructions: {soul: '../../outside'}\n")); err == nil {
		t.Fatal("profile instruction traversal accepted")
	}
	for _, invalid := range []string{"requires: {tools: remind}\n", "skills: [{id: 12, path: skills/child}]\n", "requires: {python: [requests]}\n"} {
		if _, err := ParseFeatureManifest([]byte(compatibilityFeature("invalid", invalid))); err == nil {
			t.Fatalf("accepted invalid typed declaration %q", invalid)
		}
	}
	dir := t.TempDir()
	writeCompatibilityFixture(t, filepath.Join(dir, "SKILL.md"), "---\nname: example\ndescription: Example\nrequires: {tools: [remind], python: requirements.txt, bun: package.json}\n---\nTest\n")
	requirements, err := readSkillRequirements(dir)
	if err != nil || len(requirements.Tools) != 1 || requirements.Python != "requirements.txt" {
		t.Fatalf("skill flow fields lost: %+v %v", requirements, err)
	}
}

func TestTemplatesPreservedSkillsKeepInstalledProvenance(t *testing.T) {
	for _, mode := range []string{"forked", "customized"} {
		t.Run(mode, func(t *testing.T) {
			cfg, _ := setupLeanWorkspaceForTest(t)
			valid := testConfig(cfg.RepositoryRoot, filepath.Dir(cfg.DataRoot))
			valid.DataRoot, valid.MetaRoot = cfg.DataRoot, cfg.MetaRoot
			cfg = valid
			first, err := SkillInstall(cfg, "personal-finance", time.Now())
			if err != nil {
				t.Fatal(err)
			}
			active := filepath.Join(cfg.DataRoot, "skills/personal-finance/SKILL.md")
			writeCompatibilityFixture(t, active, "user customization\n")
			if mode == "forked" {
				if _, err := ForkSkill(cfg, "personal-finance", time.Now()); err != nil {
					t.Fatal(err)
				}
			}
			metaPath := filepath.Join(cfg.MetaRoot, "managed/skills/personal-finance.json")
			before, err := os.ReadFile(metaPath)
			if err != nil {
				t.Fatal(err)
			}
			source := filepath.Join(ResolveTemplatesRoot(cfg), "features/personal-finance/skills/personal-finance/SKILL.md")
			writeCompatibilityFixture(t, source, "upstream v2\n")
			result, err := SkillInstall(cfg, "personal-finance", time.Now())
			if err != nil {
				t.Fatal(err)
			}
			want := "blocked"
			if mode == "forked" {
				want = "update_available"
			}
			if result.Outcome != want || result.Catalog.ContentSHA256 != first.Catalog.ContentSHA256 || result.AvailableCatalog.ContentSHA256 == first.Catalog.ContentSHA256 {
				t.Fatalf("incorrect installed/available provenance: %+v", result)
			}
			after, err := os.ReadFile(metaPath)
			if err != nil || string(before) != string(after) {
				t.Fatal("preserved skill provenance advanced")
			}
			content, err := os.ReadFile(active)
			if err != nil || string(content) != "user customization\n" {
				t.Fatal("preserved skill content changed")
			}
			feature, err := FeatureInstall(cfg, "personal-finance", false, time.Now())
			if err != nil || len(feature.SkillResults) != 1 || feature.SkillResults[0].Action != want {
				t.Fatalf("feature install hid preserved skill outcome: %+v %v", feature, err)
			}
			after, _ = os.ReadFile(metaPath)
			if string(before) != string(after) {
				t.Fatal("feature install advanced preserved skill provenance")
			}
		})
	}
}

func TestTemplatesActivationRecoveryBoundaries(t *testing.T) {
	for _, phase := range []string{"before-old-rename", "after-old-rename", "after-new-rename", "after-rollback-rename", "initial-stage", "initial-activated"} {
		t.Run(phase, func(t *testing.T) {
			meta := t.TempDir()
			cache, stage, previous := filepath.Join(meta, "templates-cache"), filepath.Join(meta, ".templates-stage-test"), filepath.Join(meta, ".templates-previous-test")
			writeSyncCatalog(t, stage, "2.0.0")
			newHash, err := templatesTreeHash(stage)
			if err != nil {
				t.Fatal(err)
			}
			journal := catalogActivation{Schema: 1, Stage: filepath.Base(stage), NewHash: newHash}
			if !strings.HasPrefix(phase, "initial") {
				writeSyncCatalog(t, cache, "1.0.0")
				journal.OldHash, err = templatesTreeHash(cache)
				if err != nil {
					t.Fatal(err)
				}
				journal.Previous = filepath.Base(previous)
			}
			if err := writeCatalogState(meta, catalogActivationFile, journal); err != nil {
				t.Fatal(err)
			}
			if phase == "after-old-rename" || phase == "after-new-rename" || phase == "after-rollback-rename" {
				if err := os.Rename(cache, previous); err != nil {
					t.Fatal(err)
				}
			}
			if phase == "after-new-rename" || phase == "initial-activated" {
				if err := os.Rename(stage, cache); err != nil {
					t.Fatal(err)
				}
			}
			if phase == "after-rollback-rename" {
				if err := os.Rename(previous, cache); err != nil {
					t.Fatal(err)
				}
				if err := os.RemoveAll(stage); err != nil {
					t.Fatal(err)
				}
			}
			if err := recoverTemplatesCatalog(Config{MetaRoot: meta}); err != nil {
				t.Fatal(err)
			}
			want := "version 1.0.0"
			if phase == "after-new-rename" || strings.HasPrefix(phase, "initial") {
				want = "version 2.0.0"
			}
			content, err := os.ReadFile(filepath.Join(cache, "features/example/workspace/example/note.md"))
			if err != nil || string(content) != want {
				t.Fatalf("recovery failed: %q %v", content, err)
			}
			if _, err := os.Stat(filepath.Join(meta, catalogActivationFile)); !os.IsNotExist(err) {
				t.Fatal("activation journal was not retired")
			}
			if _, err := os.Stat(stage); !os.IsNotExist(err) {
				t.Fatal("journal-owned stage leaked")
			}
			if err := recoverTemplatesCatalog(Config{MetaRoot: meta}); err != nil {
				t.Fatal("recovery must be idempotent")
			}
		})
	}
}

func TestTemplatesUIRefreshPersistsUntilVerified(t *testing.T) {
	source := t.TempDir()
	writeSyncCatalog(t, source, "1.0.0")
	cfg := syncConfigTest(t, source)
	if _, err := SyncTemplatesCatalog(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	writeSyncCatalog(t, source, "2.0.0")
	changed, err := SyncTemplatesCatalog(context.Background(), cfg)
	if err != nil || !changed.UIRefreshRequired {
		t.Fatalf("missing pending refresh: %+v %v", changed, err)
	}
	repeated, err := SyncTemplatesCatalog(context.Background(), cfg)
	if err != nil || !repeated.UIRefreshRequired || repeated.PreviousCacheDir != changed.PreviousCacheDir {
		t.Fatalf("unchanged sync hid outstanding refresh: %+v %v", repeated, err)
	}
	dir := t.TempDir()
	docker := filepath.Join(dir, "docker")
	data, _ := json.Marshal(changed.Catalog)
	writeCompatibilityFixture(t, docker, fmt.Sprintf("#!/bin/sh\ncase \"$*\" in\n*'/templates-cache/.openlia-catalog.json') printf '%%s' '%s';;\n*) exit 9;;\nesac\n", data))
	if err := os.Chmod(docker, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	cfg.WorkspaceUIHost = "127.0.0.1"
	verified, err := SyncTemplatesCatalog(context.Background(), cfg)
	if err != nil || verified.UIRefreshRequired {
		t.Fatalf("current mounted generation was not acknowledged: %+v %v", verified, err)
	}
}

func TestTemplatesRecoveryRejectsUnknownOrModifiedStages(t *testing.T) {
	for _, unsafe := range []bool{false, true} {
		t.Run(fmt.Sprint(unsafe), func(t *testing.T) {
			meta := t.TempDir()
			cache := filepath.Join(meta, "templates-cache")
			stage := filepath.Join(meta, ".templates-stage-test")
			writeSyncCatalog(t, cache, "1.0.0")
			writeSyncCatalog(t, stage, "2.0.0")
			oldHash, _ := templatesTreeHash(cache)
			newHash, _ := templatesTreeHash(stage)
			journal := catalogActivation{Schema: 1, Stage: filepath.Base(stage), Previous: ".templates-previous-test", OldHash: oldHash, NewHash: newHash}
			if unsafe {
				journal.Stage = "../outside"
			} else {
				writeCompatibilityFixture(t, filepath.Join(stage, "changed.txt"), "preserve for inspection")
			}
			if err := writeCatalogState(meta, catalogActivationFile, journal); err != nil {
				t.Fatal(err)
			}
			if err := recoverTemplatesCatalog(Config{MetaRoot: meta}); err == nil {
				t.Fatal("unsafe/modified activation was accepted")
			}
			if hash, err := templatesTreeHash(cache); err != nil || hash != oldHash {
				t.Fatal("failed recovery changed active data")
			}
			if _, err := os.Stat(stage); err != nil {
				t.Fatal("failed recovery deleted an unknown/modified stage")
			}
		})
	}
}

func TestTemplatesSnapshotPruningRequiresExplicitConfirmation(t *testing.T) {
	source := t.TempDir()
	writeSyncCatalog(t, source, "1.0.0")
	cfg := syncConfigTest(t, source)
	for i := 1; i <= 5; i++ {
		writeSyncCatalog(t, source, fmt.Sprintf("%d.0.0", i))
		if _, err := SyncTemplatesCatalog(context.Background(), cfg); err != nil {
			t.Fatal(err)
		}
	}
	unknown := filepath.Join(cfg.MetaRoot, ".templates-previous-user-owned")
	writeCompatibilityFixture(t, filepath.Join(unknown, "note.txt"), "preserve")
	if _, err := PruneTemplatesCatalogSnapshots(context.Background(), cfg, 2, false); err == nil {
		t.Fatal("pruning must require explicit unmounted confirmation")
	}
	result, err := PruneTemplatesCatalogSnapshots(context.Background(), cfg, 2, true)
	if err != nil || len(result.Removed) != 2 || len(result.Skipped) != 1 || result.Retained != 3 {
		t.Fatalf("unexpected retention result: %+v %v", result, err)
	}
	if _, err := os.Stat(filepath.Join(unknown, "note.txt")); err != nil {
		t.Fatal("unknown snapshot was deleted")
	}
}

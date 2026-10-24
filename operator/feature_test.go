package operator

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"openlia/operator/migration"
	"openlia/operator/migration/propgit"
	"openlia/operator/migration/runner"
)

func setupLeanWorkspaceForTest(t *testing.T) (Config, string) {
	t.Helper()
	repoRoot, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	tmpDir := t.TempDir()
	dataRoot := filepath.Join(tmpDir, "data")
	metaRoot := filepath.Join(tmpDir, "meta")
	wsDir := filepath.Join(dataRoot, "workspace")
	if err := EnsureDir(wsDir, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	if err := EnsureDir(filepath.Join(dataRoot, "skills"), 0o700); err != nil {
		t.Fatalf("mkdir skills: %v", err)
	}
	if err := EnsureDir(metaRoot, 0o700); err != nil {
		t.Fatalf("mkdir meta: %v", err)
	}

	templateRoot := filepath.Join(repoRoot, "workspace-template")
	if err := copyDirectoryContents(templateRoot, wsDir); err != nil {
		t.Fatalf("copy workspace-template: %v", err)
	}

	cfg := Config{
		RepositoryRoot: repoRoot,
		DataRoot:       dataRoot,
		MetaRoot:       metaRoot,
	}
	return cfg, wsDir
}

func copyDirectoryContents(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, path)
		if err != nil || rel == "." {
			return nil
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return EnsureDir(target, 0o700)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := EnsureDir(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o600)
	})
}

func TestFeatureListInstallAndRemove(t *testing.T) {
	cfg, wsDir := setupLeanWorkspaceForTest(t)
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

	// 1. Verify initial Lean Base has 11 domains (7 core + 4 system extensions)
	regPaths, err := RegisteredDomainPaths(wsDir)
	if err != nil {
		t.Fatalf("RegisteredDomainPaths: %v", err)
	}
	if len(regPaths) != 11 {
		t.Fatalf("expected 11 lean base domains, got %d: %v", len(regPaths), regPaths)
	}
	if regPaths["finance"] || regPaths["travel"] {
		t.Fatalf("did not expect finance or travel in lean base")
	}

	// 2. List catalog features
	listRes, err := FeatureList(cfg)
	if err != nil {
		t.Fatalf("FeatureList: %v", err)
	}
	if len(listRes.Features) != 10 {
		t.Fatalf("expected 10 catalog features, got %d", len(listRes.Features))
	}
	for _, f := range listRes.Features {
		if f.State != "available" {
			t.Errorf("expected feature %s to be available initially, got %s", f.ID, f.State)
		}
	}

	// 3. Install personal-finance and travel
	finRes, err := FeatureInstall(cfg, "personal-finance", true, now)
	if err != nil {
		t.Fatalf("FeatureInstall personal-finance: %v", err)
	}
	if !finRes.OK || len(finRes.InstalledSkills) != 1 || finRes.InstalledSkills[0] != "personal-finance" {
		t.Fatalf("unexpected personal-finance install result: %+v", finRes)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataRoot, "skills", "personal-finance", "SKILL.md")); err != nil {
		t.Errorf("expected personal-finance SKILL.md to be installed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(wsDir, "finance", "intake", "intake-template.md")); err != nil {
		t.Errorf("expected finance/intake/intake-template.md starter file: %v", err)
	}

	travelRes, err := FeatureInstall(cfg, "travel", true, now)
	if err != nil {
		t.Fatalf("FeatureInstall travel: %v", err)
	}
	if !travelRes.OK {
		t.Fatalf("expected travel install OK")
	}
	if _, err := os.Stat(filepath.Join(wsDir, "travel", "trip-template.schema.json")); err != nil {
		t.Errorf("expected travel/trip-template.schema.json to be seeded: %v", err)
	}

	regAfter, err := RegisteredDomainPaths(wsDir)
	if err != nil {
		t.Fatalf("RegisteredDomainPaths after install: %v", err)
	}
	if !regAfter["finance"] || !regAfter["finance/intake"] || !regAfter["travel"] {
		t.Fatalf("expected finance, finance/intake, and travel to be registered, got %v", regAfter)
	}

	policyBytes, err := os.ReadFile(filepath.Join(wsDir, "assistant-policy.yaml"))
	if err != nil {
		t.Fatalf("read assistant-policy.yaml: %v", err)
	}
	if !strings.Contains(string(policyBytes), "- finance") || !strings.Contains(string(policyBytes), "record_financial_data") {
		t.Errorf("expected assistant-policy.yaml to include finance and record_financial_data:\n%s", string(policyBytes))
	}

	// 4. Write a user record in travel/ and remove the travel feature
	userTripPath := filepath.Join(wsDir, "travel", "2026-kyoto.md")
	if err := os.WriteFile(userTripPath, []byte("# Kyoto Trip\n"), 0o600); err != nil {
		t.Fatalf("write user trip: %v", err)
	}
	remRes, err := FeatureRemove(cfg, "travel", now)
	if err != nil {
		t.Fatalf("FeatureRemove travel: %v", err)
	}
	if !remRes.OK {
		t.Fatalf("FeatureRemove travel not OK")
	}
	// User record must still exist
	if _, err := os.Stat(userTripPath); err != nil {
		t.Errorf("expected user record %s to be preserved after FeatureRemove: %v", userTripPath, err)
	}
	regAfterRemove, _ := RegisteredDomainPaths(wsDir)
	if regAfterRemove["travel"] {
		t.Errorf("expected travel to be unregistered from workspace.yaml after FeatureRemove")
	}
}

func TestFeaturePackageAndImportRoundTrip(t *testing.T) {
	cfg1, wsDir1 := setupLeanWorkspaceForTest(t)
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

	// Create a custom domain and template in workspace 1
	customDomainDir := filepath.Join(wsDir1, "collections", "books")
	if err := EnsureDir(customDomainDir, 0o700); err != nil {
		t.Fatalf("mkdir custom domain: %v", err)
	}
	if err := os.WriteFile(filepath.Join(customDomainDir, "book-template.md"), []byte("# Book Template\n\n- Author:\n- Status:\n"), 0o600); err != nil {
		t.Fatalf("write book-template.md: %v", err)
	}

	zipPath := filepath.Join(t.TempDir(), "reading-tracker.zip")
	pkgRes, err := FeaturePackage(cfg1, FeaturePackageOptions{
		FeatureID:   "reading-tracker",
		Name:        "Reading Tracker",
		Version:     "1.0.0",
		Description: "Track books and reading notes.",
		Domains:     []string{"collections/books"},
		OutputPath:  zipPath,
	})
	if err != nil {
		t.Fatalf("FeaturePackage: %v", err)
	}
	if !pkgRes.OK || pkgRes.FilesCount < 2 {
		t.Fatalf("unexpected FeaturePackage result: %+v", pkgRes)
	}

	// Import into workspace 2
	cfg2, wsDir2 := setupLeanWorkspaceForTest(t)
	impRes, err := FeatureImport(cfg2, zipPath, true, now)
	if err != nil {
		t.Fatalf("FeatureImport: %v", err)
	}
	if !impRes.OK || impRes.FeatureID != "reading-tracker" {
		t.Fatalf("unexpected FeatureImport result: %+v", impRes)
	}
	if _, err := os.Stat(filepath.Join(wsDir2, "collections", "books", "book-template.md")); err != nil {
		t.Errorf("expected book-template.md in workspace 2 after import: %v", err)
	}
	reg2, _ := RegisteredDomainPaths(wsDir2)
	if !reg2["collections/books"] {
		t.Errorf("expected collections/books registered in workspace 2, got %v", reg2)
	}
}

func TestMigrationAutoInstallsFeaturesAndSkipsBoilerplate(t *testing.T) {
	cfg, wsDir := setupLeanWorkspaceForTest(t)
	migID := "mig-qa-existing-ws"
	migDir := MigrationRoot(cfg, migID)
	sourceDir := filepath.Join(migDir, "source")
	if err := EnsureDir(sourceDir, 0o700); err != nil {
		t.Fatalf("mkdir sourceDir: %v", err)
	}

	// Populate sourceDir with an existing QA monolithic workspace export:
	// 1. Unmodified starter templates and schema files from features
	travelTpl, err := os.ReadFile(filepath.Join(cfg.RepositoryRoot, "features", "travel", "workspace", "travel", "trip-template.md"))
	if err != nil {
		t.Fatalf("read travel trip-template.md: %v", err)
	}
	travelSchema, err := os.ReadFile(filepath.Join(cfg.RepositoryRoot, "features", "travel", "workspace", "travel", "trip-template.schema.json"))
	if err != nil {
		t.Fatalf("read travel trip-template.schema.json: %v", err)
	}
	if err := EnsureDir(filepath.Join(sourceDir, "travel"), 0o700); err != nil {
		t.Fatalf("mkdir source travel: %v", err)
	}
	_ = os.WriteFile(filepath.Join(sourceDir, "travel", "trip-template.md"), travelTpl, 0o600)
	_ = os.WriteFile(filepath.Join(sourceDir, "travel", "trip-template.schema.json"), travelSchema, 0o600)

	// 2. Real user records in feature domains (travel and finance)
	userTripContent := []byte("---\ntitle: Tokyo Autumn 2026\nstart_date: \"2026-11-01\"\nend_date: \"2026-11-10\"\ndestination: Tokyo\npurpose: leisure\nstatus: planned\n---\n\n# Tokyo Autumn 2026\n")
	_ = os.WriteFile(filepath.Join(sourceDir, "travel", "2026-tokyo.md"), userTripContent, 0o600)

	if err := EnsureDir(filepath.Join(sourceDir, "finance", "ledger"), 0o700); err != nil {
		t.Fatalf("mkdir source finance/ledger: %v", err)
	}
	userLedgerContent := []byte("2026-10-01 * Coffee\n    expenses:food:coffee  5.00 USD\n    assets:cash          -5.00 USD\n")
	_ = os.WriteFile(filepath.Join(sourceDir, "finance", "ledger", "2026-10.hledger"), userLedgerContent, 0o600)

	// 3. A custom user-authored template in projects/
	if err := EnsureDir(filepath.Join(sourceDir, "projects"), 0o700); err != nil {
		t.Fatalf("mkdir source projects: %v", err)
	}
	_ = os.WriteFile(filepath.Join(sourceDir, "projects", "custom-sprint-template.md"), []byte("# Custom Sprint Template\n"), 0o600)

	// Initialize V2 migration
	mig, err := InitMigrationV2(cfg, migID)
	if err != nil {
		t.Fatalf("InitMigrationV2: %v", err)
	}

	// Verify proposal-repo baseline was seeded with feature templates
	propRepoDir := filepath.Join(migDir, "proposal-repo")
	if _, err := os.Stat(filepath.Join(propRepoDir, "travel", "trip-template.schema.json")); err != nil {
		t.Errorf("expected proposal-repo to have travel/trip-template.schema.json seeded: %v", err)
	}

	// Check source eligibilities in DB
	db, err := migration.OpenDB(migDir)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	sources, err := db.ListSources(migID)
	if err != nil {
		db.Close()
		t.Fatalf("ListSources: %v", err)
	}
	eligByPath := make(map[string]string)
	for _, s := range sources {
		eligByPath[s.RelativePath] = s.Eligibility
	}
	if eligByPath["travel/trip-template.md"] != migration.EligibilitySkipped {
		t.Errorf("expected unmodified travel/trip-template.md to be skipped, got %s", eligByPath["travel/trip-template.md"])
	}
	if eligByPath["travel/trip-template.schema.json"] != migration.EligibilitySkipped {
		t.Errorf("expected travel/trip-template.schema.json to be skipped, got %s", eligByPath["travel/trip-template.schema.json"])
	}
	if eligByPath["travel/2026-tokyo.md"] != migration.EligibilityEligible {
		t.Errorf("expected travel/2026-tokyo.md to be eligible, got %s", eligByPath["travel/2026-tokyo.md"])
	}
	if eligByPath["finance/ledger/2026-10.hledger"] != migration.EligibilityEligible {
		t.Errorf("expected finance/ledger/2026-10.hledger to be eligible, got %s", eligByPath["finance/ledger/2026-10.hledger"])
	}
	if eligByPath["projects/custom-sprint-template.md"] != migration.EligibilityEligible {
		t.Errorf("expected custom user template projects/custom-sprint-template.md to be eligible, got %s", eligByPath["projects/custom-sprint-template.md"])
	}

	// Run supervisor with a MockRunner that copies eligible files to their target paths in proposal-repo
	repo, err := propgit.OpenOrCreateRepo(propRepoDir)
	if err != nil {
		db.Close()
		t.Fatalf("OpenOrCreateRepo: %v", err)
	}
	mock := &runner.MockRunner{
		Handler: func(job migration.Job, source migration.SourceEntry, proposalWorkspaceDir string) (*runner.RequestResult, error) {
			srcBytes, err := os.ReadFile(filepath.Join(sourceDir, filepath.FromSlash(source.RelativePath)))
			if err != nil {
				return nil, err
			}
			dst := filepath.Join(proposalWorkspaceDir, filepath.FromSlash(source.RelativePath))
			if err := EnsureDir(filepath.Dir(dst), 0o700); err != nil {
				return nil, err
			}
			if err := os.WriteFile(dst, srcBytes, 0o600); err != nil {
				return nil, err
			}
			return &runner.RequestResult{
				ChangedPaths: []string{source.RelativePath},
				Rationale:    "Migrated existing workspace record",
			}, nil
		},
	}
	_ = db.UpdateMigrationState(migID, migration.StateProcessing, "")
	sup := runner.NewSupervisor(db, repo, mock, migID, "worker-test", mig.BaselineManifest)
	if err := sup.RunUntilIdle(context.Background()); err != nil {
		db.Close()
		t.Fatalf("RunUntilIdle: %v", err)
	}
	db.Close()

	// Apply the revision to the live Lean Base workspace
	if err := ApplyRevision(cfg, migID, "", ""); err != nil {
		t.Fatalf("ApplyRevision: %v", err)
	}

	// Verify travel and personal-finance features were automatically installed in the live workspace!
	regAfter, err := RegisteredDomainPaths(wsDir)
	if err != nil {
		t.Fatalf("RegisteredDomainPaths after ApplyRevision: %v", err)
	}
	if !regAfter["travel"] || !regAfter["finance"] || !regAfter["finance/intake"] {
		t.Errorf("expected travel, finance, and finance/intake to be auto-installed into workspace.yaml on ApplyRevision, got %v", regAfter)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataRoot, "skills", "personal-finance", "SKILL.md")); err != nil {
		t.Errorf("expected personal-finance skill to be auto-installed on ApplyRevision: %v", err)
	}
	if _, err := os.Stat(filepath.Join(wsDir, "travel", "2026-tokyo.md")); err != nil {
		t.Errorf("expected migrated record travel/2026-tokyo.md in live workspace: %v", err)
	}
	if _, err := os.Stat(filepath.Join(wsDir, "travel", "trip-template.md")); err != nil {
		t.Errorf("expected starter template travel/trip-template.md in live workspace after feature auto-install: %v", err)
	}
}

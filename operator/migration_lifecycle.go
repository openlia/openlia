package operator

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"openlia/operator/migration"
	"openlia/operator/migration/intake"
	"openlia/operator/migration/propgit"
	"openlia/operator/migration/runner"
)

// InitMigrationV2 initializes a V2 migration from an extracted source folder.
func InitMigrationV2(config Config, migrationID string) (*migration.Migration, error) {
	migDir := MigrationRoot(config, migrationID)
	sourceDir := filepath.Join(migDir, "source")
	tarGzPath := filepath.Join(migDir, "source.tar.gz")

	if _, err := os.Stat(sourceDir); os.IsNotExist(err) {
		if err := os.MkdirAll(sourceDir, 0o700); err != nil {
			return nil, fmt.Errorf("create source dir: %w", err)
		}
		if err := intake.ExtractTarball(tarGzPath, sourceDir); err != nil {
			return nil, fmt.Errorf("extract source archive: %w", err)
		}
	}

	db, err := migration.OpenDB(migDir)
	if err != nil {
		return nil, fmt.Errorf("open migration db: %w", err)
	}
	defer db.Close()

	// Initialize baseline proposal repo
	propRepoDir := filepath.Join(migDir, "proposal-repo")
	repo, err := propgit.OpenOrCreateRepo(propRepoDir)
	if err != nil {
		return nil, fmt.Errorf("init proposal repo: %w", err)
	}

	liveWorkspace := filepath.Join(config.DataRoot, "workspace")
	lockCtx, lockCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer lockCancel()
	unlock, lockErr := AcquireWorkspaceLock(lockCtx, config)
	if lockErr != nil {
		return nil, fmt.Errorf("acquire workspace lock for baseline: %w", lockErr)
	}
	baseCommit, err := repo.CaptureBaseline(liveWorkspace)
	unlock()
	if err != nil {
		return nil, fmt.Errorf("capture baseline: %w", err)
	}

	// Scan intake sources
	sources, err := intake.ScanSourceFolder(migrationID, sourceDir)
	if err != nil {
		return nil, fmt.Errorf("scan source files: %w", err)
	}

	mig := migration.Migration{
		ID:               migrationID,
		Schema:           2,
		State:            migration.StateQueued,
		BaselineManifest: baseCommit,
	}
	if err := db.CreateMigration(mig); err != nil {
		return nil, fmt.Errorf("create migration record: %w", err)
	}

	if err := db.InsertSources(sources); err != nil {
		return nil, fmt.Errorf("insert sources: %w", err)
	}

	// Enqueue jobs for eligible files
	var jobs []migration.Job
	for _, s := range sources {
		if s.Eligibility == migration.EligibilityEligible {
			jobs = append(jobs, migration.Job{
				ID:             fmt.Sprintf("job-%s-%s", migrationID, s.ID),
				MigrationID:    migrationID,
				SourceID:       s.ID,
				IdempotencyKey: fmt.Sprintf("%s:%s:%s", migrationID, s.ID, s.ByteHash),
				MaxAttempts:    3,
			})
		}
	}

	if len(jobs) > 0 {
		if err := db.EnqueueJobs(jobs); err != nil {
			return nil, fmt.Errorf("enqueue jobs: %w", err)
		}
	}

	if config.RuntimeUID > 0 && config.RuntimeGID > 0 && os.Geteuid() == 0 {
		migrationsBaseDir := filepath.Dir(migDir)
		openliaHiddenDir := filepath.Dir(migrationsBaseDir)
		_ = ensureRuntimeOwner(openliaHiddenDir, config.RuntimeUID, config.RuntimeGID, 0o700)
		_ = ensureRuntimeOwner(migrationsBaseDir, config.RuntimeUID, config.RuntimeGID, 0o700)
		_ = ensureRuntimeTreeOwner(migDir, config.RuntimeUID, config.RuntimeGID)
	}

	return &mig, nil
}

// StopMigration sets stop intent, terminates active runner container if running,
// restores incomplete proposal edits to the last checkpoint, and marks state stopped.
func StopMigration(config Config, migrationID string) error {
	migDir := MigrationRoot(config, migrationID)
	db, err := migration.OpenDB(migDir)
	if err != nil {
		return err
	}
	defer db.Close()

	mig, err := db.GetMigration(migrationID)
	if err != nil || mig == nil {
		return fmt.Errorf("migration %s not found", migrationID)
	}
	if mig.State == migration.StateApplying || mig.State == migration.StateApplied {
		return fmt.Errorf("cannot stop migration in %s state", mig.State)
	}

	if err := db.SetStopIntent(migrationID, true); err != nil {
		return err
	}

	// Terminate active Hermes runner container if any
	containerName := fmt.Sprintf("openlia-mig-runner-%s", migrationID)
	_ = exec.Command("docker", "kill", containerName).Run()
	_ = exec.Command("docker", "rm", "-f", containerName).Run()

	// Restore proposal repo working tree to last committed checkpoint
	propRepoDir := filepath.Join(migDir, "proposal-repo")
	_ = exec.Command("git", "-C", propRepoDir, "reset", "--hard", "HEAD").Run()
	_ = exec.Command("git", "-C", propRepoDir, "clean", "-fd").Run()

	return db.UpdateMigrationState(migrationID, migration.StateStopped, mig.State)
}

// ResumeMigration clears stop intent and starts processing again.
func ResumeMigration(ctx context.Context, config Config, migrationID string) error {
	migDir := MigrationRoot(config, migrationID)
	db, err := migration.OpenDB(migDir)
	if err != nil {
		return err
	}
	defer db.Close()

	mig, err := db.GetMigration(migrationID)
	if err != nil || mig == nil {
		return fmt.Errorf("migration %s not found", migrationID)
	}

	if err := db.SetStopIntent(migrationID, false); err != nil {
		return err
	}

	targetState := migration.StateProcessing
	if mig.State == migration.StateRevising || mig.SavedPhase == migration.StateRevising {
		targetState = migration.StateRevising
	} else if mig.SavedPhase != "" {
		targetState = mig.SavedPhase
	}
	_ = db.ResetFailedJobs(migrationID)
	if err := db.UpdateMigrationState(migrationID, targetState, ""); err != nil {
		return err
	}

	// Run supervisor
	return RunMigrationSupervisor(ctx, config, migrationID)
}

// DiscardMigration marks a migration discarded after terminating active runner containers.
func DiscardMigration(config Config, migrationID string) error {
	migDir := MigrationRoot(config, migrationID)
	db, err := migration.OpenDB(migDir)
	if err != nil {
		return err
	}
	defer db.Close()

	mig, err := db.GetMigration(migrationID)
	if err != nil || mig == nil {
		return fmt.Errorf("migration %s not found", migrationID)
	}
	if mig.State == migration.StateApplying || mig.State == migration.StateRecoveryRequired {
		return fmt.Errorf("cannot discard migration in %s state", mig.State)
	}

	_ = db.SetStopIntent(migrationID, true)

	// Terminate active runner container if any
	containerName := fmt.Sprintf("openlia-mig-runner-%s", migrationID)
	_ = exec.Command("docker", "kill", containerName).Run()
	_ = exec.Command("docker", "rm", "-f", containerName).Run()

	return db.UpdateMigrationState(migrationID, migration.StateDiscarded, "")
}

// RunMigrationSupervisor runs the queue supervisor for a migration.
func RunMigrationSupervisor(ctx context.Context, config Config, migrationID string) error {
	migDir := MigrationRoot(config, migrationID)
	db, err := migration.OpenDB(migDir)
	if err != nil {
		return err
	}
	defer db.Close()

	mig, err := db.GetMigration(migrationID)
	if err != nil || mig == nil {
		return fmt.Errorf("migration %s not found", migrationID)
	}

	propRepoDir := filepath.Join(migDir, "proposal-repo")
	repo, err := propgit.OpenOrCreateRepo(propRepoDir)
	if err != nil {
		return err
	}

	_ = db.UpdateMigrationState(migrationID, migration.StateProcessing, "")

	runnerRuntimeDir := filepath.Join(migDir, "runner-runtime")
	sourceDir := filepath.Join(migDir, "source")
	_ = os.MkdirAll(filepath.Join(runnerRuntimeDir, "logs"), 0o777)
	_ = os.MkdirAll(filepath.Join(runnerRuntimeDir, ".local"), 0o777)
	if config.RuntimeUID > 0 && config.RuntimeGID > 0 && os.Geteuid() == 0 {
		migrationsBaseDir := filepath.Dir(migDir)
		openliaHiddenDir := filepath.Dir(migrationsBaseDir)
		_ = ensureRuntimeOwner(openliaHiddenDir, config.RuntimeUID, config.RuntimeGID, 0o700)
		_ = ensureRuntimeOwner(migrationsBaseDir, config.RuntimeUID, config.RuntimeGID, 0o700)
		_ = ensureRuntimeTreeOwner(migDir, config.RuntimeUID, config.RuntimeGID)
	}

	hermesRunner := runner.NewHermesRunner(runner.HermesRunnerConfig{
		DockerImage:      config.HermesImage,
		DataRoot:         config.DataRoot,
		SecretDir:        config.SecretDir,
		SecretFile:       config.SecretFile,
		SystemSkillsRoot: config.SystemSkillsRoot,
		SourceDir:        sourceDir,
		RuntimeDir:       runnerRuntimeDir,
		UID:              config.RuntimeUID,
		GID:              config.RuntimeGID,
	})
	workerID := fmt.Sprintf("worker-%d", time.Now().Unix())
	sup := runner.NewSupervisor(db, repo, hermesRunner, migrationID, workerID, mig.BaselineManifest)

	return sup.RunUntilIdle(ctx)
}

// GetMigrationStatusV2 reads migration status from V2 SQLite or falls back to V1 status.json.
func GetMigrationStatusV2(config Config, migrationID string) (any, error) {
	migDir := MigrationRoot(config, migrationID)
	dbPath := filepath.Join(migDir, "migration.sqlite")
	if _, err := os.Stat(dbPath); err == nil {
		db, err := migration.OpenDB(migDir)
		if err != nil {
			return nil, err
		}
		defer db.Close()

		mig, err := db.GetMigration(migrationID)
		if err != nil || mig == nil {
			return nil, fmt.Errorf("migration %s not found", migrationID)
		}

		jobSummary, _ := db.GetJobSummary(migrationID)
		progress, _ := db.GetMigrationProgress(migrationID)
		sources, _ := db.ListSources(migrationID)
		revisions, _ := db.ListRevisions(migrationID)

		return map[string]any{
			"schema":             2,
			"id":                 mig.ID,
			"state":              mig.State,
			"stop_intent":        mig.StopIntent,
			"baseline_manifest":  mig.BaselineManifest,
			"active_revision_id": mig.ActiveRevisionID,
			"job_summary":        jobSummary,
			"progress":           progress,
			"total_sources":      len(sources),
			"total_revisions":    len(revisions),
			"created_at":         mig.CreatedAt.Format(time.RFC3339),
			"updated_at":         mig.UpdatedAt.Format(time.RFC3339),
		}, nil
	}

	// Fallback to legacy status
	return GetMigrationStatus(config, migrationID)
}

// GetMigrationDiffV2 returns the unified diff between revisions or baseline.
func GetMigrationDiffV2(config Config, migrationID string, fromRevNum, toRevNum int) (string, error) {
	migDir := MigrationRoot(config, migrationID)
	db, err := migration.OpenDB(migDir)
	if err != nil {
		return "", err
	}
	defer db.Close()

	mig, err := db.GetMigration(migrationID)
	if err != nil || mig == nil {
		return "", fmt.Errorf("migration %s not found", migrationID)
	}

	revisions, err := db.ListRevisions(migrationID)
	if err != nil {
		return "", err
	}
	if len(revisions) == 0 {
		return "", fmt.Errorf("no revisions published yet for migration %s", migrationID)
	}

	targetRev := revisions[len(revisions)-1]
	if toRevNum > 0 {
		found := false
		for _, r := range revisions {
			if r.RevisionNum == toRevNum {
				targetRev = r
				found = true
				break
			}
		}
		if !found {
			return "", fmt.Errorf("revision %d not found", toRevNum)
		}
	}

	fromCommit := mig.BaselineManifest
	if fromRevNum > 0 {
		found := false
		for _, r := range revisions {
			if r.RevisionNum == fromRevNum {
				fromCommit = r.CommitHash
				found = true
				break
			}
		}
		if !found {
			return "", fmt.Errorf("from-revision %d not found", fromRevNum)
		}
	}

	repoDir := filepath.Join(migDir, "proposal-repo")
	repo, err := propgit.OpenOrCreateRepo(repoDir)
	if err != nil {
		return "", err
	}

	return repo.Diff(fromCommit, targetRev.CommitHash)
}

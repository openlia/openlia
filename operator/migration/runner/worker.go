package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
	"openlia/operator/migration"
	"openlia/operator/migration/propgit"
	"openlia/operator/migration/validator"
)

// Supervisor coordinates durable job execution, checkpoints, and review revisions.
type Supervisor struct {
	DB           *migration.DB
	Repo         *propgit.ProposalRepo
	Runner       RequestRunner
	MigrationID  string
	WorkerID     string
	LeaseTime    time.Duration
	BaselineHash string
}

// NewSupervisor creates a new worker supervisor.
func NewSupervisor(db *migration.DB, repo *propgit.ProposalRepo, runner RequestRunner, migrationID, workerID string, baselineHash string) *Supervisor {
	return &Supervisor{
		DB:           db,
		Repo:         repo,
		Runner:       runner,
		MigrationID:  migrationID,
		WorkerID:     workerID,
		LeaseTime:    60 * time.Second,
		BaselineHash: baselineHash,
	}
}

// AcquireWorkerLock acquires an exclusive advisory OS lock on <migDir>/worker.lock,
// ensuring only one worker processes the proposal-repo at any given time.
func AcquireWorkerLock(lockPath string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return nil, fmt.Errorf("ensure worker lock dir: %w", err)
	}
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open worker lock file: %w", err)
	}
	err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if err != nil {
		_ = file.Close()
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return nil, fmt.Errorf("worker lock is held by another active worker process")
		}
		return nil, fmt.Errorf("acquire worker lock: %w", err)
	}
	return func() {
		_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
		_ = file.Close()
	}, nil
}

// ResetWorkingTree resets any uncommitted or contaminated changes in proposal-repo
// back to the target checkpoint commit, ensuring dirty files do not contaminate git add -A.
func (s *Supervisor) ResetWorkingTree(targetCommit string) {
	if targetCommit == "" {
		return
	}
	cmdReset := exec.Command("git", "-C", s.Repo.RepoDir, "reset", "--hard", targetCommit)
	_ = cmdReset.Run()
	cmdClean := exec.Command("git", "-C", s.Repo.RepoDir, "clean", "-fd")
	_ = cmdClean.Run()
	if s.Runner != nil {
		if hr, ok := s.Runner.(*HermesRunner); ok && hr.cfg.UID > 0 && hr.cfg.GID > 0 && os.Geteuid() == 0 {
			_ = filepath.WalkDir(s.Repo.RepoDir, func(p string, _ os.DirEntry, walkErr error) error {
				if walkErr == nil {
					_ = os.Lchown(p, hr.cfg.UID, hr.cfg.GID)
				}
				return nil
			})
		}
	}
}

// RunUntilIdle processes queued jobs until none remain or stop intent is flagged.
// It acquires an exclusive worker flock, runs background lease heartbeats,
// and enforces generation-fenced job completions and retries.
func (s *Supervisor) RunUntilIdle(ctx context.Context) error {
	// 1. Acquire single proposal-repo worker flock
	lockPath := filepath.Join(filepath.Dir(s.Repo.RepoDir), "worker.lock")
	unlock, err := AcquireWorkerLock(lockPath)
	if err != nil {
		return err
	}
	defer unlock()

	// 2. Sweep expired running jobs from any crashed worker processes
	_, _ = s.DB.SweepExpiredJobs(s.MigrationID)

	// Check if migration is in revising state
	mig, err := s.DB.GetMigration(s.MigrationID)
	if err != nil {
		return err
	}
	if mig != nil {
		if mig.StopIntent || mig.State == migration.StateStopping || mig.State == migration.StateStopped {
			_ = s.DB.UpdateMigrationState(s.MigrationID, migration.StateStopped, mig.State)
			return nil
		}
		if mig.State == migration.StateRevising {
			return s.ProcessRevision(ctx)
		}
		feedback, _ := s.DB.ListFeedback(s.MigrationID, "")
		for _, f := range feedback {
			if f.Status == "submitted" {
				return s.ProcessRevision(ctx)
			}
		}
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Check stop intent
		mig, err := s.DB.GetMigration(s.MigrationID)
		if err != nil {
			return err
		}
		if mig != nil && (mig.StopIntent || mig.State == migration.StateStopping || mig.State == migration.StateStopped) {
			_ = s.DB.UpdateMigrationState(s.MigrationID, migration.StateStopped, mig.State)
			return nil
		}

		job, err := s.DB.ClaimNextJob(ctx, s.MigrationID, s.WorkerID, s.LeaseTime)
		if err != nil {
			return fmt.Errorf("claim job: %w", err)
		}
		if job == nil {
			// No more runnable jobs
			break
		}

		// Snapshot commit before job execution for rollback on failure
		headBefore, _ := s.Repo.GetHeadCommit()

		// Start background lease heartbeat with job-scoped context
		jobCtx, jobCancel := context.WithCancel(ctx)
		jobDone := make(chan struct{})
		go func(jobID string, leaseGen int64) {
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-jobDone:
					return
				case <-jobCtx.Done():
					return
				case <-ticker.C:
					if err := s.DB.HeartbeatJob(jobID, s.WorkerID, leaseGen, s.LeaseTime); err != nil {
						// Heartbeat failed or lease lost: cancel runner immediately
						jobCancel()
						return
					}
				}
			}
		}(job.ID, job.LeaseGeneration)

		// Lookup source entry
		sources, err := s.DB.ListSources(s.MigrationID)
		if err != nil {
			close(jobDone)
			jobCancel()
			return fmt.Errorf("list sources: %w", err)
		}
		var targetSource *migration.SourceEntry
		for i := range sources {
			if sources[i].ID == job.SourceID {
				targetSource = &sources[i]
				break
			}
		}

		if targetSource == nil {
			close(jobDone)
			jobCancel()
			_ = s.DB.CompleteJob(job.ID, s.WorkerID, job.LeaseGeneration, migration.JobFailed, "Source entry missing", nil, nil, nil, "missing_source", "")
			continue
		}

		// Execute job with runner using jobCtx
		res, runErr := s.Runner.RunJob(jobCtx, *job, *targetSource, s.Repo.RepoDir)
		close(jobDone)
		jobCancel()

		if runErr != nil {
			// On runner failure: clean up dirty edits so next job isn't contaminated
			s.ResetWorkingTree(headBefore)
			_, _ = s.DB.FailOrRetryJob(job.ID, s.WorkerID, job.LeaseGeneration, "Runner error", "runner_error", runErr.Error())
			continue
		}

		// Git checkpoint
		headAfter, cpErr := s.Repo.CheckpointJob(job.ID, targetSource.RelativePath)
		if cpErr != nil {
			s.ResetWorkingTree(headBefore)
			_, _ = s.DB.FailOrRetryJob(job.ID, s.WorkerID, job.LeaseGeneration, "Checkpoint error", "checkpoint_error", cpErr.Error())
			continue
		}

		changedPaths := res.ChangedPaths
		if headBefore != "" && headAfter != "" && headBefore != headAfter {
			if changedEntries, err := s.Repo.GetChangedFiles(headBefore, headAfter); err == nil {
				actualPaths := make([]string, len(changedEntries))
				for i, e := range changedEntries {
					actualPaths[i] = e.Path
				}
				if len(actualPaths) > 0 {
					changedPaths = actualPaths
				}
			}
		}

		status := migration.JobSucceeded
		if len(changedPaths) == 0 {
			status = migration.JobNoChange
		}
		if s.Runner != nil {
			if hr, ok := s.Runner.(*HermesRunner); ok && hr.cfg.UID > 0 && hr.cfg.GID > 0 && os.Geteuid() == 0 {
				_ = filepath.WalkDir(s.Repo.RepoDir, func(p string, _ os.DirEntry, walkErr error) error {
					if walkErr == nil {
						_ = os.Lchown(p, hr.cfg.UID, hr.cfg.GID)
					}
					return nil
				})
			}
		}
		_ = s.DB.CompleteJob(job.ID, s.WorkerID, job.LeaseGeneration, status, res.Rationale, changedPaths, res.Findings, res.Questions, "", "")
	}

	// Publish revision 1 if all jobs reached terminal state
	return s.PublishRevisionIfDone()
}

// ProcessRevision executes a Hermes revision request addressing submitted feedback comments.
func (s *Supervisor) ProcessRevision(ctx context.Context) error {
	revs, err := s.DB.ListRevisions(s.MigrationID)
	if err != nil {
		return err
	}
	if len(revs) == 0 {
		return fmt.Errorf("cannot revise: no prior revisions found")
	}
	latestRev := revs[len(revs)-1]

	feedback, err := s.DB.ListFeedback(s.MigrationID, "")
	if err != nil {
		return fmt.Errorf("list feedback: %w", err)
	}
	var submitted []migration.FeedbackItem
	for _, f := range feedback {
		if f.Status == "submitted" {
			submitted = append(submitted, f)
		}
	}

	headBefore, _ := s.Repo.GetHeadCommit()

	// Compute previous diff for context
	priorDiff, _ := s.Repo.Diff(s.BaselineHash, latestRev.CommitHash)

	// Execute revision request
	res, runErr := s.Runner.RunRevision(ctx, s.MigrationID, latestRev.RevisionNum, submitted, priorDiff, s.Repo.RepoDir)
	if runErr != nil {
		s.ResetWorkingTree(headBefore)
		return fmt.Errorf("runner error on revision: %w", runErr)
	}

	nextRevNum := len(revs) + 1
	headAfter, cpErr := s.Repo.CheckpointJob(fmt.Sprintf("revision-%d", nextRevNum), "addressed operator feedback")
	if cpErr != nil {
		s.ResetWorkingTree(headBefore)
		return fmt.Errorf("checkpoint revision %d: %w", nextRevNum, cpErr)
	}

	treeHash, err := s.Repo.GetTreeHash(headAfter)
	if err != nil {
		return err
	}
	diff, err := s.Repo.Diff(s.BaselineHash, headAfter)
	if err != nil {
		return err
	}
	patchHash := propgit.ComputePatchHash(diff)
	changedFiles, err := s.Repo.GetChangedFiles(s.BaselineHash, headAfter)
	if err != nil {
		return err
	}

	// Validate domain rules
	domainFindings := validator.ValidateProposalWorkspace(s.Repo.RepoDir, changedFiles)
	allFindings := append(res.Findings, domainFindings...)

	summary := res.Rationale
	if summary == "" {
		summary = fmt.Sprintf("Revision %d: updated based on operator feedback", nextRevNum)
	}

	nextRev := migration.ReviewRevision{
		ID:                  fmt.Sprintf("rev-%d-%s", nextRevNum, s.MigrationID),
		MigrationID:         s.MigrationID,
		RevisionNum:         nextRevNum,
		BaselineHash:        s.BaselineHash,
		CommitHash:          headAfter,
		TreeHash:            treeHash,
		PatchHash:           patchHash,
		ParentRevID:         latestRev.ID,
		Summary:             summary,
		ChangedFiles:        changedFiles,
		Findings:            allFindings,
		UnresolvedQuestions: res.Questions,
		CreatedAt:           time.Now().UTC(),
	}

	if err := s.DB.CreateRevision(nextRev); err != nil {
		return fmt.Errorf("create revision %d: %w", nextRevNum, err)
	}

	// Mark only feedback items addressed in this batch
	addressedIDs := make([]string, len(submitted))
	for i, f := range submitted {
		addressedIDs[i] = f.ID
	}
	_ = s.DB.MarkFeedbackAddressedByIDs(addressedIDs)
	return s.DB.UpdateMigrationState(s.MigrationID, migration.StateReadyForReview, "")
}

// PublishRevisionIfDone creates Revision 1 when all jobs are complete.
func (s *Supervisor) PublishRevisionIfDone() error {
	summary, err := s.DB.GetJobSummary(s.MigrationID)
	if err != nil {
		return err
	}
	pending := summary[migration.JobPending] + summary[migration.JobRunning]
	if pending > 0 {
		return nil
	}

	// Check if already published
	revs, err := s.DB.ListRevisions(s.MigrationID)
	if err != nil {
		return err
	}
	if len(revs) > 0 {
		mig, _ := s.DB.GetMigration(s.MigrationID)
		if mig != nil && mig.State == migration.StateProcessing {
			_ = s.DB.UpdateMigrationState(s.MigrationID, migration.StateReadyForReview, "")
		}
		return nil
	}

	headCommit, err := s.Repo.GetHeadCommit()
	if err != nil {
		return err
	}
	treeHash, err := s.Repo.GetTreeHash(headCommit)
	if err != nil {
		return err
	}

	diff, err := s.Repo.Diff(s.BaselineHash, headCommit)
	if err != nil {
		return err
	}
	patchHash := propgit.ComputePatchHash(diff)

	changedFiles, err := s.Repo.GetChangedFiles(s.BaselineHash, headCommit)
	if err != nil {
		return err
	}

	// Collect findings and unresolved questions across all jobs
	allJobs, _ := s.DB.ListJobs(s.MigrationID)
	var jobFindings []migration.ValidationFinding
	var unresolvedQuestions []string
	questionSet := make(map[string]bool)
	for _, j := range allJobs {
		jobFindings = append(jobFindings, j.Findings...)
		for _, q := range j.UnresolvedQuestions {
			if !questionSet[q] {
				questionSet[q] = true
				unresolvedQuestions = append(unresolvedQuestions, q)
			}
		}
	}

	// Validate domain rules in proposal workspace
	domainFindings := validator.ValidateProposalWorkspace(s.Repo.RepoDir, changedFiles)
	allFindings := append(jobFindings, domainFindings...)

	if summary[migration.JobFailed] > 0 {
		allFindings = append(allFindings, migration.ValidationFinding{
			Domain:   "runner",
			Message:  fmt.Sprintf("%d source job(s) failed during processing", summary[migration.JobFailed]),
			Severity: "warning",
		})
	}

	nextRevNum := len(revs) + 1
	var parentID string
	if len(revs) > 0 {
		parentID = revs[len(revs)-1].ID
	}

	nextRev := migration.ReviewRevision{
		ID:                  fmt.Sprintf("rev-%d-%s", nextRevNum, s.MigrationID),
		MigrationID:         s.MigrationID,
		RevisionNum:         nextRevNum,
		BaselineHash:        s.BaselineHash,
		CommitHash:          headCommit,
		TreeHash:            treeHash,
		PatchHash:           patchHash,
		ParentRevID:         parentID,
		Summary:             fmt.Sprintf("Revision %d: proposals updated by Hermes", nextRevNum),
		ChangedFiles:        changedFiles,
		Findings:            allFindings,
		UnresolvedQuestions: unresolvedQuestions,
		CreatedAt:           time.Now().UTC(),
	}

	if err := s.DB.CreateRevision(nextRev); err != nil {
		return fmt.Errorf("create revision %d: %w", nextRevNum, err)
	}

	return s.DB.UpdateMigrationState(s.MigrationID, migration.StateReadyForReview, "")
}

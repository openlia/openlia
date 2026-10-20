package runner

import (
	"context"
	"fmt"
	"os/exec"
	"time"

	"openlia/operator/migration"
	"openlia/operator/migration/propgit"
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
}

// RunUntilIdle processes queued jobs until none remain or stop intent is flagged.
// It runs background lease heartbeats and generation-fenced job completions.
func (s *Supervisor) RunUntilIdle(ctx context.Context) error {
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

		// Start background lease heartbeat
		jobDone := make(chan struct{})
		go func(jobID string, leaseGen int64) {
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-jobDone:
					return
				case <-ctx.Done():
					return
				case <-ticker.C:
					_ = s.DB.HeartbeatJob(jobID, s.WorkerID, leaseGen, s.LeaseTime)
				}
			}
		}(job.ID, job.LeaseGeneration)

		// Lookup source entry
		sources, err := s.DB.ListSources(s.MigrationID)
		if err != nil {
			close(jobDone)
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
			_ = s.DB.CompleteJob(job.ID, s.WorkerID, job.LeaseGeneration, migration.JobFailed, "Source entry missing", nil, "missing_source", "")
			continue
		}

		// Execute job with runner
		res, runErr := s.Runner.RunJob(ctx, *job, *targetSource, s.Repo.RepoDir)
		close(jobDone)

		if runErr != nil {
			// On runner failure: clean up dirty edits so next job isn't contaminated
			s.ResetWorkingTree(headBefore)
			_ = s.DB.CompleteJob(job.ID, s.WorkerID, job.LeaseGeneration, migration.JobFailed, "Runner error", nil, "runner_error", runErr.Error())
			continue
		}

		// Git checkpoint
		headAfter, cpErr := s.Repo.CheckpointJob(job.ID, targetSource.RelativePath)
		if cpErr != nil {
			s.ResetWorkingTree(headBefore)
			_ = s.DB.CompleteJob(job.ID, s.WorkerID, job.LeaseGeneration, migration.JobFailed, "Checkpoint error", nil, "checkpoint_error", cpErr.Error())
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
		_ = s.DB.CompleteJob(job.ID, s.WorkerID, job.LeaseGeneration, status, res.Rationale, changedPaths, "", "")
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
	res, runErr := s.Runner.RunRevision(ctx, latestRev.RevisionNum, submitted, priorDiff, s.Repo.RepoDir)
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

	summary := res.Rationale
	if summary == "" {
		summary = fmt.Sprintf("Revision %d: updated based on operator feedback", nextRevNum)
	}

	nextRev := migration.ReviewRevision{
		ID:           fmt.Sprintf("rev-%d-%s", nextRevNum, s.MigrationID),
		MigrationID:  s.MigrationID,
		RevisionNum:  nextRevNum,
		BaselineHash: s.BaselineHash,
		CommitHash:   headAfter,
		TreeHash:     treeHash,
		PatchHash:    patchHash,
		ParentRevID:  latestRev.ID,
		Summary:      summary,
		ChangedFiles: changedFiles,
		CreatedAt:    time.Now().UTC(),
	}

	if err := s.DB.CreateRevision(nextRev); err != nil {
		return fmt.Errorf("create revision %d: %w", nextRevNum, err)
	}

	_ = s.DB.MarkFeedbackAddressed(s.MigrationID)
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

	// Collect any failed or blocked jobs as explicit findings
	var findings []migration.ValidationFinding
	if summary[migration.JobFailed] > 0 {
		findings = append(findings, migration.ValidationFinding{
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
		ID:           fmt.Sprintf("rev-%d-%s", nextRevNum, s.MigrationID),
		MigrationID:  s.MigrationID,
		RevisionNum:  nextRevNum,
		BaselineHash: s.BaselineHash,
		CommitHash:   headCommit,
		TreeHash:     treeHash,
		PatchHash:    patchHash,
		ParentRevID:  parentID,
		Summary:      fmt.Sprintf("Revision %d: proposals updated by Hermes", nextRevNum),
		ChangedFiles: changedFiles,
		Findings:     findings,
		CreatedAt:    time.Now().UTC(),
	}

	if err := s.DB.CreateRevision(nextRev); err != nil {
		return fmt.Errorf("create revision %d: %w", nextRevNum, err)
	}

	return s.DB.UpdateMigrationState(s.MigrationID, migration.StateReadyForReview, "")
}

package runner

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"openlia/operator/migration"
	"openlia/operator/migration/propgit"
)

func TestSupervisor_EndToEndFlow(t *testing.T) {
	tempDir := t.TempDir()
	migDir := filepath.Join(tempDir, "migration")
	_ = os.MkdirAll(migDir, 0o700)

	db, err := migration.OpenDB(migDir)
	if err != nil {
		t.Fatalf("OpenDB failed: %v", err)
	}
	defer db.Close()

	migID := "mig-e2e"
	_ = db.CreateMigration(migration.Migration{
		ID:     migID,
		Schema: 2,
		State:  migration.StateProcessing,
	})

	// Setup proposal repo with baseline
	repoDir := filepath.Join(migDir, "proposal-repo")
	repo, err := propgit.OpenOrCreateRepo(repoDir)
	if err != nil {
		t.Fatalf("OpenOrCreateRepo failed: %v", err)
	}

	liveDir := filepath.Join(tempDir, "live")
	_ = os.MkdirAll(liveDir, 0o700)
	_ = os.WriteFile(filepath.Join(liveDir, "README.md"), []byte("# Live Workspace\n"), 0o600)

	baseCommit, err := repo.CaptureBaseline(liveDir)
	if err != nil {
		t.Fatalf("CaptureBaseline failed: %v", err)
	}

	// Insert source
	src := migration.SourceEntry{
		ID:           "src-01",
		MigrationID:  migID,
		RelativePath: "travel/tokyo.md",
		ByteHash:     "hash1",
		ByteSize:     100,
		Encoding:     "utf-8",
		DetectedType: "markdown",
		Eligibility:  migration.EligibilityEligible,
		OrderIndex:   0,
	}
	_ = db.InsertSources([]migration.SourceEntry{src})

	// Enqueue job
	job := migration.Job{
		ID:             "job-01",
		MigrationID:    migID,
		SourceID:       "src-01",
		IdempotencyKey: "mig-e2e:src-01",
		MaxAttempts:    3,
	}
	_ = db.EnqueueJobs([]migration.Job{job})

	// Setup supervisor with mock runner
	mockRunner := &MockRunner{
		Handler: func(job migration.Job, source migration.SourceEntry, workspaceDir string) (*RequestResult, error) {
			dest := filepath.Join(workspaceDir, "travel", "tokyo.md")
			_ = os.MkdirAll(filepath.Dir(dest), 0o700)
			_ = os.WriteFile(dest, []byte("# Tokyo Trip\nPlaces to visit.\n"), 0o600)
			return &RequestResult{
				ChangedPaths: []string{"travel/tokyo.md"},
				Rationale:    "Placed in travel directory",
			}, nil
		},
	}

	supervisor := NewSupervisor(db, repo, mockRunner, migID, "worker-1", baseCommit)

	ctx := context.Background()
	if err := supervisor.RunUntilIdle(ctx); err != nil {
		t.Fatalf("RunUntilIdle failed: %v", err)
	}

	// Verify job succeeded
	summary, err := db.GetJobSummary(migID)
	if err != nil || summary[migration.JobSucceeded] != 1 {
		t.Fatalf("expected 1 succeeded job, got %+v", summary)
	}

	// Verify revision 1 was published
	revs, err := db.ListRevisions(migID)
	if err != nil || len(revs) != 1 {
		t.Fatalf("expected 1 published revision, got %+v", revs)
	}
	rev1 := revs[0]
	if rev1.RevisionNum != 1 || len(rev1.ChangedFiles) != 1 || rev1.ChangedFiles[0].Path != "travel/tokyo.md" {
		t.Fatalf("unexpected revision 1: %+v", rev1)
	}

	// Verify migration state updated to ready_for_review
	mig, _ := db.GetMigration(migID)
	if mig.State != migration.StateReadyForReview {
		t.Fatalf("expected state ready_for_review, got %s", mig.State)
	}
}

func TestParseResponse_ValidationFindings(t *testing.T) {
	// 1. Array of strings for validation_findings
	respWithStrings := "```json\n{\n  \"changed_paths\": [\"notes/todo.md\"],\n  \"rationale\": \"Added todo item\",\n  \"unresolved_questions\": [\"Where to file this?\"],\n  \"validation_findings\": [\"warning: missing header\", \"notice: formatted list\"]\n}\n```"
	res, err := ParseResponse(respWithStrings)
	if err != nil {
		t.Fatalf("ParseResponse with strings failed: %v", err)
	}
	if len(res.Findings) != 2 {
		t.Fatalf("expected 2 findings, got %d", len(res.Findings))
	}
	if res.Findings[0].Message != "warning: missing header" || res.Findings[0].Severity != "info" {
		t.Errorf("unexpected finding 0: %+v", res.Findings[0])
	}

	// 2. Array of objects for validation_findings
	respWithObjects := "```json\n{\n  \"changed_paths\": [\"finances/ledger.hledger\"],\n  \"rationale\": \"Recorded payroll\",\n  \"unresolved_questions\": [],\n  \"validation_findings\": [\n    {\"severity\": \"warning\", \"domain\": \"personal-finance\", \"message\": \"Unknown account: Expenses:Misc\"}\n  ]\n}\n```"
	res2, err := ParseResponse(respWithObjects)
	if err != nil {
		t.Fatalf("ParseResponse with objects failed: %v", err)
	}
	if len(res2.Findings) != 1 {
		t.Fatalf("expected 1 finding, got %d", len(res2.Findings))
	}
	if res2.Findings[0].Severity != "warning" || res2.Findings[0].Domain != "personal-finance" {
		t.Errorf("unexpected finding 0: %+v", res2.Findings[0])
	}
}

func TestParseResponse_ResilientScanner(t *testing.T) {
	noisyResponse := `<thinking>
I should parse the user notes and place them in the calendar.
JSON structure needed:
</thinking>
Here is my plan:
` + "```json" + `
{
  "changed_paths": ["calendar/meeting.md"],
  "rationale": "Scheduled roadmap meeting",
  "unresolved_questions": [],
  "validation_findings": []
}
` + "```" + `
Hope this helps! Let me know if you need changes.`

	res, err := ParseResponse(noisyResponse)
	if err != nil {
		t.Fatalf("ParseResponse failed on noisy response: %v", err)
	}
	if len(res.ChangedPaths) != 1 || res.ChangedPaths[0] != "calendar/meeting.md" {
		t.Errorf("unexpected changed paths: %+v", res.ChangedPaths)
	}
}

func TestSupervisor_RevisionLoop(t *testing.T) {
	tempDir := t.TempDir()
	migDir := filepath.Join(tempDir, "migration")
	_ = os.MkdirAll(migDir, 0o700)

	db, err := migration.OpenDB(migDir)
	if err != nil {
		t.Fatalf("OpenDB failed: %v", err)
	}
	defer db.Close()

	migID := "mig-revision-test"
	_ = db.CreateMigration(migration.Migration{
		ID:     migID,
		Schema: 2,
		State:  migration.StateProcessing,
	})

	repoDir := filepath.Join(migDir, "proposal-repo")
	repo, err := propgit.OpenOrCreateRepo(repoDir)
	if err != nil {
		t.Fatalf("OpenOrCreateRepo failed: %v", err)
	}

	liveDir := filepath.Join(tempDir, "live")
	_ = os.MkdirAll(liveDir, 0o700)
	baseCommit, err := repo.CaptureBaseline(liveDir)
	if err != nil {
		t.Fatalf("CaptureBaseline failed: %v", err)
	}

	src := migration.SourceEntry{
		ID:           "src-01",
		MigrationID:  migID,
		RelativePath: "travel/plan.md",
		ByteHash:     "hash1",
		Eligibility:  migration.EligibilityEligible,
	}
	_ = db.InsertSources([]migration.SourceEntry{src})

	job := migration.Job{
		ID:             "job-01",
		MigrationID:    migID,
		SourceID:       "src-01",
		IdempotencyKey: "mig-rev:src-01",
		MaxAttempts:    3,
	}
	_ = db.EnqueueJobs([]migration.Job{job})

	mockRunner := &MockRunner{
		Handler: func(job migration.Job, source migration.SourceEntry, workspaceDir string) (*RequestResult, error) {
			dest := filepath.Join(workspaceDir, "travel", "plan.md")
			_ = os.MkdirAll(filepath.Dir(dest), 0o700)
			_ = os.WriteFile(dest, []byte("# Japan Trip\nDay 1: Tokyo\n"), 0o600)
			return &RequestResult{
				ChangedPaths: []string{"travel/plan.md"},
				Rationale:    "Initial draft",
			}, nil
		},
		RevisionHandler: func(revisionNum int, feedback []migration.FeedbackItem, priorDiff string, workspaceDir string) (*RequestResult, error) {
			dest := filepath.Join(workspaceDir, "travel", "plan.md")
			_ = os.WriteFile(dest, []byte("# Japan Trip\nDay 1: Tokyo\n- Packing: walking shoes\n"), 0o600)
			return &RequestResult{
				ChangedPaths: []string{"travel/plan.md"},
				Rationale:    "Added walking shoes per feedback",
			}, nil
		},
	}

	supervisor := NewSupervisor(db, repo, mockRunner, migID, "worker-1", baseCommit)
	ctx := context.Background()

	// Initial run -> produces Revision 1
	if err := supervisor.RunUntilIdle(ctx); err != nil {
		t.Fatalf("RunUntilIdle failed: %v", err)
	}
	revs, _ := db.ListRevisions(migID)
	if len(revs) != 1 {
		t.Fatalf("expected 1 revision, got %d", len(revs))
	}

	// Add feedback comment and transition to revising state
	_ = db.AddFeedback(migration.FeedbackItem{
		ID:          "fb-01",
		MigrationID: migID,
		RevisionID:  revs[0].ID,
		TargetPath:  "travel/plan.md",
		Comment:     "Please add walking shoes to packing list",
		Status:      "submitted",
	})
	_ = db.UpdateMigrationState(migID, migration.StateRevising, "")

	// Run supervisor again -> processes revision -> produces Revision 2
	if err := supervisor.RunUntilIdle(ctx); err != nil {
		t.Fatalf("RunUntilIdle for revision failed: %v", err)
	}

	revsAfter, _ := db.ListRevisions(migID)
	if len(revsAfter) != 2 {
		t.Fatalf("expected 2 revisions after feedback, got %d", len(revsAfter))
	}
	rev2 := revsAfter[1]
	if rev2.RevisionNum != 2 || rev2.ParentRevID != revs[0].ID {
		t.Errorf("unexpected revision 2 metadata: %+v", rev2)
	}

	mig, _ := db.GetMigration(migID)
	if mig.State != migration.StateReadyForReview {
		t.Errorf("expected state ready_for_review, got %s", mig.State)
	}

	feedbackList, _ := db.ListFeedback(migID, "")
	if len(feedbackList) != 1 || feedbackList[0].Status != "addressed" {
		t.Errorf("expected feedback to be addressed, got: %+v", feedbackList)
	}
}

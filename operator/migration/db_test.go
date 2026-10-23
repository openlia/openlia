package migration

import (
	"context"
	"testing"
	"time"
)

func TestMigrationDB_CRUDAndLeasing(t *testing.T) {
	tempDir := t.TempDir()
	db, err := OpenDB(tempDir)
	if err != nil {
		t.Fatalf("OpenDB failed: %v", err)
	}
	defer db.Close()

	m := Migration{
		ID:     "mig-test-1",
		Schema: 2,
		State:  StateUploaded,
	}
	if err := db.CreateMigration(m); err != nil {
		t.Fatalf("CreateMigration failed: %v", err)
	}

	got, err := db.GetMigration("mig-test-1")
	if err != nil || got == nil {
		t.Fatalf("GetMigration failed: %v", err)
	}
	if got.State != StateUploaded || got.Schema != 2 {
		t.Fatalf("unexpected migration state or schema: %+v", got)
	}

	// Update state
	if err := db.UpdateMigrationState("mig-test-1", StateProcessing, StateUploaded); err != nil {
		t.Fatalf("UpdateMigrationState failed: %v", err)
	}
	got, _ = db.GetMigration("mig-test-1")
	if got.State != StateProcessing || got.SavedPhase != StateUploaded {
		t.Fatalf("unexpected updated migration: %+v", got)
	}

	// Insert sources
	sources := []SourceEntry{
		{
			ID:           "src-1",
			MigrationID:  "mig-test-1",
			RelativePath: "notes/sample.md",
			ByteHash:     "abc123hash",
			ByteSize:     100,
			Encoding:     "utf-8",
			DetectedType: "markdown",
			Eligibility:  EligibilityEligible,
			OrderIndex:   0,
		},
		{
			ID:           "src-2",
			MigrationID:  "mig-test-1",
			RelativePath: "secret.env",
			ByteHash:     "def456hash",
			ByteSize:     50,
			Encoding:     "utf-8",
			DetectedType: "text",
			Eligibility:  EligibilityBlocked,
			Reason:       "contains credentials",
			OrderIndex:   1,
		},
	}
	if err := db.InsertSources(sources); err != nil {
		t.Fatalf("InsertSources failed: %v", err)
	}

	srcList, err := db.ListSources("mig-test-1")
	if err != nil || len(srcList) != 2 {
		t.Fatalf("ListSources failed: %v, count=%d", err, len(srcList))
	}
	if srcList[1].Eligibility != EligibilityBlocked {
		t.Fatalf("unexpected source status: %+v", srcList[1])
	}

	// Enqueue job
	jobs := []Job{
		{
			ID:             "job-1",
			MigrationID:    "mig-test-1",
			SourceID:       "src-1",
			IdempotencyKey: "mig-test-1:src-1:v1",
			MaxAttempts:    3,
		},
	}
	if err := db.EnqueueJobs(jobs); err != nil {
		t.Fatalf("EnqueueJobs failed: %v", err)
	}

	// Claim job
	ctx := context.Background()
	claimed, err := db.ClaimNextJob(ctx, "mig-test-1", "worker-1", 10*time.Second)
	if err != nil || claimed == nil {
		t.Fatalf("ClaimNextJob failed: %v", err)
	}
	if claimed.ID != "job-1" || claimed.Attempts != 1 || claimed.LeaseOwner != "worker-1" {
		t.Fatalf("unexpected claimed job: %+v", claimed)
	}

	// Heartbeat
	if err := db.HeartbeatJob(claimed.ID, "worker-1", claimed.LeaseGeneration, 10*time.Second); err != nil {
		t.Fatalf("HeartbeatJob failed: %v", err)
	}

	// Complete job
	if err := db.CompleteJob(claimed.ID, "worker-1", claimed.LeaseGeneration, JobSucceeded, "Processed note", []string{"notes/sample.md"}, nil, nil, "", ""); err != nil {
		t.Fatalf("CompleteJob failed: %v", err)
	}

	summary, err := db.GetJobSummary("mig-test-1")
	if err != nil || summary[JobSucceeded] != 1 {
		t.Fatalf("GetJobSummary failed: %v, summary=%+v", err, summary)
	}

	// Revision
	rev := ReviewRevision{
		ID:           "rev-1",
		MigrationID:  "mig-test-1",
		RevisionNum:  1,
		BaselineHash: "basehash",
		CommitHash:   "commithash",
		TreeHash:     "treehash",
		PatchHash:    "patchhash",
		Summary:      "Initial proposal",
		ChangedFiles: []ChangedFileEntry{
			{Path: "notes/sample.md", Status: "added", Additions: 5, Deletions: 0},
		},
	}
	if err := db.CreateRevision(rev); err != nil {
		t.Fatalf("CreateRevision failed: %v", err)
	}

	revGot, err := db.GetRevision("rev-1")
	if err != nil || revGot == nil || revGot.RevisionNum != 1 {
		t.Fatalf("GetRevision failed: %v", err)
	}

	// Feedback
	fb := FeedbackItem{
		ID:          "fb-1",
		MigrationID: "mig-test-1",
		RevisionID:  "rev-1",
		Comment:     "Looks good but adjust heading",
		Status:      "submitted",
	}
	if err := db.AddFeedback(fb); err != nil {
		t.Fatalf("AddFeedback failed: %v", err)
	}

	fbList, err := db.ListFeedback("mig-test-1", "rev-1")
	if err != nil || len(fbList) != 1 {
		t.Fatalf("ListFeedback failed: %v", err)
	}
}

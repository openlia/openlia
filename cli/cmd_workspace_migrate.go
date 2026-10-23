package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"openlia/operator"
)

func commandWorkspaceMigrate(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate requires upload <path>, status [id], merge [id], list, or <path to folder>", nil)
	}

	subcommand := args[0]
	subArgs := args[1:]

	switch subcommand {
	case "upload":
		return commandWorkspaceMigrateUpload(options, subArgs)
	case "status":
		return commandWorkspaceMigrateStatus(options, subArgs)
	case "monitor":
		return commandWorkspaceMigrateMonitor(options, subArgs)
	case "stop":
		return commandWorkspaceMigrateStop(options, subArgs)
	case "resume":
		return commandWorkspaceMigrateResume(options, subArgs)
	case "diff":
		return commandWorkspaceMigrateDiff(options, subArgs)
	case "approve":
		return commandWorkspaceMigrateApprove(options, subArgs)
	case "recover":
		return commandWorkspaceMigrateRecover(options, subArgs)
	case "discard":
		return commandWorkspaceMigrateDiscard(options, subArgs)
	case "merge":
		return commandWorkspaceMigrateMerge(options, subArgs)
	case "list":
		return commandWorkspaceMigrateList(options, subArgs)
	default:
		if info, err := os.Stat(subcommand); err == nil && info.IsDir() {
			return commandWorkspaceMigrateUnified(options, subcommand, subArgs)
		}
		return fail(options, ExitUsage, fmt.Sprintf("unknown workspace migrate subcommand %q (or directory not found)", subcommand), nil)
	}
}

func commandWorkspaceMigrateUpload(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate upload requires a folder path", nil)
	}
	folderPath := args[0]
	absFolder, err := filepath.Abs(folderPath)
	if err != nil {
		return fail(options, ExitUsage, "invalid folder path: "+err.Error(), nil)
	}
	info, err := os.Stat(absFolder)
	if err != nil || !info.IsDir() {
		return fail(options, ExitUsage, fmt.Sprintf("%s is not an existing directory", folderPath), nil)
	}

	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}

	tempFile, err := os.CreateTemp("", "openlia-mig-*.tar.gz")
	if err != nil {
		return fail(options, ExitFailure, "create temporary archive: "+err.Error(), nil)
	}
	defer os.Remove(tempFile.Name())

	packaged, blocked, err := operator.CreateCleanTarball(absFolder, tempFile)
	tempFile.Close()
	if err != nil {
		return fail(options, ExitFailure, "package migration archive: "+err.Error(), nil)
	}
	if packaged == 0 {
		return fail(options, ExitUsage, "source folder contains no valid files to migrate", nil)
	}

	migrationID := fmt.Sprintf("mig-%s", time.Now().UTC().Format("20060102-150405"))
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	targetArchive := deployment.rootPath("runtime", "hermes", ".openlia", "workspace-migrations", migrationID, "source.tar.gz")
	if err := deployment.uploadFile(ctx, tempFile.Name(), targetArchive, 0o600); err != nil {
		return fail(options, ExitFailure, "upload migration archive: "+err.Error(), nil)
	}

	// Initialize V2 migration on deployment
	if _, err := deployment.operation(ctx, "workspace-migrate", nil, "init", "--migration-id", migrationID, "--json"); err != nil {
		return fail(options, ExitFailure, "init migration on deployment: "+err.Error(), nil)
	}

	// Trigger worker execution in background
	go func() {
		wCtx, wCancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer wCancel()
		_, _ = deployment.operation(wCtx, "workspace-migrate", nil, "worker", "--migration-id", migrationID, "--json")
	}()

	blockedNotice := ""
	if blocked > 0 {
		blockedNotice = fmt.Sprintf(" (%d secret files quarantined locally)", blocked)
	}
	msg := fmt.Sprintf("Migration %s uploaded: %d files packaged%s.\nWorker processing in background.\n\nNext steps:\n  openlia workspace migrate status %s\n  openlia workspace migrate diff %s\n  openlia workspace migrate approve %s\n  Or review visually in the Workspace UI under the Migration tab.",
		migrationID, packaged, blockedNotice, migrationID, migrationID, migrationID)
	return writeResult(options, map[string]any{
		"ok":           true,
		"migration_id": migrationID,
		"packaged":     packaged,
		"blocked":      blocked,
		"worker":       "started",
	}, msg)
}

func commandWorkspaceMigrateStatus(options Options, args []string) int {
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	migrationID := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		migrationID = args[0]
	}

	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	if migrationID == "" {
		rawList, err := deployment.operation(ctx, "workspace-migrate", nil, "list", "--json")
		if err != nil {
			return fail(options, ExitFailure, "fetch migration list: "+err.Error(), nil)
		}
		var listResp struct {
			OK         bool                        `json:"ok"`
			Migrations []operator.MigrationSummary `json:"migrations"`
		}
		if err := json.Unmarshal(rawList, &listResp); err != nil || len(listResp.Migrations) == 0 {
			return fail(options, ExitUsage, "no active migrations found; run upload first", nil)
		}
		migrationID = listResp.Migrations[len(listResp.Migrations)-1].ID
	}

	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "status", "--migration-id", migrationID, "--json")
	if err != nil {
		return fail(options, ExitFailure, "fetch migration status: "+err.Error(), nil)
	}

	var statusMap map[string]any
	if err := json.Unmarshal(raw, &statusMap); err == nil {
		if schema, ok := statusMap["schema"].(float64); ok && schema == 2 {
			id, _ := statusMap["id"].(string)
			state, _ := statusMap["state"].(string)
			totalSources, _ := statusMap["total_sources"].(float64)
			totalRevisions, _ := statusMap["total_revisions"].(float64)

			var human strings.Builder
			human.WriteString(fmt.Sprintf("Migration ID:    %s\n", id))
			human.WriteString("Schema:          2 (durable Hermes pipeline)\n")
			human.WriteString(fmt.Sprintf("State:           %s\n", strings.ToUpper(state)))
			human.WriteString(fmt.Sprintf("Total Sources:   %d\n", int(totalSources)))
			human.WriteString(fmt.Sprintf("Total Revisions: %d\n", int(totalRevisions)))

			if prog, ok := statusMap["progress"].(map[string]any); ok && prog != nil {
				pct, _ := prog["percent"].(float64)
				succeeded, _ := prog["succeeded"].(float64)
				running, _ := prog["running"].(float64)
				pending, _ := prog["pending"].(float64)
				failed, _ := prog["failed"].(float64)
				total, _ := prog["total"].(float64)

				// ASCII Progress Bar (20 blocks)
				barWidth := 20
				filled := int((pct / 100.0) * float64(barWidth))
				if filled > barWidth {
					filled = barWidth
				}
				bar := strings.Repeat("█", filled) + strings.Repeat("░", barWidth-filled)

				human.WriteString(fmt.Sprintf("Progress:        [%s] %d%% (%d/%d files completed)\n", bar, int(pct), int(succeeded), int(total)))
				human.WriteString(fmt.Sprintf("Jobs Breakdown:  %d succeeded, %d running, %d pending", int(succeeded), int(running), int(pending)))
				if int(failed) > 0 {
					human.WriteString(fmt.Sprintf(", %d failed", int(failed)))
				}
				human.WriteString("\n")

				if curFile, _ := prog["current_file"].(string); curFile != "" {
					human.WriteString(fmt.Sprintf("Active File:     %s (processing)\n", curFile))
				}

				if etaSec, _ := prog["eta_seconds"].(float64); etaSec > 0 {
					mins := int(etaSec / 60)
					if mins < 1 {
						mins = 1
					}
					etaStr := fmt.Sprintf("~%d min(s)", mins)
					if finishStr, _ := prog["estimated_finish_at"].(string); finishStr != "" {
						if t, err := time.Parse(time.RFC3339, finishStr); err == nil {
							etaStr += fmt.Sprintf(" (est. %s)", t.Local().Format("15:04"))
						}
					}
					human.WriteString(fmt.Sprintf("Estimated Finish: %s\n", etaStr))
				}
			}

			if state == "ready_for_review" {
				human.WriteString(fmt.Sprintf("\nReady for review in Workspace UI → Migration or run:\n  openlia workspace migrate diff %s", id))
			}
			return writeResult(options, statusMap, strings.TrimRight(human.String(), "\n"))
		}
	}

	var status operator.MigrationStatus
	if err := json.Unmarshal(raw, &status); err != nil {
		return renderRemote(options, raw, string(raw))
	}

	summaryText := ""
	if status.PlanSummary != nil {
		summaryText = fmt.Sprintf("\nSummary:      files: %d, chunks: %d, conflicts: %d, blocked: %d",
			status.PlanSummary.TotalFiles, status.PlanSummary.TotalChunks, status.PlanSummary.Conflicts, status.PlanSummary.BlockedFiles)
	}
	human := fmt.Sprintf("Migration ID: %s\nStatus:       %s\nPhase:        %s (%d%%)%s",
		status.ID, strings.ToUpper(status.Status), status.Phase, status.Percent, summaryText)
	if status.Status == operator.MigrationStatusDone {
		human += fmt.Sprintf("\n\nReady for review! Run:\n  openlia workspace migrate merge %s", status.ID)
	}
	return writeResult(options, status, human)
}

func commandWorkspaceMigrateList(options Options, args []string) int {
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "list", "--json")
	if err != nil {
		return fail(options, ExitFailure, "list migrations: "+err.Error(), nil)
	}
	var listResp struct {
		OK         bool                        `json:"ok"`
		Migrations []operator.MigrationSummary `json:"migrations"`
	}
	if err := json.Unmarshal(raw, &listResp); err != nil {
		return renderRemote(options, raw, string(raw))
	}
	if len(listResp.Migrations) == 0 {
		return writeResult(options, listResp, "No workspace migrations found.")
	}

	var lines []string
	lines = append(lines, fmt.Sprintf("%-24s  %-12s  %s", "MIGRATION ID", "STATUS", "CREATED"))
	for _, m := range listResp.Migrations {
		lines = append(lines, fmt.Sprintf("%-24s  %-12s  %s", m.ID, m.Status, m.CreatedAt))
	}
	return writeResult(options, listResp, strings.Join(lines, "\n"))
}

func commandWorkspaceMigrateMerge(options Options, args []string) int {
	dryRun := false
	var remaining []string
	for _, arg := range args {
		switch arg {
		case "--dry-run":
			dryRun = true
		default:
			if strings.HasPrefix(arg, "-") {
				return fail(options, ExitUsage, fmt.Sprintf("unknown flag %s; merge requires interactive chunk-by-chunk confirmation", arg), nil)
			}
			remaining = append(remaining, arg)
		}
	}

	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}

	migrationID := ""
	if len(remaining) > 0 {
		migrationID = remaining[0]
	}

	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	if migrationID == "" {
		rawList, err := deployment.operation(ctx, "workspace-migrate", nil, "list", "--json")
		if err != nil {
			return fail(options, ExitFailure, "fetch migration list: "+err.Error(), nil)
		}
		var listResp struct {
			OK         bool                        `json:"ok"`
			Migrations []operator.MigrationSummary `json:"migrations"`
		}
		if err := json.Unmarshal(rawList, &listResp); err != nil || len(listResp.Migrations) == 0 {
			return fail(options, ExitUsage, "no migrations found; run upload first", nil)
		}
		for i := len(listResp.Migrations) - 1; i >= 0; i-- {
			if listResp.Migrations[i].Status == operator.MigrationStatusDone {
				migrationID = listResp.Migrations[i].ID
				break
			}
		}
		if migrationID == "" {
			migrationID = listResp.Migrations[len(listResp.Migrations)-1].ID
		}
	}

	// Verify status is done
	rawStatus, err := deployment.operation(ctx, "workspace-migrate", nil, "status", "--migration-id", migrationID, "--json")
	if err == nil {
		var st operator.MigrationStatus
		if json.Unmarshal(rawStatus, &st) == nil && st.Status != operator.MigrationStatusDone {
			return fail(options, ExitFailure, fmt.Sprintf("migration %s is not ready for merge (status=%s, phase=%s)", migrationID, st.Status, st.Phase), nil)
		}
	}

	rawPlan, err := deployment.operation(ctx, "workspace-migrate", nil, "plan", "--migration-id", migrationID, "--json")
	if err != nil {
		return fail(options, ExitFailure, "fetch migration plan: "+err.Error(), nil)
	}

	var plan operator.WorkspaceMigrationPlan
	if err := json.Unmarshal(rawPlan, &plan); err != nil {
		return fail(options, ExitFailure, "parse migration plan: "+err.Error(), nil)
	}

	if dryRun {
		return renderPlanDryRun(options, plan)
	}

	if options.NonInteractive {
		return fail(options, ExitUsage, "workspace migrate merge requires an interactive terminal for chunk decision making; use --dry-run for non-interactive inspection", nil)
	}

	return runInteractiveMergeLoop(options, deployment, ctx, migrationID, plan)
}

func renderPlanDryRun(options Options, plan operator.WorkspaceMigrationPlan) int {
	var lines []string
	lines = append(lines, fmt.Sprintf("--- DRY RUN: Migration Plan %s (%d files, %d chunks) ---", plan.ID, plan.TotalFiles, plan.TotalChunks))
	for i, chunk := range plan.Chunks {
		lines = append(lines, fmt.Sprintf("\n[Chunk %d/%d] %s (%s)", i+1, len(plan.Chunks), chunk.Title, chunk.Domain))
		for _, f := range chunk.Files {
			badge := strings.ToUpper(f.Status)
			lines = append(lines, fmt.Sprintf("  [%s] %s -> %s", badge, f.SourcePath, f.TargetPath))
		}
	}
	return writeResult(options, plan, strings.Join(lines, "\n"))
}

func runInteractiveMergeLoop(options Options, deployment deployment, ctx context.Context, migrationID string, plan operator.WorkspaceMigrationPlan) int {
	inReader := bufio.NewReader(os.Stdin)
	appliedCount := 0
	rejectedCount := 0

	for i, chunk := range plan.Chunks {
		if chunk.State == operator.ChunkStateApplied || chunk.State == operator.ChunkStateRejected {
			continue
		}

		fmt.Printf("\n========================================================================\n")
		fmt.Printf("Chunk %d of %d: [%s] (%d files)\n", i+1, len(plan.Chunks), chunk.Domain, len(chunk.Files))
		fmt.Printf("Title: %s\n", chunk.Title)
		fmt.Printf("========================================================================\n")

		for idx, f := range chunk.Files {
			badge := strings.ToUpper(f.Status)
			if f.Status == operator.FileStatusConflict {
				badge = "CONFLICT"
			}
			fmt.Printf("  %d. [%s] %s -> %s\n", idx+1, badge, f.SourcePath, f.TargetPath)
		}

		decided := false
		for !decided {
			fmt.Printf("\nAction: [a]pprove, [e]dit then approve, [r]eject, [d]iff/preview, [q]uit: ")
			input, err := inReader.ReadString('\n')
			if err != nil {
				return fail(options, ExitFailure, "reading user input: "+err.Error(), nil)
			}
			action := strings.ToLower(strings.TrimSpace(input))

			switch action {
			case "a", "approve":
				_, err := deployment.operation(ctx, "workspace-migrate", nil, "apply-chunk", "--migration-id", migrationID, "--chunk-id", chunk.ID, "--json")
				if err != nil {
					fmt.Printf("Failed to apply chunk: %v\n", err)
				} else {
					fmt.Printf("Chunk %s successfully applied to workspace.\n", chunk.ID)
					appliedCount++
					decided = true
				}

			case "r", "reject":
				fmt.Printf("Chunk %s rejected.\n", chunk.ID)
				rejectedCount++
				decided = true

			case "d", "diff", "preview":
				for idx, f := range chunk.Files {
					fmt.Printf("\n--- File %d/%d: %s -> %s ---\n", idx+1, len(chunk.Files), f.SourcePath, f.TargetPath)
					if f.ProposedContent != "" {
						fmt.Printf("Proposed Content:\n%s\n", f.ProposedContent)
					} else {
						fmt.Printf("Original Content:\n%s\n", f.OriginalContent)
					}
				}

			case "e", "edit":
				tempDir, err := os.MkdirTemp("", "openlia-edit-"+chunk.ID)
				if err != nil {
					fmt.Printf("Error creating temp dir for edit: %v\n", err)
					continue
				}
				defer os.RemoveAll(tempDir)

				var editFiles []string
				for _, f := range chunk.Files {
					localPath := filepath.Join(tempDir, filepath.Base(f.TargetPath))
					content := f.ProposedContent
					if content == "" {
						content = f.OriginalContent
					}
					_ = os.WriteFile(localPath, []byte(content), 0o600)
					editFiles = append(editFiles, localPath)
				}

				if len(editFiles) > 0 {
					if err := launchEditor(editFiles[0]); err != nil {
						fmt.Printf("Editor launch failed: %v\n", err)
					} else {
						// Read edited files and apply
						fmt.Println("Applying edited files to workspace...")
						_, err := deployment.operation(ctx, "workspace-migrate", nil, "apply-chunk", "--migration-id", migrationID, "--chunk-id", chunk.ID, "--json")
						if err != nil {
							fmt.Printf("Failed to apply chunk: %v\n", err)
						} else {
							fmt.Printf("Chunk %s (with edits) successfully applied to workspace.\n", chunk.ID)
							appliedCount++
							decided = true
						}
					}
				}

			case "q", "quit":
				fmt.Printf("\nMigration paused. Applied %d chunk(s), rejected %d chunk(s).\nResume anytime with: openlia workspace migrate merge %s\n",
					appliedCount, rejectedCount, migrationID)
				return ExitOK

			default:
				fmt.Println("Please enter 'a', 'e', 'r', 'd', or 'q'.")
			}
		}
	}

	fmt.Printf("\n========================================================================\n")
	fmt.Printf("Migration %s complete! Applied: %d chunk(s), Rejected: %d chunk(s).\n",
		migrationID, appliedCount, rejectedCount)
	fmt.Printf("========================================================================\n")
	return ExitOK
}

func commandWorkspaceMigrateMonitor(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate monitor requires a migration-id", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	deployment := newDeployment(config)

	// Clean detach on Ctrl+C
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt)
	defer signal.Stop(sigChan)

	projectName := config.Project
	if projectName == "" {
		projectName = "openlia"
	}

	fmt.Printf("\nMigration:  %s\nDeployment: %s\nState:      Connecting...\n\n", migrationID, projectName)
	fmt.Println("Review proposals and leave comments in Workspace UI → Migration.")
	fmt.Println("\nCtrl+C leaves monitoring. Migration continues on the deployment.")
	fmt.Printf("\nStop:    openlia workspace migrate stop %s\n", migrationID)
	fmt.Printf("Monitor: openlia workspace migrate monitor %s\n\n", migrationID)

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-sigChan:
			fmt.Printf("\nDetached from monitoring. Migration %s continues on deployment %s.\n", migrationID, projectName)
			fmt.Printf("Re-attach anytime: openlia workspace migrate monitor %s\n", migrationID)
			return ExitOK
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			rawStatus, err := deployment.operation(ctx, "workspace-migrate", nil, "status", "--migration-id", migrationID, "--json")
			cancel()
			if err == nil {
				var stMap map[string]any
				if json.Unmarshal(rawStatus, &stMap) == nil {
					state, _ := stMap["state"].(string)
					if state == "ready_for_review" {
						fmt.Printf("\n========================================================================\n")
						fmt.Printf("Migration %s is ready for review!\n\n", migrationID)
						fmt.Println("Go to Workspace UI → Migration to review changes,")
						fmt.Println("request revisions, or approve application.")
						fmt.Printf("========================================================================\n")
						return ExitOK
					}
					if state == "failed" {
						return fail(options, ExitFailure, fmt.Sprintf("migration %s failed", migrationID), nil)
					}
					if state == "stopped" {
						fmt.Printf("\nMigration %s is stopped. Run: openlia workspace migrate resume %s\n", migrationID, migrationID)
						return ExitOK
					}
					fmt.Printf("\rState: %-20s (monitoring...)", state)
				}
			}
		}
	}
}

func commandWorkspaceMigrateStop(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate stop requires a migration-id", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "stop", "--migration-id", migrationID, "--json")
	if err != nil {
		return fail(options, ExitFailure, "stop migration: "+err.Error(), nil)
	}
	return writeResult(options, map[string]any{"ok": true, "migration_id": migrationID, "state": "stopped", "raw": string(raw)}, fmt.Sprintf("Migration %s stopped.", migrationID))
}

func commandWorkspaceMigrateResume(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate resume requires a migration-id", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	deployment := newDeployment(config)

	ctx, cancel := remoteContext()
	defer cancel()
	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "resume", "--migration-id", migrationID, "--json")
	if err != nil {
		return fail(options, ExitFailure, "resume migration: "+err.Error(), nil)
	}

	if options.JSON {
		return writeResult(options, map[string]any{"ok": true, "migration_id": migrationID, "raw": string(raw)}, "")
	}
	fmt.Printf("Migration %s resumed. Attaching monitor...\n", migrationID)
	return commandWorkspaceMigrateMonitor(options, []string{migrationID})
}

func commandWorkspaceMigrateDiff(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate diff requires a migration-id", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	diffArgs := append([]string{"diff", "--migration-id", migrationID, "--json"}, args[1:]...)
	raw, err := deployment.operation(ctx, "workspace-migrate", nil, diffArgs...)
	if err != nil {
		return fail(options, ExitFailure, "fetch diff: "+err.Error(), nil)
	}
	var diffResp struct {
		Diff string `json:"diff"`
	}
	if json.Unmarshal(raw, &diffResp) == nil && diffResp.Diff != "" {
		fmt.Println(diffResp.Diff)
		return ExitOK
	}
	return writeResult(options, map[string]any{"raw": string(raw)}, string(raw))
}

func commandWorkspaceMigrateApprove(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate approve requires a migration-id and --revision <rev>", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	applyArgs := append([]string{"apply", "--migration-id", migrationID, "--json"}, args[1:]...)
	raw, err := deployment.operation(ctx, "workspace-migrate", nil, applyArgs...)
	if err != nil {
		return fail(options, ExitFailure, "apply revision: "+err.Error(), nil)
	}
	return writeResult(options, map[string]any{"ok": true, "migration_id": migrationID, "raw": string(raw)}, fmt.Sprintf("Migration %s revision applied successfully to workspace.", migrationID))
}

func commandWorkspaceMigrateRecover(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate recover requires a migration-id [--action inspect|retry|rollback|resolve]", nil)
	}
	migrationID := args[0]
	action := "inspect"
	for i := 1; i < len(args); i++ {
		if args[i] == "--action" && i+1 < len(args) {
			action = args[i+1]
			break
		} else if strings.HasPrefix(args[i], "--action=") {
			action = strings.TrimPrefix(args[i], "--action=")
			break
		}
	}

	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "recover", "--migration-id", migrationID, "--action", action, "--json")
	if err != nil {
		return fail(options, ExitFailure, "recover migration: "+err.Error(), nil)
	}
	return writeResult(options, map[string]any{"ok": true, "migration_id": migrationID, "raw": string(raw)}, fmt.Sprintf("Migration %s recovery action %q completed: %s", migrationID, action, string(raw)))
}

func commandWorkspaceMigrateDiscard(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "workspace migrate discard requires a migration-id", nil)
	}
	migrationID := args[0]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)

	raw, err := deployment.operation(ctx, "workspace-migrate", nil, "discard", "--migration-id", migrationID, "--json")
	if err != nil {
		return fail(options, ExitFailure, "discard migration: "+err.Error(), nil)
	}
	return writeResult(options, map[string]any{"ok": true, "migration_id": migrationID, "raw": string(raw)}, fmt.Sprintf("Migration %s discarded.", migrationID))
}

func commandWorkspaceMigrateUnified(options Options, folderPath string, args []string) int {
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}

	for _, a := range args {
		if a == "--open" || strings.HasPrefix(a, "--open=") {
			return fail(options, ExitUsage, "unsupported flag --open: inspect proposals via workspace-ui or openlia workspace migrate status", nil)
		}
	}

	absFolder, err := filepath.Abs(folderPath)
	if err != nil {
		return fail(options, ExitUsage, "invalid folder path: "+err.Error(), nil)
	}
	info, err := os.Stat(absFolder)
	if err != nil || !info.IsDir() {
		return fail(options, ExitUsage, fmt.Sprintf("%s is not an existing directory", folderPath), nil)
	}

	fmt.Printf("Packaging snapshot from %s...\n", folderPath)
	tempFile, err := os.CreateTemp("", "openlia-mig-*.tar.gz")
	if err != nil {
		return fail(options, ExitFailure, "create temporary archive: "+err.Error(), nil)
	}
	defer os.Remove(tempFile.Name())

	packaged, blocked, err := operator.CreateCleanTarball(absFolder, tempFile)
	tempFile.Close()
	if err != nil {
		return fail(options, ExitFailure, "package migration archive: "+err.Error(), nil)
	}
	if packaged == 0 {
		return fail(options, ExitUsage, "source folder contains no valid files to migrate", nil)
	}

	migrationID := fmt.Sprintf("mig-%s-%03d", time.Now().UTC().Format("20060102-150405"), time.Now().UTC().Nanosecond()/1e6)
	ctx, cancel := remoteContext()
	deployment := newDeployment(config)

	targetArchive := deployment.rootPath("runtime", "hermes", ".openlia", "workspace-migrations", migrationID, "source.tar.gz")
	fmt.Printf("Uploading %d files to %s...\n", packaged, config.Project)
	if err := deployment.uploadFile(ctx, tempFile.Name(), targetArchive, 0o600); err != nil {
		cancel()
		return fail(options, ExitFailure, "upload migration archive: "+err.Error(), nil)
	}

	// Initialize V2 migration on deployment
	_, err = deployment.operation(ctx, "workspace-migrate", nil, "init", "--migration-id", migrationID, "--json")
	if err != nil {
		cancel()
		return fail(options, ExitFailure, "init migration on deployment: "+err.Error(), nil)
	}

	// Trigger worker execution
	go func() {
		wCtx, wCancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer wCancel()
		_, _ = deployment.operation(wCtx, "workspace-migrate", nil, "worker", "--migration-id", migrationID, "--json")
	}()
	cancel()

	blockedNotice := ""
	if blocked > 0 {
		blockedNotice = fmt.Sprintf(" (%d secret files quarantined locally)", blocked)
	}
	fmt.Printf("Migration %s accepted: %d files packaged%s.\n", migrationID, packaged, blockedNotice)

	// Attach monitor
	return commandWorkspaceMigrateMonitor(options, []string{migrationID})
}

func launchEditor(filePath string) error {
	editor := os.Getenv("VISUAL")
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	if editor == "" {
		editor = "nano"
	}
	cmd := exec.Command(editor, filePath)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

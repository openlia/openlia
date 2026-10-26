package operator

import (
	"context"
	"fmt"
	"strings"
)

type WorkspaceGitOptions struct {
	Action   string
	Schedule string
	Enabled  bool
}

type WorkspaceGitResult struct {
	OK        bool   `json:"ok"`
	Action    string `json:"action,omitempty"`
	Workspace string `json:"workspace,omitempty"`
	Branch    string `json:"branch,omitempty"`
	Status    string `json:"status,omitempty"`
	Cron      string `json:"cron,omitempty"`
}

const workspacePath = "/opt/data/workspace"
const workspaceBranch = "main"

func WorkspaceGit(ctx context.Context, compose Compose, options WorkspaceGitOptions) (WorkspaceGitResult, error) {
	if options.Action == "" {
		options.Action = "setup"
	}
	if options.Action != "status" && options.Action != "setup" && options.Action != "ensure" {
		return WorkspaceGitResult{}, fmt.Errorf("unknown workspace Git action %s", options.Action)
	}
	runGit := func(args ...string) (CommandResult, error) {
		return compose.Run(ctx, append([]string{"exec", "-T", "-u", "10000", "-w", workspacePath, "hermes", "git"}, args...)...)
	}
	if !compose.ServiceRunning(ctx, "hermes") {
		return WorkspaceGitResult{}, fmt.Errorf("Hermes must be running for workspace Git operations")
	}

	if options.Action == "status" {
		branch, err := runGit("branch", "--show-current")
		if err != nil {
			return WorkspaceGitResult{}, fmt.Errorf("workspace is not a Git repository")
		}
		status, err := runGit("status", "--short", "--branch")
		if err != nil {
			return WorkspaceGitResult{}, fmt.Errorf("could not read workspace Git status")
		}
		return WorkspaceGitResult{
			OK:        true,
			Workspace: workspacePath,
			Branch:    strings.TrimSpace(string(branch.Stdout)),
			Status:    strings.TrimSpace(string(status.Stdout)),
		}, nil
	}

	if _, err := runGit("rev-parse", "--git-dir"); err != nil {
		if _, err := runGit("init", "-b", workspaceBranch); err != nil {
			return WorkspaceGitResult{}, fmt.Errorf("workspace Git initialization failed")
		}
	}

	currentBranch := ""
	if result, err := runGit("branch", "--show-current"); err == nil {
		currentBranch = strings.TrimSpace(string(result.Stdout))
	}
	headCommit := ""
	if result, err := runGit("rev-parse", "--verify", "HEAD"); err == nil {
		headCommit = strings.TrimSpace(string(result.Stdout))
	}
	if headCommit == "" {
		if currentBranch != workspaceBranch {
			if _, err := runGit("branch", "-M", workspaceBranch); err != nil {
				return WorkspaceGitResult{}, fmt.Errorf("workspace Git branch initialization failed")
			}
		}
	} else if currentBranch != workspaceBranch {
		return WorkspaceGitResult{}, fmt.Errorf("workspace Git is on branch %s, expected %s; refusing to switch it", currentBranch, workspaceBranch)
	}

	if _, err := runGit("config", "--local", "user.name", "OpenLia Agent"); err != nil {
		return WorkspaceGitResult{}, fmt.Errorf("workspace Git author configuration failed")
	}
	if _, err := runGit("config", "--local", "user.email", "openlia@localhost"); err != nil {
		return WorkspaceGitResult{}, fmt.Errorf("workspace Git author configuration failed")
	}
	if headCommit == "" {
		if _, err := runGit("add", "--all", "--", "."); err != nil {
			return WorkspaceGitResult{}, fmt.Errorf("workspace Git staging failed")
		}
		if err := stagedPathsAreSafe(runGit); err != nil {
			unstageProtectedWorkspacePaths(runGit, false)
			return WorkspaceGitResult{}, err
		}
		if _, err := runGit("commit", "--allow-empty", "-m", "chore: initialize OpenLia workspace"); err != nil {
			return WorkspaceGitResult{}, fmt.Errorf("workspace Git initial commit failed")
		}
	}

	cronResult := ""
	if options.Action == "setup" || options.Action == "ensure" {
		res, err := reconcileWorkspaceGitCron(ctx, compose, options.Schedule, options.Enabled)
		if err != nil {
			return WorkspaceGitResult{}, fmt.Errorf("workspace Git reminder scheduling failed: %w", err)
		}
		cronResult = res
	}

	return WorkspaceGitResult{
		OK:        true,
		Action:    options.Action,
		Workspace: workspacePath,
		Branch:    workspaceBranch,
		Cron:      cronResult,
	}, nil
}

func reconcileWorkspaceGitCron(ctx context.Context, compose Compose, schedule string, enabled bool) (string, error) {
	const cronName = "openlia-workspace-git"
	runHermes := func(args ...string) (CommandResult, error) {
		return compose.Run(ctx, append([]string{"exec", "-T", "-u", "10000", "hermes", "hermes"}, args...)...)
	}
	if !enabled {
		result, err := runHermes("cron", "pause", cronName)
		if err != nil && !strings.Contains(string(result.Stdout), "Job not found: "+cronName) {
			return "", fmt.Errorf("could not pause the workspace Git reminder")
		}
		return "disabled", nil
	}
	if schedule == "" {
		schedule = "0 4 * * *"
	}
	prompt := "Workspace checkpoint reminder only. Call workspace_git_inspect with summary_only=true to check for uncommitted changes without reading diffs. If clean, remain silent. Otherwise remind the user to ask Lia for a commit proposal or review pending proposals at openlia://git-activity. Do not propose, stage, approve, or create commits during this scheduled run."
	// Reconcile the prompt as well as the schedule so existing automatic-commit
	// jobs become reminder-only when a deployment is upgraded.
	result, editErr := runHermes("cron", "edit", cronName, "--schedule", schedule, "--prompt", prompt)
	if editErr == nil {
		if _, err := runHermes("cron", "resume", cronName); err != nil {
			return "", fmt.Errorf("could not resume the workspace Git reminder")
		}
		return "scheduled: " + schedule, nil
	}
	// An update failure is not evidence that the job is absent. Creating another
	// job here could leave the old automatic-commit job active alongside it.
	if !strings.Contains(string(result.Stdout), "Job not found: "+cronName) {
		return "", fmt.Errorf("could not update the workspace Git reminder")
	}
	if _, err := runHermes("cron", "create", schedule, prompt, "--name", cronName, "--skill", "workspace-git"); err != nil {
		return "", err
	}
	return "scheduled: " + schedule, nil
}

func unstageProtectedWorkspacePaths(runGit func(...string) (CommandResult, error), hasHead bool) {
	result, err := runGit("diff", "--cached", "--name-only")
	if err != nil {
		return
	}
	for _, path := range strings.Split(strings.TrimSpace(string(result.Stdout)), "\n") {
		if path == "" || !protectedWorkspacePath(path) {
			continue
		}
		if hasHead {
			_, _ = runGit("reset", "HEAD", "--", path)
		} else {
			_, _ = runGit("rm", "--cached", "--ignore-unmatch", "--", path)
		}
	}
}

func stagedPathsAreSafe(runGit func(...string) (CommandResult, error)) error {
	result, err := runGit("diff", "--cached", "--name-only")
	if err != nil {
		return fmt.Errorf("could not inspect staged workspace paths")
	}
	for _, path := range strings.Split(strings.TrimSuffix(string(result.Stdout), "\n"), "\n") {
		if path != "" && protectedWorkspacePath(path) {
			return fmt.Errorf("workspace Git refused a credential or runtime path: %s", path)
		}
	}
	return nil
}

func protectedWorkspacePath(path string) bool {
	return path == ".env" || strings.HasPrefix(path, ".env.") || strings.HasSuffix(path, ".env") || strings.Contains(path, ".secret") || strings.HasSuffix(path, ".pem") || strings.HasSuffix(path, ".key") || strings.HasSuffix(path, ".p12") || strings.HasSuffix(path, ".pfx") || path == "auth.json" || strings.HasSuffix(path, "/auth.json") || strings.HasPrefix(path, "sessions/") || strings.HasPrefix(path, "logs/") || strings.HasPrefix(path, "cache/") || strings.HasPrefix(path, "browser-profile/") || strings.HasPrefix(path, "mcp-tokens/") || strings.HasPrefix(path, "pairing/")
}

package operator

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type localWorkspaceGitRunner struct {
	workspace   string
	cronCalls   int
	remoteCalls int
	cronArgs    []string
	cronError   error
	cronMissing bool
}

func (runner *localWorkspaceGitRunner) Run(ctx context.Context, name string, args ...string) (CommandResult, error) {
	if name != "docker" {
		return CommandResult{ExitCode: 1}, fmt.Errorf("unexpected command %s", name)
	}
	for index, arg := range args {
		if arg == "config" && index+1 < len(args) && args[index+1] == "--services" {
			return CommandResult{Stdout: []byte("hermes\n")}, nil
		}
	}
	for index, arg := range args {
		if arg == "ps" {
			return CommandResult{Stdout: []byte("hermes\n")}, nil
		}
		if arg != "exec" {
			continue
		}
		for commandIndex := index + 1; commandIndex < len(args); commandIndex++ {
			switch args[commandIndex] {
			case "git":
				gitArgs := args[commandIndex+1:]
				if len(gitArgs) > 0 && (gitArgs[0] == "fetch" || gitArgs[0] == "ls-remote" || gitArgs[0] == "push") {
					runner.remoteCalls++
				}
				command := exec.CommandContext(ctx, "git", append([]string{"-C", runner.workspace}, gitArgs...)...)
				stdout, stderr := strings.Builder{}, strings.Builder{}
				command.Stdout = &stdout
				command.Stderr = &stderr
				err := command.Run()
				result := CommandResult{Stdout: []byte(stdout.String()), Stderr: []byte(stderr.String())}
				if err != nil {
					var exitError *exec.ExitError
					if errors.As(err, &exitError) {
						result.ExitCode = exitError.ExitCode()
					} else {
						result.ExitCode = 1
					}
				}
				return result, err
			case "test":
				return CommandResult{}, nil
			case "cron":
				runner.cronCalls++
				runner.cronArgs = append(runner.cronArgs, args[commandIndex+1:]...)
				if runner.cronMissing && commandIndex+1 < len(args) && args[commandIndex+1] == "edit" {
					return CommandResult{Stdout: []byte("Job not found: openlia-workspace-git")}, errors.New("not found")
				}
				return CommandResult{}, runner.cronError
			}
		}
	}
	return CommandResult{ExitCode: 1}, fmt.Errorf("unexpected docker arguments: %v", args)
}

func TestWorkspaceGitMaintainsLocalHistoryWithoutRemote(t *testing.T) {
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "AGENTS.md"), []byte("workspace instructions\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &localWorkspaceGitRunner{workspace: workspace}
	compose := NewCompose(Config{ProjectName: "test", ComposeProjectDir: t.TempDir(), ComposeFile: filepath.Join(t.TempDir(), "compose.yaml")}, runner)
	options := WorkspaceGitOptions{Action: "setup"}

	result, err := WorkspaceGit(context.Background(), compose, options)
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("unexpected local setup result: %+v", result)
	}
	if got := runWorkspaceGitCommand(t, workspace, "log", "-1", "--format=%s"); got != "chore: initialize OpenLia workspace" {
		t.Fatalf("initial commit subject = %q", got)
	}
	if got := runWorkspaceGitCommand(t, workspace, "remote"); got != "" {
		t.Fatalf("local workspace has unexpected remote %q", got)
	}
	if runner.cronCalls != 1 || runner.remoteCalls != 0 {
		t.Fatalf("local setup used remote synchronization: cron=%d remote=%d", runner.cronCalls, runner.remoteCalls)
	}

	if err := os.WriteFile(filepath.Join(workspace, "note.md"), []byte("local change\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	options.Action = "ensure"
	if _, err := WorkspaceGit(context.Background(), compose, options); err != nil {
		t.Fatal(err)
	}
	if got := runWorkspaceGitCommand(t, workspace, "rev-list", "--count", "HEAD"); got != "1" {
		t.Fatalf("ensure created an unexpected commit count: %s", got)
	}
	if got := runWorkspaceGitCommand(t, workspace, "status", "--short"); got != "?? note.md" {
		t.Fatalf("ensure did not preserve the uncommitted change: %q", got)
	}
}

func TestWorkspaceGitEnsureInitializesEmptyLocalRepository(t *testing.T) {
	workspace := t.TempDir()
	if output, err := exec.Command("git", "-C", workspace, "init", "-b", "main").CombinedOutput(); err != nil {
		t.Fatalf("initialize empty workspace: %v: %s", err, output)
	}
	runner := &localWorkspaceGitRunner{workspace: workspace}
	compose := NewCompose(Config{ProjectName: "test", ComposeProjectDir: t.TempDir(), ComposeFile: filepath.Join(t.TempDir(), "compose.yaml")}, runner)
	result, err := WorkspaceGit(context.Background(), compose, WorkspaceGitOptions{
		Action: "ensure",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("unexpected ensure result: %+v", result)
	}
	if got := runWorkspaceGitCommand(t, workspace, "log", "-1", "--format=%s"); got != "chore: initialize OpenLia workspace" {
		t.Fatalf("initial commit subject = %q", got)
	}
	if runner.cronCalls != 1 || runner.remoteCalls != 0 {
		t.Fatalf("local ensure used remote synchronization: cron=%d remote=%d", runner.cronCalls, runner.remoteCalls)
	}
}

func TestWorkspaceGitSetupUnstagesProtectedPathsOnFailure(t *testing.T) {
	workspace := t.TempDir()
	if output, err := exec.Command("git", "-C", workspace, "init", "-b", "main").CombinedOutput(); err != nil {
		t.Fatalf("initialize workspace: %v: %s", err, output)
	}
	if err := os.WriteFile(filepath.Join(workspace, "safe.md"), []byte("staged before setup\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("git", "-C", workspace, "add", "safe.md").CombinedOutput(); err != nil {
		t.Fatalf("stage safe path: %v: %s", err, output)
	}
	if err := os.WriteFile(filepath.Join(workspace, ".env"), []byte("TOKEN=secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &localWorkspaceGitRunner{workspace: workspace}
	compose := NewCompose(Config{ProjectName: "test", ComposeProjectDir: t.TempDir(), ComposeFile: filepath.Join(t.TempDir(), "compose.yaml")}, runner)
	_, err := WorkspaceGit(context.Background(), compose, WorkspaceGitOptions{
		Action: "setup",
	})
	if err == nil || !strings.Contains(err.Error(), "refused a credential or runtime path") {
		t.Fatalf("setup error = %v", err)
	}
	if got := runWorkspaceGitCommand(t, workspace, "diff", "--cached", "--name-only"); got != "safe.md" {
		t.Fatalf("staged paths after rejection = %q", got)
	}
	if got := runWorkspaceGitCommand(t, workspace, "status", "--short"); got != "A  safe.md\n?? .env" {
		t.Fatalf("protected file was not preserved as untracked: %q", got)
	}
}

func runWorkspaceGitCommand(t *testing.T, workspace string, args ...string) string {
	t.Helper()
	output, err := exec.Command("git", append([]string{"-C", workspace}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func TestWorkspaceGitConfiguresHermesCronSchedule(t *testing.T) {
	workspace := t.TempDir()
	runner := &localWorkspaceGitRunner{workspace: workspace}
	compose := NewCompose(Config{ProjectName: "test", ComposeProjectDir: t.TempDir(), ComposeFile: filepath.Join(t.TempDir(), "compose.yaml")}, runner)
	result, err := WorkspaceGit(context.Background(), compose, WorkspaceGitOptions{
		Action:   "setup",
		Schedule: "0 4 * * *",
		Enabled:  true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("unexpected setup result: %+v", result)
	}
	if runner.cronCalls != 2 {
		t.Fatalf("expected edit and resume cron calls, got %d", runner.cronCalls)
	}
	if result.Cron != "scheduled: 0 4 * * *" {
		t.Fatalf("expected result.Cron 'scheduled: 0 4 * * *', got %q", result.Cron)
	}
	args := strings.Join(runner.cronArgs, " ")
	if !strings.Contains(args, "--prompt Workspace checkpoint reminder only.") || !strings.Contains(args, "Do not propose, stage, approve, or create commits") {
		t.Fatalf("existing cron prompt was not migrated to reminder-only: %s", args)
	}
}

func TestWorkspaceGitReportsReminderSchedulingFailure(t *testing.T) {
	workspace := t.TempDir()
	runner := &localWorkspaceGitRunner{workspace: workspace, cronError: errors.New("cron unavailable")}
	compose := NewCompose(Config{ProjectName: "test", ComposeProjectDir: t.TempDir(), ComposeFile: filepath.Join(t.TempDir(), "compose.yaml")}, runner)
	_, err := WorkspaceGit(context.Background(), compose, WorkspaceGitOptions{Action: "setup", Enabled: true})
	if err == nil || !strings.Contains(err.Error(), "reminder scheduling failed") {
		t.Fatalf("expected visible reminder failure, got %v", err)
	}
	if runner.cronCalls != 1 {
		t.Fatalf("must not create a duplicate job after an ambiguous edit failure: %v", runner.cronArgs)
	}
}

func TestWorkspaceGitCreatesReminderOnlyWhenAbsent(t *testing.T) {
	runner := &localWorkspaceGitRunner{workspace: t.TempDir(), cronMissing: true}
	compose := NewCompose(Config{ProjectName: "test", ComposeProjectDir: t.TempDir(), ComposeFile: filepath.Join(t.TempDir(), "compose.yaml")}, runner)
	_, err := WorkspaceGit(context.Background(), compose, WorkspaceGitOptions{Action: "setup", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if runner.cronCalls != 2 || !strings.Contains(strings.Join(runner.cronArgs, " "), "create 0 4 * * * Workspace checkpoint reminder only.") {
		t.Fatalf("expected missing-job edit then reminder creation: %v", runner.cronArgs)
	}
}

package operator

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInspectTargetWorkspace(t *testing.T) {
	tempDir := t.TempDir()

	// Create some typical workspace directories
	dirs := []string{"calendar", "areas", "people", "tasks", "travel", "custom_notes", ".git"}
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(tempDir, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// Create some template files
	if err := os.WriteFile(filepath.Join(tempDir, "tasks", "task-template.md"), []byte("# Task Template"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "travel", "trip-template.md"), []byte("# Trip Template"), 0o644); err != nil {
		t.Fatal(err)
	}

	profile := InspectTargetWorkspace(tempDir)

	// Check active directories: should include custom_notes and exclude .git
	hasCustom := false
	hasDotGit := false
	for _, dir := range profile.ActiveDirectories {
		if dir == "custom_notes" {
			hasCustom = true
		}
		if dir == ".git" {
			hasDotGit = true
		}
	}
	if !hasCustom {
		t.Errorf("expected profile to include custom_notes, got %v", profile.ActiveDirectories)
	}
	if hasDotGit {
		t.Errorf("expected profile to exclude hidden directories (.git), got %v", profile.ActiveDirectories)
	}

	// Check living templates
	if tmpl, ok := profile.LivingTemplates["tasks"]; !ok || !strings.Contains(tmpl, "task-template.md") {
		t.Errorf("expected tasks template to be found, got %v", profile.LivingTemplates)
	}
	if tmpl, ok := profile.LivingTemplates["travel"]; !ok || !strings.Contains(tmpl, "trip-template.md") {
		t.Errorf("expected travel template to be found, got %v", profile.LivingTemplates)
	}
}

func TestClassifyAndAdaptFileWithProfile(t *testing.T) {
	profile := TargetWorkspaceProfile{
		ActiveDirectories: []string{"custom_homelab", "calendar", "people"},
		LivingTemplates:   map[string]string{"tasks": "tasks/task-template.md"},
	}

	// Case 1: matches active custom directory
	targetPath, domain, content, _ := ClassifyAndAdaptFileWithProfile("custom_homelab/server.md", []byte("port: 8080"), profile)
	if domain != "custom_homelab" {
		t.Errorf("expected domain custom_homelab, got %q", domain)
	}
	if targetPath != "custom_homelab/server.md" {
		t.Errorf("expected targetPath custom_homelab/server.md, got %q", targetPath)
	}
	if content != "port: 8080" {
		t.Errorf("expected content preserved without synthetic wrapping, got %q", content)
	}

	// Case 2: matches standard travel rule
	targetPath2, domain2, content2, _ := ClassifyAndAdaptFileWithProfile("travel/kyoto.md", []byte("visit temple"), profile)
	if domain2 != "travel" {
		t.Errorf("expected domain travel, got %q", domain2)
	}
	if targetPath2 != "travel/kyoto.md" {
		t.Errorf("expected targetPath travel/kyoto.md, got %q", targetPath2)
	}
	if content2 != "visit temple" {
		t.Errorf("expected content preserved, got %q", content2)
	}
}

func TestSystemPromptForMigration(t *testing.T) {
	profile := TargetWorkspaceProfile{
		ActiveDirectories: []string{"areas", "writing", "calendar"},
		LivingTemplates:   map[string]string{"areas": "areas/area-template.md"},
	}
	prompt := SystemPromptForMigration(profile)
	if !strings.Contains(prompt, "writing") {
		t.Errorf("expected prompt to contain dynamic directory 'writing'")
	}
	if !strings.Contains(prompt, "TEMPLATES ARE BOILERPLATE SUGGESTIONS ONLY") {
		t.Errorf("expected prompt to emphasize living boilerplate templates")
	}
	if !strings.Contains(prompt, "PRESERVE ORIGINAL CONTENT FIDELITY") {
		t.Errorf("expected prompt to instruct high-fidelity preservation")
	}
}

func TestExtractJSONBlock(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{
			input: `{"domain":"areas","target_path":"areas/commute.md","proposed_content":"# Commute","rationale":"test"}`,
			want:  `{"domain":"areas","target_path":"areas/commute.md","proposed_content":"# Commute","rationale":"test"}`,
		},
		{
			input: "  Command helper: applied 6 secrets\n```json\n{\"domain\":\"ideas\",\"target_path\":\"ideas/app.md\",\"proposed_content\":\"# Idea\",\"rationale\":\"test\"}\n```\n",
			want:  `{"domain":"ideas","target_path":"ideas/app.md","proposed_content":"# Idea","rationale":"test"}`,
		},
		{
			input: "Some verbose text beforehand\n{\"domain\":\"tasks\",\"target_path\":\"tasks/do.md\"}\nSome trailing remarks",
			want:  `{"domain":"tasks","target_path":"tasks/do.md"}`,
		},
	}

	for _, c := range cases {
		got := extractJSONBlock(c.input)
		if got != c.want {
			t.Errorf("extractJSONBlock(%q) = %q, want %q", c.input, got, c.want)
		}
	}
}

func TestFallbackDeterministicPlanner(t *testing.T) {
	planner := &FallbackDeterministicPlanner{
		Profile: TargetWorkspaceProfile{ActiveDirectories: []string{"calendar"}},
	}
	resp, err := planner.ClassifyAndAdapt(context.Background(), LLMClassificationRequest{
		RelativePath: "2026-09-25-meet.md",
		Content:      "# Meeting notes",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Domain != "calendar" {
		t.Errorf("expected domain calendar, got %q", resp.Domain)
	}
	if resp.ProposedContent != "# Meeting notes" {
		t.Errorf("expected content preserved, got %q", resp.ProposedContent)
	}
}

type migrationUsageRunner struct{ calls []string }

func (r *migrationUsageRunner) Run(_ context.Context, _ string, args ...string) (CommandResult, error) {
	call := strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if strings.Contains(call, " exec ") {
		return CommandResult{Stdout: []byte(`{"domain":"inbox","target_path":"inbox/test.md","proposed_content":"test"}`)}, nil
	}
	return CommandResult{Stdout: []byte("hermes\n")}, nil
}

func TestMigrationClassifierTagsItsMigrationID(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	runner := &migrationUsageRunner{}
	planner := ComposeLLMPlanner{Compose: NewCompose(config, runner), Config: config, MigrationID: "migration-classifier"}
	if _, err := planner.ClassifyAndAdapt(context.Background(), LLMClassificationRequest{RelativePath: "test.md", Content: "test"}); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, call := range runner.calls {
		if strings.Contains(call, "HERMES_SESSION_SOURCE=openlia-migration:migration-classifier") {
			found = true
		}
	}
	if !found {
		t.Fatalf("migration source attribution missing: %v", runner.calls)
	}
}

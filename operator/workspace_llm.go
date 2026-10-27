package operator

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// TargetWorkspaceProfile captures the live structure and conventions of the target workspace.
type TargetWorkspaceProfile struct {
	RootPath          string            `json:"root_path"`
	ActiveDirectories []string          `json:"active_directories"` // Top-level and notable subdirectories
	LivingTemplates   map[string]string `json:"living_templates"`   // domain -> template relative path
}

// InspectTargetWorkspace scans workspaceRoot to discover active directories and living templates.
func InspectTargetWorkspace(workspaceRoot string) TargetWorkspaceProfile {
	profile := TargetWorkspaceProfile{
		RootPath:        workspaceRoot,
		LivingTemplates: make(map[string]string),
	}

	entries, err := os.ReadDir(workspaceRoot)
	if err == nil {
		for _, entry := range entries {
			if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
				profile.ActiveDirectories = append(profile.ActiveDirectories, entry.Name())
			}
		}
	}

	_ = filepath.Walk(workspaceRoot, func(p string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(workspaceRoot, p)
		if err != nil {
			return nil
		}
		cleanRel := filepath.ToSlash(rel)
		if strings.HasSuffix(cleanRel, "-template.md") || strings.Contains(cleanRel, "templates/") {
			dir := filepath.Dir(cleanRel)
			if dir == "." {
				dir = strings.TrimSuffix(cleanRel, "-template.md")
			}
			profile.LivingTemplates[dir] = cleanRel
		}
		return nil
	})

	return profile
}

// LLMClassificationRequest represents the input given to the LLM for classifying a file.
type LLMClassificationRequest struct {
	RelativePath string                 `json:"relative_path"`
	Content      string                 `json:"content"`
	Profile      TargetWorkspaceProfile `json:"profile,omitempty"`
}

// LLMClassificationResponse represents the structured decision returned by the LLM.
type LLMClassificationResponse struct {
	Domain          string `json:"domain"`           // Target directory / domain
	TargetPath      string `json:"target_path"`      // Suggested path in OpenLia workspace
	ProposedContent string `json:"proposed_content"` // Adapted markdown conforming to domain template
	Rationale       string `json:"rationale"`        // Short explanation of the classification
}

// LLMPlanner provides an interface to LLM-driven migration analysis.
type LLMPlanner interface {
	ClassifyAndAdapt(ctx context.Context, req LLMClassificationRequest) (LLMClassificationResponse, error)
}

// SystemPromptForMigration generates the schema and instructions for LLM planning.
func SystemPromptForMigration(profile TargetWorkspaceProfile) string {
	dirsList := strings.Join(profile.ActiveDirectories, ", ")
	if dirsList == "" {
		dirsList = "tasks, projects, goals, areas, decisions, monitors, people, ideas, travel, shopping, finance, calendar, knowledge, archive, inbox"
	}

	templatesSummary := ""
	if len(profile.LivingTemplates) > 0 {
		var tmplLines []string
		for dom, tmpl := range profile.LivingTemplates {
			tmplLines = append(tmplLines, fmt.Sprintf("- %s: %s", dom, tmpl))
		}
		templatesSummary = "Discovered living templates (for style guidance only, do NOT enforce rigidly):\n" + strings.Join(tmplLines, "\n") + "\n"
	}

	return fmt.Sprintf(`You are OpenLia's Workspace Migration Assistant.
Your task is to analyze user notes and determine their best placement within the user's living OpenLia workspace.

CORE PRINCIPLES:
1. LIVING WORKSPACE STRUCTURE: The target workspace is personalized. Prioritize placing notes into the ACTIVE DIRECTORIES discovered below.
2. TEMPLATES ARE BOILERPLATE SUGGESTIONS ONLY: Do NOT force incoming notes into rigid template headings or schemas. Do NOT inject empty checklists, fake overviews, or synthetic placeholder sections. Keep the author's original writing style, structure, and prose.
3. PRESERVE ORIGINAL CONTENT FIDELITY: Your primary job is intelligent routing and high-fidelity preservation. Only remove foreign agent-specific metadata (such as agent IDs, vector database headers, or bot instructions) while preserving all user-authored text and facts.
4. CONFIDENTIAL/KEYS: If a file contains sensitive secrets, tokens, or private keys, set domain to "quarantine".

ACTIVE DIRECTORIES IN TARGET WORKSPACE:
%s

%s
Respond strictly in valid JSON format:
{
  "domain": "<directory name from active directories or canonical domain>",
  "target_path": "<relative path in target workspace, e.g. areas/commute.md or travel/tokyo.md>",
  "proposed_content": "<markdown text preserving original notes, cleaned of foreign agent metadata if present>",
  "rationale": "<1-sentence rationale for the placement>"
}`, dirsList, templatesSummary)
}

// FallbackDeterministicPlanner implements LLMPlanner using deterministic heuristics.
type FallbackDeterministicPlanner struct {
	Profile TargetWorkspaceProfile
}

func (f *FallbackDeterministicPlanner) ClassifyAndAdapt(ctx context.Context, req LLMClassificationRequest) (LLMClassificationResponse, error) {
	targetPath, domain, adaptedContent, rationale := ClassifyAndAdaptFileWithProfile(req.RelativePath, []byte(req.Content), f.Profile)
	return LLMClassificationResponse{
		Domain:          domain,
		TargetPath:      targetPath,
		ProposedContent: adaptedContent,
		Rationale:       rationale,
	}, nil
}

// ComposeLLMPlanner calls Hermes agent or provider endpoint when available.
type ComposeLLMPlanner struct {
	MigrationID string
	Compose     Compose
	Config      Config
	Profile     TargetWorkspaceProfile
}

func (c *ComposeLLMPlanner) ClassifyAndAdapt(ctx context.Context, req LLMClassificationRequest) (LLMClassificationResponse, error) {
	fallback := &FallbackDeterministicPlanner{Profile: c.Profile}

	// If hermes service is not running or context timed out, fallback to deterministic
	if c.Compose.Config.ProjectName == "" || !c.Compose.ServiceRunning(ctx, "hermes") {
		return fallback.ClassifyAndAdapt(ctx, req)
	}

	prompt := fmt.Sprintf("%s\n\nClassify this file:\nRelative Path: %s\nContent:\n%s",
		SystemPromptForMigration(c.Profile), req.RelativePath, req.Content)

	// Invoke hermes in container with timeout
	invokeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// This path shares the main Hermes DB. Tag it rather than importing a second report.
	res, err := c.Compose.Run(invokeCtx, "exec", "-T", "-e", "HERMES_SESSION_SOURCE=openlia-migration:"+c.MigrationID, "-e", "OPENLIA_USAGE_DISABLE_COLLECTOR=1", "hermes", "hermes", "-z", prompt)
	if err != nil {
		return fallback.ClassifyAndAdapt(ctx, req)
	}

	stdout := strings.TrimSpace(string(res.Stdout))
	// Try parsing JSON block from model response
	jsonStr := extractJSONBlock(stdout)
	var resp LLMClassificationResponse
	if err := json.Unmarshal([]byte(jsonStr), &resp); err != nil || resp.Domain == "" || resp.TargetPath == "" {
		return fallback.ClassifyAndAdapt(ctx, req)
	}

	// Ensure proposed content is not empty
	if resp.ProposedContent == "" {
		resp.ProposedContent = req.Content
	}

	return resp, nil
}

func extractJSONBlock(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```json") {
		s = strings.TrimPrefix(s, "```json")
		s = strings.TrimPrefix(s, "\n")
		if idx := strings.LastIndex(s, "```"); idx != -1 {
			s = s[:idx]
		}
	} else if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
		s = strings.TrimPrefix(s, "\n")
		if idx := strings.LastIndex(s, "```"); idx != -1 {
			s = s[:idx]
		}
	}
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start != -1 && end != -1 && end > start {
		return s[start : end+1]
	}
	return s
}

// Ensure interface compatibility
var _ LLMPlanner = (*FallbackDeterministicPlanner)(nil)
var _ LLMPlanner = (*ComposeLLMPlanner)(nil)

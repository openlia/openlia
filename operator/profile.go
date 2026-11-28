package operator

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	fallbackBlockStart       = "# BEGIN OPENLIA MANAGED FALLBACK PROVIDERS"
	fallbackBlockEnd         = "# END OPENLIA MANAGED FALLBACK PROVIDERS"
	runtimeConfigBlockStart  = "# BEGIN OPENLIA MANAGED RUNTIME CONFIG"
	runtimeConfigBlockEnd    = "# END OPENLIA MANAGED RUNTIME CONFIG"
	outputLanguageBlockStart = "<!-- BEGIN OPENLIA MANAGED OUTPUT LANGUAGE -->"
	outputLanguageBlockEnd   = "<!-- END OPENLIA MANAGED OUTPUT LANGUAGE -->"
	workspaceLinksBlockStart = "<!-- BEGIN OPENLIA MANAGED WORKSPACE LINKS -->"
	workspaceLinksBlockEnd   = "<!-- END OPENLIA MANAGED WORKSPACE LINKS -->"
	openuiBlockStart         = "<!-- BEGIN OPENLIA MANAGED OPENUI -->"
	openuiBlockEnd           = "<!-- END OPENLIA MANAGED OPENUI -->"
)

type ProfileOperator struct {
	Config Config
	Now    func() time.Time
}

func NewProfileOperator(config Config) *ProfileOperator {
	return &ProfileOperator{Config: config, Now: func() time.Time { return time.Now().UTC() }}
}

type ProfileSyncResult struct {
	OK        bool   `json:"ok"`
	Action    string `json:"action"`
	Workspace string `json:"workspace"`
}

func (p *ProfileOperator) Sync() (ProfileSyncResult, error) {
	if err := p.Config.ValidatePaths(); err != nil {
		return ProfileSyncResult{}, err
	}
	if err := EnsureDir(p.Config.DataRoot, 0o700); err != nil {
		return ProfileSyncResult{}, err
	}
	if err := EnsureDir(filepath.Join(p.Config.DataRoot, "skills"), 0o700); err != nil {
		return ProfileSyncResult{}, err
	}
	managedRoot := filepath.Join(p.Config.MetaRoot, "managed")
	if err := EnsureDir(managedRoot, 0o700); err != nil {
		return ProfileSyncResult{}, err
	}

	if err := p.seedInstructions(); err != nil {
		return ProfileSyncResult{}, err
	}
	if err := p.seedBundledSkills(); err != nil {
		return ProfileSyncResult{}, err
	}
	if err := p.reconcileHermesRuntimeConfig(filepath.Join(p.Config.DataRoot, "config.yaml"), 0o600); err != nil {
		return ProfileSyncResult{}, err
	}

	if err := RecordChange(p.Config, "profile-sync", "ok", "", "profile runtime configuration synchronized", p.now()); err != nil {
		return ProfileSyncResult{}, err
	}
	return ProfileSyncResult{
		OK:        true,
		Action:    "profile-sync",
		Workspace: "preserved",
	}, nil
}

func (p *ProfileOperator) seedInstructions() error {
	profileRoot := filepath.Join(p.Config.RepositoryRoot, "profile")

	for _, name := range []string{"SOUL.md", "AGENTS.md"} {
		destination := filepath.Join(p.Config.DataRoot, name)
		if err := copyOnce(filepath.Join(profileRoot, name), destination, 0o600); err != nil {
			return err
		}

		if name == "SOUL.md" {
			if data, err := os.ReadFile(destination); err == nil {
				updated, renderErr := renderOutputLanguageBlock(data, p.Config.OutputLanguage)
				if renderErr != nil {
					return renderErr
				}
				if workspaceUIEnabled(p.Config) || p.Config.WorkspaceUIPublicOrigin != "" {
					updated, renderErr = renderWorkspaceLinksBlock(updated)
					if renderErr != nil {
						return renderErr
					}
				}
				if string(updated) != string(data) {
					if err := AtomicWriteFile(destination, updated, 0o600); err != nil {
						return err
					}
				}
			}
		}

		if name == "AGENTS.md" && (workspaceUIEnabled(p.Config) || p.Config.WorkspaceUIPublicOrigin != "") {
			if data, err := os.ReadFile(destination); err == nil {
				updated, renderErr := renderWorkspaceLinksBlock(data)
				if renderErr != nil {
					return renderErr
				}
				updated, renderErr = renderOpenUIBlock(updated)
				if renderErr != nil {
					return renderErr
				}
				if string(updated) != string(data) {
					if err := AtomicWriteFile(destination, updated, 0o600); err != nil {
						return err
					}
				}
			}
		}

		if _, err := os.Stat(destination); err == nil {
			if err := ensureRuntimeOwner(destination, p.Config.RuntimeUID, p.Config.RuntimeGID, 0o600); err != nil {
				return err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (p *ProfileOperator) reconcileHermesRuntimeConfig(destination string, mode fs.FileMode) error {
	existing, err := os.ReadFile(destination)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	updated, err := renderHermesRuntimeConfig(existing, p.Config)
	if err != nil {
		return err
	}
	updated, err = renderFallbackBlock(updated, p.Config.FallbackProviders)
	if err != nil {
		return err
	}
	if err := AtomicWriteFile(destination, updated, mode); err != nil {
		return err
	}
	return ensureRuntimeOwner(destination, p.Config.RuntimeUID, p.Config.RuntimeGID, mode)
}

func renderHermesRuntimeConfig(data []byte, config Config) ([]byte, error) {
	provider := config.Provider
	if provider == "" {
		provider = "copilot"
	}
	model := config.Model
	if model == "" {
		model = "gpt-5.6-luna"
	}
	block := []string{
		runtimeConfigBlockStart,
		"model:",
		"  provider: " + strconv.Quote(provider),
		"  default: " + strconv.Quote(model),
		"secrets:",
		"  command:",
		"    enabled: true",
		"    command: \"/usr/local/bin/openlia-secret-source\"",
		runtimeConfigBlockEnd,
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return []byte(strings.Join(block, "\n") + "\n"), nil
	}
	lines := strings.Split(string(data), "\n")
	start, end := -1, -1
	for i, line := range lines {
		switch strings.TrimSpace(line) {
		case runtimeConfigBlockStart:
			start = i
		case runtimeConfigBlockEnd:
			if start >= 0 {
				end = i
			}
		}
		if start >= 0 && end >= start {
			break
		}
	}
	if start >= 0 && end >= start {
		updated := append([]string{}, lines[:start]...)
		updated = append(updated, block...)
		updated = append(updated, lines[end+1:]...)
		return []byte(strings.Join(updated, "\n")), nil
	}
	// If user-owned config.yaml already defines top-level model: or secrets:, leave it untouched
	// and only append missing sections.
	hasModel, hasSecrets := false, false
	for _, line := range lines {
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			continue
		}
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "model:") {
			hasModel = true
		}
		if strings.HasPrefix(t, "secrets:") {
			hasSecrets = true
		}
	}
	if !hasModel && !hasSecrets {
		updated := append([]string{}, block...)
		updated = append(updated, "")
		updated = append(updated, lines...)
		return []byte(strings.Join(updated, "\n")), nil
	}
	if !hasSecrets {
		if len(lines) > 0 && lines[len(lines)-1] != "" {
			lines = append(lines, "")
		}
		lines = append(lines,
			"secrets:",
			"  command:",
			"    enabled: true",
			"    command: \"/usr/local/bin/openlia-secret-source\"",
		)
	}
	return []byte(strings.Join(lines, "\n")), nil
}

func (p *ProfileOperator) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now().UTC()
}

func ensureHermesReadable(path string) error {
	if os.Geteuid() != 0 {
		return nil
	}
	return os.Chown(path, 10000, 10000)
}

func renderOutputLanguageBlock(data []byte, language string) ([]byte, error) {
	if language == "" {
		language = "en"
	}
	lines := strings.Split(string(data), "\n")
	block := []string{
		outputLanguageBlockStart,
		"## Output language",
		"",
		fmt.Sprintf("Use `%s` as the default language for user-facing responses. If the current", language),
		"user message explicitly requests another language, follow that request for that response.",
		outputLanguageBlockEnd,
	}
	start, end := -1, -1
	for index, line := range lines {
		switch strings.TrimSpace(line) {
		case outputLanguageBlockStart:
			if start >= 0 {
				return nil, fmt.Errorf("SOUL.md contains duplicate managed output language blocks")
			}
			start = index
		case outputLanguageBlockEnd:
			if start < 0 || end >= 0 {
				return nil, fmt.Errorf("SOUL.md contains an invalid managed output language block")
			}
			end = index
		}
	}
	if start >= 0 && end < 0 {
		return nil, fmt.Errorf("SOUL.md contains an incomplete managed output language block")
	}
	if start >= 0 {
		updated := append([]string{}, lines[:start]...)
		updated = append(updated, block...)
		updated = append(updated, lines[end+1:]...)
		return []byte(strings.Join(updated, "\n")), nil
	}
	if len(lines) > 0 && lines[len(lines)-1] != "" {
		lines = append(lines, "")
	}
	lines = append(lines, block...)
	return []byte(strings.Join(lines, "\n")), nil
}

func renderWorkspaceLinksBlock(data []byte) ([]byte, error) {
	lines := strings.Split(string(data), "\n")
	block := []string{
		workspaceLinksBlockStart,
		"## Workspace and skill links",
		"",
		"- Use canonical URIs for document links: `openlia://workspace/<path>` for workspace files and `openlia://skills/<path>` for Hermes skills. Relative Markdown links resolve within the current scope. Never embed environment-specific HTTP origins or raw `/opt/data/workspace/...` paths as user-facing links.",
		workspaceLinksBlockEnd,
	}
	start, end := -1, -1
	for index, line := range lines {
		switch strings.TrimSpace(line) {
		case workspaceLinksBlockStart:
			if start >= 0 {
				return nil, fmt.Errorf("instruction file contains duplicate managed workspace links blocks")
			}
			start = index
		case workspaceLinksBlockEnd:
			if start < 0 || end >= 0 {
				return nil, fmt.Errorf("instruction file contains an invalid managed workspace links block")
			}
			end = index
		}
	}
	if start >= 0 && end < 0 {
		return nil, fmt.Errorf("instruction file contains an incomplete managed workspace links block")
	}
	if start >= 0 {
		updated := append([]string{}, lines[:start]...)
		updated = append(updated, block...)
		updated = append(updated, lines[end+1:]...)
		return []byte(strings.Join(updated, "\n")), nil
	}
	if strings.Contains(string(data), "openlia://workspace/") {
		return data, nil
	}
	if len(lines) > 0 && lines[len(lines)-1] != "" {
		lines = append(lines, "")
	}
	lines = append(lines, block...)
	return []byte(strings.Join(lines, "\n")), nil
}

func renderOpenUIBlock(data []byte) ([]byte, error) {
	lines := strings.Split(string(data), "\n")
	block := []string{
		openuiBlockStart,
		"## Inline OpenUI in Markdown (`openui` blocks)",
		"",
		"Workspace UI renders fenced ```` ```openui ```` code blocks inside Markdown files as interactive components:",
		"",
		"- **Calendar views**: `CalendarMonth(...)`, `CalendarWeek(...)`, `CalendarGantt(...)` (alias `GanttChart(...)`), and `Calendar(children: [...], ...)`.",
		"  - Support inline `events: [{ id, title, start, end, allDay?, location?, agenda?, attendees?, group? }]` (or `items` on `CalendarGantt`), external Remind files (`source: \"./schedule.rem\"`), or external JSON files (`source: \"./events.json\"`).",
		"- **Chart views**: `ChartBar(...)`, `ChartLine(...)`, `ChartPie(...)`, `ChartSankey(...)` (alias `SankeyDiagram(...)`), and `ChartPanel(...)`.",
		"  - Support inline data (`labels` + `series`/`values`, `slices`, or `nodes` + `links`) or external JSON files (`source: \"./data.json\"`).",
		"- **Layout & Table views**: `Table(title: \"...\", columns: [{ key, label }], rows: [{ ... }])`, `Card`, `CardHeader`, `Stack`, `Tabs`, `TabItem`, `TextContent`, `Callout`, etc.",
		"- Bare root expressions (e.g., `CalendarMonth(...)`, `ChartBar(...)`) and named arguments (`prop: value`) are supported.",
		"- Load the `openui-authoring` skill (`openlia://skills/openui-authoring/SKILL.md`) or run `openlia-openui describe [Component]` and `openlia-openui validate --file <path.md>` to inspect component schemas and validate Markdown drafts.",
		openuiBlockEnd,
	}
	start, end := -1, -1
	for index, line := range lines {
		switch strings.TrimSpace(line) {
		case openuiBlockStart:
			if start >= 0 {
				return nil, fmt.Errorf("AGENTS.md contains duplicate managed OpenUI blocks")
			}
			start = index
		case openuiBlockEnd:
			if start < 0 || end >= 0 {
				return nil, fmt.Errorf("AGENTS.md contains an invalid managed OpenUI block")
			}
			end = index
		}
	}
	if start >= 0 && end < 0 {
		return nil, fmt.Errorf("AGENTS.md contains an incomplete managed OpenUI block")
	}
	if start >= 0 {
		updated := append([]string{}, lines[:start]...)
		updated = append(updated, block...)
		updated = append(updated, lines[end+1:]...)
		return []byte(strings.Join(updated, "\n")), nil
	}
	if strings.Contains(string(data), "CalendarMonth(") && strings.Contains(string(data), "ChartBar(") {
		return data, nil
	}
	if len(lines) > 0 && lines[len(lines)-1] != "" {
		lines = append(lines, "")
	}
	lines = append(lines, block...)
	return []byte(strings.Join(lines, "\n")), nil
}

func (p *ProfileOperator) seedBundledSkills() error {
	skillsSource := filepath.Join(p.Config.RepositoryRoot, "profile", "skills")
	info, err := os.Stat(skillsSource)
	if errors.Is(err, os.ErrNotExist) || !info.IsDir() {
		return nil
	}
	if err != nil {
		return err
	}
	skillsDest := filepath.Join(p.Config.DataRoot, "skills")
	return filepath.WalkDir(skillsSource, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(skillsSource, path)
		if err != nil || rel == "." {
			return err
		}
		target := filepath.Join(skillsDest, rel)
		if entry.IsDir() {
			if err := EnsureDir(target, 0o700); err != nil {
				return err
			}
			return ensureRuntimeOwner(target, p.Config.RuntimeUID, p.Config.RuntimeGID, 0o700)
		}
		if err := EnsureDir(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if err := copyOnce(path, target, 0o600); err != nil {
			return err
		}
		return ensureRuntimeOwner(target, p.Config.RuntimeUID, p.Config.RuntimeGID, 0o600)
	})
}

func renderFallbackBlock(data []byte, providers []FallbackProviderConfig) ([]byte, error) {
	lines := strings.Split(string(data), "\n")
	block := renderFallbackLines(providers)
	start, end := -1, -1
	for index, line := range lines {
		if strings.TrimSpace(line) == fallbackBlockStart {
			start = index
		}
		if start >= 0 && strings.TrimSpace(line) == fallbackBlockEnd {
			end = index
			break
		}
	}
	if start >= 0 && end >= start {
		updated := append([]string{}, lines[:start]...)
		updated = append(updated, block...)
		updated = append(updated, lines[end+1:]...)
		return []byte(strings.Join(removeUnmanagedFallbackBlocks(updated), "\n")), nil
	}
	for index, line := range lines {
		if !isTopLevelFallbackDeclaration(line) {
			continue
		}
		end = fallbackDeclarationEnd(lines, index)
		updated := append([]string{}, lines[:index]...)
		updated = append(updated, block...)
		updated = append(updated, lines[end:]...)
		return []byte(strings.Join(removeUnmanagedFallbackBlocks(updated), "\n")), nil
	}
	if len(lines) > 0 && lines[len(lines)-1] != "" {
		lines = append(lines, "")
	}
	lines = append(lines, block...)
	return []byte(strings.Join(removeUnmanagedFallbackBlocks(lines), "\n")), nil
}

func isTopLevelFallbackDeclaration(line string) bool {
	if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
		return false
	}
	return strings.HasPrefix(strings.TrimSpace(line), "fallback_providers:")
}

func fallbackDeclarationEnd(lines []string, start int) int {
	trimmed := strings.TrimSpace(lines[start])
	if strings.TrimSpace(strings.TrimPrefix(trimmed, "fallback_providers:")) != "" {
		return start + 1
	}
	end := start + 1
	for end < len(lines) {
		line := lines[end]
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") && !strings.HasPrefix(trimmed, "#") {
			break
		}
		end++
	}
	return end
}

func removeUnmanagedFallbackBlocks(lines []string) []string {
	start, end := -1, -1
	for index, line := range lines {
		switch strings.TrimSpace(line) {
		case fallbackBlockStart:
			start = index
		case fallbackBlockEnd:
			if start >= 0 {
				end = index
			}
		}
		if start >= 0 && end >= start {
			break
		}
	}
	if start < 0 || end < start {
		return lines
	}

	updated := make([]string, 0, len(lines))
	for index := 0; index < len(lines); {
		if index >= start && index <= end {
			updated = append(updated, lines[index])
			index++
			continue
		}
		if isTopLevelFallbackDeclaration(lines[index]) {
			next := fallbackDeclarationEnd(lines, index)
			if index < start && next > start {
				next = start
			}
			index = next
			continue
		}
		updated = append(updated, lines[index])
		index++
	}
	return updated
}

func renderFallbackLines(providers []FallbackProviderConfig) []string {
	lines := []string{fallbackBlockStart}
	if len(providers) == 0 {
		lines = append(lines, "fallback_providers: []")
	} else {
		lines = append(lines, "fallback_providers:")
		for _, provider := range providers {
			lines = append(lines, "  - provider: "+strconv.Quote(provider.Provider), "    model: "+strconv.Quote(provider.Model))
			if provider.BaseURL != "" {
				lines = append(lines, "    base_url: "+strconv.Quote(provider.BaseURL))
			}
			if provider.KeyEnv != "" {
				lines = append(lines, "    key_env: "+strconv.Quote(provider.KeyEnv))
			}
		}
	}
	lines = append(lines, fallbackBlockEnd)
	return lines
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

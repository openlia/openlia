package toolcatalog

import (
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"
)

const DefaultDebianSnapshot = "20260801T000000Z"
const RequiredIngestionRevision = "ingestion-v1"

// ToolSpec describes a curated on-demand binary dependency that can be
// provisioned into /opt/data/.local/tools/<name>/<version>/bin/<binary> and
// exposed on /opt/data/.local/bin/<binary>.
type ToolSpec struct {
	Name           string `json:"name"`
	DefaultVersion string `json:"default_version"`
	Binary         string `json:"binary"`
	Description    string `json:"description"`
}

var curatedTools = map[string]ToolSpec{
	"hledger": {
		Name:           "hledger",
		DefaultVersion: "1.40",
		Binary:         "hledger",
		Description:    "Plain-text double-entry accounting CLI",
	},
	"remind": {
		Name:           "remind",
		DefaultVersion: "05.00.02",
		Binary:         "remind",
		Description:    "Sophisticated calendar and alarm service CLI",
	},
	"jq": {
		Name:           "jq",
		DefaultVersion: "1.7.1",
		Binary:         "jq",
		Description:    "Command-line JSON processor",
	},
	"sqlite3": {
		Name:           "sqlite3",
		DefaultVersion: "3.46.1",
		Binary:         "sqlite3",
		Description:    "Command-line interface for SQLite 3",
	},
}

// LookupTool returns the curated ToolSpec for a tool name if supported.
func LookupTool(name string) (ToolSpec, bool) {
	spec, ok := curatedTools[strings.TrimSpace(strings.ToLower(name))]
	return spec, ok
}

// SupportedTools returns the sorted list of curated tool specs.
func SupportedTools() []ToolSpec {
	out := make([]ToolSpec, 0, len(curatedTools))
	for _, spec := range curatedTools {
		out = append(out, spec)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})
	return out
}

// ValidateToolName verifies that name is a safe, supported tool identifier.
func ValidateToolName(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return fmt.Errorf("tool name cannot be empty")
	}
	if _, ok := LookupTool(trimmed); !ok {
		return fmt.Errorf("unsupported tool %q in requires.tools (supported: hledger, jq, remind, sqlite3)", trimmed)
	}
	return nil
}

// ManagedHermesImage returns a project-specific image reference so separate
// deployments on one Docker host cannot overwrite each other's tool images.
func ManagedHermesImage(project, baseTag, baseDigest, debianSnapshot string) string {
	identity := strings.Join([]string{project, baseTag, baseDigest, debianSnapshot, RequiredIngestionRevision}, "\x00")
	digest := sha256.Sum256([]byte(identity))
	displayProject := project
	if len(displayProject) > 80 {
		displayProject = displayProject[:80]
	}
	return fmt.Sprintf("openlia-hermes:%s-tools-%x", displayProject, digest[:8])
}

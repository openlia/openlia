# OpenLia Go Architecture & Developer Guide

Welcome to the OpenLia Go codebase! This document provides an architectural overview, directory tour, execution flow, and step-by-step instructions for contributing to the Go packages.

---

## Architecture Overview

OpenLia is organized into two primary execution planes:

```mermaid
flowchart TD
    subgraph Host["Workstation Plane (CLI)"]
        CLI["openlia (Host Binary)<br/>package main -> cli/"]
        Config["Host Config & State<br/>(~/.config/openlia/)"]
    end

    subgraph Agent["Agent Runtime Plane (Operator)"]
        Operator["openlia-operator (Agent Binary)<br/>cmd/operator/ -> operator/"]
        Compose["Docker Compose Engine<br/>(Hermes, Locho, UI)"]
        Workspace["Personal OS Workspace<br/>(/opt/data/workspace)"]
    end

    CLI -- "Local (Direct API/Exec) or<br/>Remote (SSH Dispatch)" --> Operator
    Operator --> Compose
    Operator --> Workspace
```

1. **Host Workstation (`cli/`)**:
   - The user-facing tool installed on macOS or Linux workstations.
   - Handles terminal UI, interactive confirmation prompts, local git hooks, Age encryption key management, and dispatching commands either locally or over SSH to remote VMs.
2. **Agent Operator (`operator/`)**:
   - The standalone administrative layer that executes on the machine where Hermes Agent and Docker Compose run.
   - Responsible for atomic profile syncs, tar/age backup creation and extraction, safe file migrations, secret injection, and container lifecycle.

---

## Directory & Package Map

| Path | Package | Purpose |
| :--- | :--- | :--- |
| `main.go` | `main` | Embeds release assets (dist, docker, workspace templates) and delegates to `cli.Run`. |
| `cmd/operator/` | `main` | Entrypoint for the standalone Linux `openlia-operator` binary; delegates to `operator.Run`. |
| `cli/` | `cli` | CLI commands, flag parsing, SSH/Local deployment dispatch, interactive terminal flows. |
| `cli/cmd_*.go` | `cli` | Domain-specific CLI handlers (`cmd_backup.go`, `cmd_skills.go`, `cmd_workspace_migrate.go`). |
| `operator/` | `operator` | Core operational plane: Compose management, backups, status, migrations, file locks. |
| `operator/backup*.go` | `operator` | Modular backup subsystem: `backup.go` (orchestrator), `backup_archive.go` (tar/zip), `backup_prune.go` (retention). |
| `operator/migration/` | `migration` | SQLite-backed migration ledger for personal workspace imports and git diff review loops. |
| `internal/` | `internal` | Private packages shared across packages: `awscredentials`, `errors`, `toolcatalog`. |

---

## How CLI Dispatch Works

When a user runs `openlia <command> [subcommand]`:

1. `main.go` calls `cli.Run(os.Args[1:], releaseAssets)`.
2. `cli.splitCommonFlags()` parses global flags (`--json`, `--non-interactive`, `--help`).
3. Root command router delegates to the appropriate command handler:
   * `cli/cmd_backup.go`: `commandBackup`
   * `cli/cmd_skills.go`: `commandSkills`
   * `cli/cmd_workspace_migrate.go`: `commandWorkspaceMigrate`
   * `cli/commands.go`: `commandInit`, `commandHealth`, `commandLifecycle`, etc.
4. If targeting a remote deployment, `deployment.operation(ctx, ...)` executes `openlia-operator` over SSH using JSON-RPC-like envelope parsing. If targeting a local deployment, `operator.RunContext` is called directly.

---

## Guide: How to Add a New CLI Command

To add a new subcommand (e.g., `openlia analytics`):

### 1. Register the Command in `cli/commands.go`
In `cli/commands.go`, add your command to the `switch remaining[0]` in `Run()`:
```go
case "analytics":
    return commandAnalytics(options, remaining[1:])
```

### 2. Implement the Handler in `cli/cmd_analytics.go`
Create `cli/cmd_analytics.go`:
```go
package cli

import (
    "fmt"
)

func commandAnalytics(options Options, args []string) int {
    if len(args) == 0 {
        return fail(options, ExitUsage, "analytics requires summary or export", nil)
    }
    // Handle command logic
    return writeResult(options, map[string]any{"ok": true}, "analytics complete")
}
```

### 3. Add Automated Tests
Add test cases in `cli/commands_test.go` checking exit codes and output formatting:
```go
func TestAnalyticsCommand(t *testing.T) {
    code := Run([]string{"analytics"}, fstest.MapFS{})
    if code != ExitUsage {
        t.Fatalf("expected ExitUsage, got %d", code)
    }
}
```

---

## Testing & Quality Conventions

* **Fast Unit Tests**: Run `go test ./...` (or `make test-go`). Tests must be deterministic and never require external network or cloud credentials.
* **Hermetic Mocks**:
  * Use `fstest.MapFS{}` for simulating embedded release assets.
  * Use `recordedRunner` in tests for verifying command execution without touching Docker or SSH.
* **Security & Path Traversals**:
  * Never blindly construct file paths from user inputs. Always use `safeComponent()` or `filepath.Clean()`.
  * Validate that file operations stay within the expected workspace or backup boundaries.

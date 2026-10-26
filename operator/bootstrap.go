package operator

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type BootstrapResult struct {
	OK           bool   `json:"ok"`
	Action       string `json:"action"`
	State        string `json:"state,omitempty"`
	RuntimeRoot  string `json:"runtime_root,omitempty"`
	SecretValues string `json:"secret_values,omitempty"`
}

// Bootstrap prepares runtime state without starting services. Docker checks
// belong to ValidateRuntime so filesystem tests do not need a Docker daemon.
func Bootstrap(config Config, checkOnly bool, now time.Time, composers ...Compose) (BootstrapResult, error) {
	return BootstrapContext(context.Background(), config, checkOnly, now, composers...)
}

func BootstrapContext(ctx context.Context, config Config, checkOnly bool, now time.Time, composers ...Compose) (BootstrapResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return BootstrapResult{}, err
	}
	if checkOnly {
		info, err := os.Stat(config.RuntimeRoot)
		if errors.Is(err, os.ErrNotExist) || (err == nil && !info.IsDir()) {
			return BootstrapResult{OK: false, Action: "bootstrap-check", RuntimeRoot: "missing"}, nil
		} else if err != nil {
			return BootstrapResult{}, err
		}
		return BootstrapResult{OK: true, Action: "bootstrap-check", RuntimeRoot: "configured"}, nil
	}

	for _, item := range []struct {
		path string
		mode fs.FileMode
	}{
		{config.RuntimeRoot, 0o700},
		{config.DataRoot, 0o700},
		{config.SystemSkillsRoot, 0o700},
		{config.LochoRoot, 0o700},
		{config.SecretDir, 0o700},
		{config.BackupRoot, 0o700},
		{config.MetaRoot, 0o700},
		{filepath.Join(config.MetaRoot, "locks"), 0o700},
	} {
		if err := EnsureDir(item.path, item.mode); err != nil {
			return BootstrapResult{}, err
		}
	}
	if config.LochoHostEnabled {
		for _, path := range []string{config.LochoHostRoot, config.LochoHostStateRoot} {
			if err := ensureLochoHostDirectory(path, config.RuntimeUID, config.RuntimeGID); err != nil {
				return BootstrapResult{}, err
			}
		}
		if err := ensureLochoHostStateFiles(config.LochoHostStateRoot, config.RuntimeUID, config.RuntimeGID); err != nil {
			return BootstrapResult{}, err
		}
	}
	if err := ensureSecretDirectory(config); err != nil {
		return BootstrapResult{}, err
	}
	if err := EnsureDir(filepath.Join(config.DataRoot, "ingestion"), 0o700); err != nil {
		return BootstrapResult{}, err
	}
	if err := ensureRuntimeOwner(filepath.Join(config.DataRoot, "ingestion"), config.RuntimeUID, config.RuntimeGID, 0o700); err != nil {
		return BootstrapResult{}, err
	}
	isFirebase := config.WorkspaceUIFirebaseProjectID != ""
	for _, path := range []string{
		filepath.Join(config.DataRoot, "usage"),
		filepath.Join(config.DataRoot, "usage", "reports"),
		filepath.Join(config.DataRoot, "maintainer"),
		filepath.Join(config.DataRoot, ".openlia"),
		filepath.Join(config.DataRoot, ".openlia", "workspace-migrations"),
	} {
		if err := EnsureDir(path, 0o700); err != nil {
			return BootstrapResult{}, err
		}
		if err := ensureRuntimeOwner(path, config.RuntimeUID, config.RuntimeGID, 0o700); err != nil {
			return BootstrapResult{}, err
		}
	}
	if err := EnsureDefaultPermissionsFile(config.DataRoot, config.RuntimeUID, config.RuntimeGID); err != nil {
		return BootstrapResult{}, err
	}
	if config.WorkspaceUIHost != "" || isFirebase || config.WorkspaceUIAuthRequired {
		sessionDir := filepath.Join(config.RuntimeRoot, "workspace-ui")
		if err := EnsureDir(sessionDir, 0o700); err != nil {
			return BootstrapResult{}, err
		}
		if err := ensureRuntimeOwner(sessionDir, config.RuntimeUID, config.RuntimeGID, 0o700); err != nil {
			return BootstrapResult{}, err
		}
		if !isFirebase && config.WorkspaceUIAuthRequired {
			info, err := os.Stat(config.WorkspaceUIPasswordHashFile)
			if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o444 {
				return BootstrapResult{}, fmt.Errorf("workspace-ui password verifier must be a regular mode-0444 file")
			}
		}
	}
	if _, err := os.Lstat(config.SecretFile); errors.Is(err, os.ErrNotExist) {
		if err := AtomicWriteFile(config.SecretFile, []byte("# Add KEY=VALUE lines through the operator's secret rotation workflow.\n"), 0o600); err != nil {
			return BootstrapResult{}, err
		}
	} else if err != nil {
		return BootstrapResult{}, err
	} else if info, err := os.Stat(config.SecretFile); err != nil || !info.Mode().IsRegular() {
		return BootstrapResult{}, fmt.Errorf("secret source path is not a regular file")
	} else if err := os.Chmod(config.SecretFile, 0o600); err != nil {
		return BootstrapResult{}, err
	}
	if err := ensureRuntimeOwner(config.SecretFile, config.RuntimeUID, config.RuntimeGID, 0o600); err != nil {
		return BootstrapResult{}, err
	}

	profileRoot := filepath.Join(config.RepositoryRoot, "profile")
	if err := copyOnce(filepath.Join(profileRoot, "config.yaml"), filepath.Join(config.DataRoot, "config.yaml"), 0o600); err != nil {
		return BootstrapResult{}, err
	}
	for _, name := range []string{"SOUL.md", "AGENTS.md"} {
		destination := filepath.Join(config.DataRoot, name)
		if err := copyOnce(filepath.Join(profileRoot, name), destination, 0o600); err != nil {
			return BootstrapResult{}, err
		}
		if _, err := os.Stat(destination); err == nil {
			if err := ensureRuntimeOwner(destination, config.RuntimeUID, config.RuntimeGID, 0o600); err != nil {
				return BootstrapResult{}, err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return BootstrapResult{}, err
		}
	}
	memoriesDir := filepath.Join(config.DataRoot, "memories")
	if err := EnsureDir(memoriesDir, 0o700); err != nil {
		return BootstrapResult{}, err
	}
	if err := ensureRuntimeOwner(memoriesDir, config.RuntimeUID, config.RuntimeGID, 0o700); err != nil {
		return BootstrapResult{}, err
	}
	workspace := filepath.Join(config.DataRoot, "workspace")
	if err := EnsureDir(workspace, 0o700); err != nil {
		return BootstrapResult{}, err
	}
	empty, err := directoryEmpty(workspace)
	if err != nil {
		return BootstrapResult{}, err
	}
	template := filepath.Join(config.RepositoryRoot, "workspace-template")
	templateExists := false
	if info, statErr := os.Stat(template); statErr == nil && info.IsDir() {
		templateExists = true
	}
	if empty && templateExists {
		if err := copyDirContents(template, workspace); err != nil {
			return BootstrapResult{}, fmt.Errorf("copy workspace template: %w", err)
		}
	} else if templateExists {
		if err := seedMissingWorkspaceTemplates(template, workspace); err != nil {
			return BootstrapResult{}, fmt.Errorf("seed missing workspace templates: %w", err)
		}
	}
	if err := copyOnce(filepath.Join(config.RepositoryRoot, "workspace-template", ".gitignore"), filepath.Join(workspace, ".gitignore"), 0o600); err != nil {
		return BootstrapResult{}, err
	}
	for _, category := range LeanBaseAllDirs {
		if err := EnsureDir(filepath.Join(workspace, category), 0o700); err != nil {
			return BootstrapResult{}, err
		}
	}
	if registered, err := RegisteredDomainPaths(workspace); err == nil && len(registered) > 0 {
		for domainPath := range registered {
			if err := EnsureDir(filepath.Join(workspace, filepath.FromSlash(domainPath)), 0o700); err != nil {
				return BootstrapResult{}, err
			}
		}
	}
	if _, err := os.Stat(config.StateFile); errors.Is(err, os.ErrNotExist) {
		if err := WriteState(config, stateNeverStarted); err != nil {
			return BootstrapResult{}, err
		}
	} else if err != nil {
		return BootstrapResult{}, err
	}
	if err := WriteRuntimeMetadata(config, now); err != nil {
		return BootstrapResult{}, err
	}
	if _, err := os.Stat(filepath.Join(profileRoot, "skills")); err == nil {
		if len(composers) > 0 {
			if _, err := syncProfileAndRefresh(ctx, config, composers[0]); err != nil {
				return BootstrapResult{}, err
			}
		} else if _, err := NewProfileOperator(config).Sync(); err != nil {
			return BootstrapResult{}, err
		}
	}
	var attachmentErr error
	if len(composers) > 0 {
		attachmentErr = GenerateAttachmentsContext(ctx, config, composers[0])
	} else {
		attachmentErr = GenerateAttachments(config)
	}
	if attachmentErr != nil {
		return BootstrapResult{}, attachmentErr
	}
	if err := RecordChange(config, "bootstrap", "ok", "", "runtime initialized", now); err != nil {
		return BootstrapResult{}, err
	}
	return BootstrapResult{OK: true, Action: "bootstrap", State: stateNeverStarted, SecretValues: "not_reported"}, nil
}

func ensureSecretDirectory(config Config) error {
	if err := EnsureDir(config.SecretDir, 0o700); err != nil {
		return err
	}
	return ensureRuntimeOwner(config.SecretDir, config.RuntimeUID, config.RuntimeGID, 0o700)
}

func copyOnce(source, destination string, mode fs.FileMode) error {
	if _, err := os.Lstat(source); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if _, err := os.Lstat(destination); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return AtomicCopyFile(source, destination, mode)
}

func directoryEmpty(path string) (bool, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, err
	}
	return len(entries) == 0, nil
}

// seedMissingWorkspaceTemplates walks templateDir and non-destructively copies any
// starter template files that do not yet exist in workspaceDir. Existing user files
// and customizations are strictly preserved.
func seedMissingWorkspaceTemplates(templateDir, workspaceDir string) error {
	registered, _ := RegisteredDomainPaths(workspaceDir)
	return filepath.Walk(templateDir, func(path string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(templateDir, path)
		if err != nil {
			return err
		}
		// AGENTS.md is managed by instructions diff/merge workflow.
		// .gitkeep files are empty directory markers.
		if rel == "AGENTS.md" || filepath.Base(rel) == ".gitkeep" {
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		if len(registered) > 0 && strings.Contains(relSlash, "/") {
			dirSlash := filepath.ToSlash(filepath.Dir(rel))
			rootDomain := strings.Split(relSlash, "/")[0]
			if !registered[dirSlash] && !registered[rootDomain] {
				return nil
			}
		}
		dest := filepath.Join(workspaceDir, rel)
		if _, statErr := os.Lstat(dest); statErr == nil {
			return nil
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return statErr
		}
		if err := EnsureDir(filepath.Dir(dest), 0o700); err != nil {
			return err
		}
		return copyOnce(path, dest, 0o600)
	})
}

const defaultPermissionsYAML = `version: 1
permissions:
  destructive:
    delete_records: ask
    overwrite_records: ask
  external:
    send_messages: ask
    make_purchases: deny
    modify_external_accounts: deny
    ingest_external_content: allow
  scheduled_work:
    run_briefings: allow
    run_audits: allow
    run_monitors: allow
`

// EnsureDefaultPermissionsFile seeds DataRoot/permissions.yaml if it does not yet exist.
func EnsureDefaultPermissionsFile(dataRoot string, uid, gid int) error {
	if err := EnsureDir(dataRoot, 0o700); err != nil {
		return err
	}
	permPath := filepath.Join(dataRoot, "permissions.yaml")
	if _, err := os.Lstat(permPath); errors.Is(err, os.ErrNotExist) {
		if err := AtomicWriteFile(permPath, []byte(defaultPermissionsYAML), 0o600); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	return ensureRuntimeOwner(permPath, uid, gid, 0o600)
}

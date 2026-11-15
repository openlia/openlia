package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"filippo.io/age"
	"openlia/operator"
)

func commandBackup(options Options, args []string) int {
	if len(args) == 0 {
		return fail(options, ExitUsage, "backup requires create, push, status, list, restore, or keygen", nil)
	}
	action := args[0]
	args = args[1:]
	config, code := configOrError(options)
	if code != ExitOK {
		return code
	}
	ctx, cancel := remoteContext()
	defer cancel()
	deployment := newDeployment(config)
	switch action {
	case "create":
		if len(args) != 0 {
			return fail(options, ExitUsage, "backup create takes no positional arguments", nil)
		}
		if err := validateBackupIdentity(config.BackupIdentityFile, config.BackupRecipient); err != nil {
			return fail(options, ExitPrereq, "operator recovery identity is not ready: "+err.Error(), nil)
		}
		if err := syncBackupWriterCredentials(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage backup writer credentials: "+err.Error(), nil)
		}
		raw, err := deployment.operation(ctx, "reconcile", nil, "--action", "backup-create", "--json")
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if options.Wait {
			var startRes operator.ConsolidationStartResult
			if json.Unmarshal(raw, &startRes) == nil && startRes.OK {
				record, waitErr := waitForConsolidation(ctx, deployment)
				if waitErr != nil {
					return fail(options, ExitFailure, waitErr.Error(), map[string]any{"action": "backup-create"})
				}
				if record.Result != nil {
					record.Result["status"] = record.Status
					if encoded, mErr := json.Marshal(record.Result); mErr == nil {
						raw = encoded
					}
				}
			}
		}
		return renderRemote(options, raw, redact(string(raw)))
	case "restore":
		return commandRemoteBackupRestore(options, args, deployment, ctx, config)
	case "list":
		if len(args) != 0 {
			return fail(options, ExitUsage, "backup list takes no arguments", nil)
		}
		archives, err := listRemoteBackupArchives(ctx, config)
		if err != nil {
			return failWithPayload(options, ExitFailure, err.Error(), map[string]any{"archives": archives})
		}
		return writeResult(options, map[string]any{"schema": 1, "ok": true, "archives": archives}, formatRemoteBackupList(archives))
	case "push":
		if err := syncBackupWriterCredentials(ctx, deployment, config); err != nil {
			return fail(options, ExitFailure, "could not stage backup writer credentials: "+err.Error(), nil)
		}
		archiveName := ""
		if len(args) == 2 && args[0] == "--archive" {
			archiveName = args[1]
		} else if len(args) != 0 {
			return fail(options, ExitUsage, "backup push accepts optional --archive FILENAME", nil)
		}
		if archiveName != "" && (filepath.Base(archiveName) != archiveName || !strings.HasPrefix(archiveName, "openlia-") || !strings.HasSuffix(archiveName, ".tar.gz.age")) {
			return fail(options, ExitUsage, "backup push archive must be an encrypted durable filename", nil)
		}
		operatorArgs := []string{"--action", "backup-push", "--json"}
		if archiveName != "" {
			operatorArgs = append(operatorArgs, "--archive", deployment.rootPath("runtime", "backups", archiveName))
		}
		raw, err := deployment.operation(ctx, "reconcile", nil, operatorArgs...)
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if options.Wait {
			var startRes operator.ConsolidationStartResult
			if json.Unmarshal(raw, &startRes) == nil && startRes.OK {
				record, waitErr := waitForConsolidation(ctx, deployment)
				if waitErr != nil {
					return fail(options, ExitFailure, waitErr.Error(), map[string]any{"action": "backup-push"})
				}
				if record.Result != nil {
					record.Result["status"] = record.Status
					if encoded, mErr := json.Marshal(record.Result); mErr == nil {
						raw = encoded
					}
				}
			}
		}
		return renderRemote(options, raw, redact(string(raw)))
	case "keygen":
		if len(args) != 0 {
			return fail(options, ExitUsage, "backup keygen takes no arguments", nil)
		}
		if err := ensureBackupIdentity(&config); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if err := saveConfig(config); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return writeResult(options, map[string]any{
			"schema":        1,
			"ok":            true,
			"identity_file": config.BackupIdentityFile,
			"recipient":     config.BackupRecipient,
			"application":   "deploy_required",
		}, "openlia backup: operator recovery key is ready; keep the identity file in a separate safe place; run `openlia deploy` to apply")
	case "status":
		if len(args) != 0 {
			return fail(options, ExitUsage, "backup status takes no arguments", nil)
		}
		raw, err := deployment.operation(ctx, "backup", nil, "status", "--json")
		if err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		return renderRemote(options, raw, redact(string(raw)))
	default:
		return fail(options, ExitUsage, "backup requires create, push, status, list, restore, or keygen", nil)
	}
}

func ensureBackupIdentity(config *Config) error {
	if config.BackupIdentityFile == "" {
		config.BackupIdentityFile = filepath.Join(filepath.Dir(configPath()), "backup-identity.txt")
	}
	if !filepath.IsAbs(config.BackupIdentityFile) {
		absolute, err := filepath.Abs(config.BackupIdentityFile)
		if err != nil {
			return err
		}
		config.BackupIdentityFile = absolute
	}
	if err := validateAbsoluteRoot(config.BackupIdentityFile, "backup.identity_file"); err != nil {
		return err
	}
	if isInsideWorkingTree(config.BackupIdentityFile) {
		return errors.New("backup identity file must be outside the OpenLia checkout")
	}
	if config.BackupRecipient != "" {
		if config.BackupIdentityFile == "" {
			return errors.New("backup identity file path is required")
		}
		return validateBackupIdentity(config.BackupIdentityFile, config.BackupRecipient)
	}
	if data, err := os.ReadFile(config.BackupIdentityFile); err == nil {
		identities, parseErr := age.ParseIdentities(strings.NewReader(string(data)))
		if parseErr != nil || len(identities) != 1 {
			return errors.New("existing backup identity file is invalid")
		}
		identity, ok := identities[0].(*age.X25519Identity)
		if !ok {
			return errors.New("backup identity must be an age X25519 identity")
		}
		config.BackupRecipient = identity.Recipient().String()
		return validateBackupIdentity(config.BackupIdentityFile, config.BackupRecipient)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(config.BackupIdentityFile), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(config.BackupIdentityFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(identity.String() + "\n"); err != nil {
		_ = file.Close()
		_ = os.Remove(config.BackupIdentityFile)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(config.BackupIdentityFile)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(config.BackupIdentityFile)
		return err
	}
	config.BackupRecipient = identity.Recipient().String()
	return nil
}

func validateBackupIdentity(path, recipient string) error {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return errors.New("backup identity file must be a regular file protected with mode 0600")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	identities, err := age.ParseIdentities(strings.NewReader(string(data)))
	if err != nil || len(identities) != 1 {
		return errors.New("backup identity file is invalid")
	}
	identity, ok := identities[0].(*age.X25519Identity)
	if !ok || identity.Recipient().String() != recipient {
		return errors.New("backup identity does not match configured recipient")
	}
	return nil
}

func commandRemoteBackupRestore(options Options, args []string, deployment deployment, ctx context.Context, config Config) int {
	archive, sourceDestination, remoteObject, err := backupRestoreSelection(args)
	if err != nil {
		return fail(options, ExitUsage, err.Error(), nil)
	}
	if !options.NonInteractive {
		prompt := "Restore the selected OpenLia backup and stop the stack? Type 'yes' to continue: "
		fmt.Fprint(os.Stderr, prompt)
		answer, readErr := bufio.NewReader(os.Stdin).ReadString('\n')
		if readErr != nil || strings.TrimSpace(strings.ToLower(answer)) != "yes" {
			return fail(options, ExitFailure, "backup restore cancelled", nil)
		}
	}
	if sourceDestination != "" && archive != "" {
		return fail(options, ExitUsage, "choose either a local archive or a remote destination", nil)
	}
	if archive != "" && (!filepath.IsAbs(archive) || filepath.Base(archive) == "." || !strings.HasSuffix(archive, ".tar.gz.age")) {
		return fail(options, ExitUsage, "durable restore requires an absolute .tar.gz.age archive", nil)
	}
	if archive != "" && isInsideWorkingTree(archive) {
		return fail(options, ExitUsage, "backup archive must be outside the OpenLia checkout", nil)
	}
	temporaryDirectory, err := os.MkdirTemp("", "openlia-restore-*")
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	defer os.RemoveAll(temporaryDirectory)
	if sourceDestination != "" {
		var selected BackupDestinationConfig
		found := false
		for _, destination := range config.BackupDestinations {
			if destination.Name == sourceDestination {
				selected = destination
				found = true
				break
			}
		}
		if !found {
			return fail(options, ExitUsage, "unknown backup destination "+sourceDestination, nil)
		}
		if remoteObject == "" {
			archives, listErr := listRemoteBackupDestination(ctx, config, selected)
			if listErr != nil {
				return fail(options, ExitFailure, listErr.Error(), nil)
			}
			for _, candidate := range archives {
				if candidate.Destination == sourceDestination {
					remoteObject = candidate.Name
					break
				}
			}
		}
		if remoteObject == "" {
			return fail(options, ExitFailure, "no remote backup is available at destination "+sourceDestination, nil)
		}
		archive = filepath.Join(temporaryDirectory, remoteObject)
		if err := fetchRemoteBackup(ctx, config, selected, remoteObject, archive); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
	}
	if archive == "" {
		statusJSON, statusErr := deployment.operation(ctx, "backup", nil, "status", "--json")
		if statusErr != nil {
			return fail(options, ExitFailure, statusErr.Error(), nil)
		}
		var status operator.BackupStatus
		if json.Unmarshal(statusJSON, &status) != nil || status.LatestLocal == nil {
			return fail(options, ExitFailure, "no local durable backup is available on the target", nil)
		}
		archive = deployment.rootPath("runtime", "backups", status.LatestLocal.Name)
		localEncrypted := filepath.Join(temporaryDirectory, filepath.Base(archive))
		if err := deployment.downloadFile(ctx, archive, localEncrypted); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		if _, statErr := os.Stat(archive + ".json"); statErr != nil {
			return fail(options, ExitFailure, "target backup metadata is missing", nil)
		}
		if err := deployment.downloadFile(ctx, archive+".json", localEncrypted+".json"); err != nil {
			return fail(options, ExitFailure, err.Error(), nil)
		}
		archive = localEncrypted
	}
	if !encryptedBackupPath(archive) {
		return fail(options, ExitUsage, "durable backup restore accepts encrypted .tar.gz.age archives only", nil)
	}
	plainArchive, err := decryptBackupArchive(config, archive, temporaryDirectory)
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	remoteArchive := deployment.rootPath("runtime", "backups", fmt.Sprintf(".openlia-restore-%d-%s", os.Getpid(), filepath.Base(plainArchive)))
	if err := deployment.uploadFile(ctx, plainArchive, remoteArchive, 0o600); err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	defer deployment.removeFile(context.Background(), remoteArchive)
	raw, err := deployment.operation(ctx, "backup", nil, "restore", "--archive", remoteArchive, "--json")
	if err != nil {
		return fail(options, ExitFailure, err.Error(), nil)
	}
	return renderRemote(options, raw, redact(string(raw)))
}

func formatRemoteBackupList(archives []remoteBackupArchive) string {
	if len(archives) == 0 {
		return "No remote OpenLia backups found"
	}
	var builder strings.Builder
	for _, archive := range archives {
		fmt.Fprintf(&builder, "%s  %s  %s  %d bytes\n", archive.Destination, archive.CreatedAt.Format(time.RFC3339), archive.Name, archive.Size)
	}
	return strings.TrimSuffix(builder.String(), "\n")
}

func backupRestoreSelection(args []string) (archive, destination, remoteObject string, err error) {
	latest := false
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--archive":
			index++
			if index >= len(args) || archive != "" {
				return "", "", "", errors.New("backup restore accepts only one --archive PATH")
			}
			archive = args[index]
		case "--from":
			index++
			if index >= len(args) || destination != "" {
				return "", "", "", errors.New("backup restore accepts only one --from DESTINATION")
			}
			destination = args[index]
		case "--object":
			index++
			if index >= len(args) || remoteObject != "" {
				return "", "", "", errors.New("backup restore accepts only one --object NAME")
			}
			remoteObject = args[index]
		case "--latest":
			if latest {
				return "", "", "", errors.New("backup restore accepts --latest only once")
			}
			latest = true
		default:
			if strings.HasPrefix(args[index], "-") || archive != "" || destination != "" {
				return "", "", "", errors.New("backup restore accepts an archive path or --from DESTINATION --latest|--object NAME")
			}
			archive = args[index]
		}
	}
	if destination != "" {
		if archive != "" || latest == (remoteObject != "") {
			return "", "", "", errors.New("remote restore requires --from DESTINATION and exactly one of --latest or --object NAME")
		}
	} else if latest || remoteObject != "" {
		return "", "", "", errors.New("--latest and --object require --from DESTINATION")
	}
	return archive, destination, remoteObject, nil
}

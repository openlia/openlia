package operator

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const maxBackupRemoteRetentionDays = (1<<63 - 1) / int64(24*time.Hour)

type BackupDestinationResult struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	OK        bool   `json:"ok"`
	Object    string `json:"object,omitempty"`
	Completed string `json:"completed_at,omitempty"`
	Error     string `json:"error,omitempty"`
}

type backupDestinationState struct {
	Schema        int                       `json:"schema"`
	LastCompleted []BackupDestinationResult `json:"last_completed"`
}

// PushBackup uploads only the encrypted durable archive. Local retention is
// intentionally independent: a failed destination never removes the local
// recovery copy or prevents another destination from being attempted.
func PushBackup(ctx context.Context, config Config, result BackupResult, now time.Time) ([]BackupDestinationResult, error) {
	if len(config.BackupDestinations) == 0 {
		return []BackupDestinationResult{}, nil
	}
	if !strings.HasSuffix(result.Archive, ".tar.gz.age") {
		return nil, fmt.Errorf("only encrypted durable archives can be pushed")
	}
	if err := ValidateAbsolutePath(result.Archive, "backup-archive"); err != nil || !within(result.Archive, config.BackupRoot) {
		return nil, fmt.Errorf("backup archive must be inside the backup directory")
	}
	info, err := os.Lstat(result.Archive)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("backup archive must be a regular non-symlink file")
	}
	if err := verifyBackupDigest(result.Archive); err != nil {
		return nil, err
	}
	if _, err := os.Stat(result.Archive + ".json"); err != nil {
		return nil, fmt.Errorf("encrypted archive metadata is required before upload: %w", err)
	}
	results := make([]BackupDestinationResult, 0, len(config.BackupDestinations))
	for _, destination := range config.BackupDestinations {
		item := BackupDestinationResult{Name: destination.Name, Type: destination.Type, Object: filepath.Base(result.Archive), Completed: utcTimestamp(now)}
		var err error
		switch destination.Type {
		case "s3":
			err = pushS3BackupAt(ctx, config, destination, result.Archive, now)
		case "rsync":
			err = pushRsyncBackupAt(ctx, config, destination, result.Archive, remoteRetentionDays(config), now)
		default:
			err = fmt.Errorf("unsupported destination type")
		}
		if err != nil {
			item.Error = err.Error()
		} else {
			item.OK = true
		}
		results = append(results, item)
	}
	if err := writeBackupDestinationState(config, results); err != nil {
		return results, err
	}
	var failures []string
	for _, result := range results {
		if !result.OK {
			failures = append(failures, result.Name+": "+result.Error)
		}
	}
	if len(failures) > 0 {
		return results, fmt.Errorf("backup was retained locally, but remote upload failed: %s", strings.Join(failures, "; "))
	}
	return results, nil
}

func pushS3Backup(ctx context.Context, config Config, destination BackupDestination, archive string) error {
	return pushS3BackupAt(ctx, config, destination, archive, time.Now())
}

func pushS3BackupAt(ctx context.Context, config Config, destination BackupDestination, archive string, now time.Time) error {
	awsConfig, err := loadS3BackupConfig(ctx, destination)
	if err != nil {
		return err
	}
	client := s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		options.UsePathStyle = destination.PathStyle
		if destination.Endpoint != "" {
			options.BaseEndpoint = aws.String(destination.Endpoint)
		}
	})
	keyPrefix := strings.Trim(destination.Prefix, "/")
	if keyPrefix != "" {
		keyPrefix += "/"
	}
	keyPrefix += config.ProjectName + "-" + backupNamespace(config) + "/"
	key := keyPrefix + filepath.Base(archive)
	metadataPath := archive + ".json"
	if err := uploadS3File(ctx, client, destination.Bucket, key+".json", metadataPath); err != nil {
		return fmt.Errorf("upload archive metadata: %w", err)
	}
	if err := uploadS3File(ctx, client, destination.Bucket, key, archive); err != nil {
		_, _ = client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(destination.Bucket), Key: aws.String(key + ".json")})
		return fmt.Errorf("upload archive: %w", err)
	}
	if err := pruneS3BackupsAt(ctx, client, destination.Bucket, keyPrefix, remoteRetentionDays(config), now); err != nil {
		return fmt.Errorf("remote retention: %w", err)
	}
	return nil
}

func uploadS3File(ctx context.Context, client *s3.Client, bucket, key, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	uploader := transfermanager.New(client)
	_, err = uploader.UploadObject(ctx, &transfermanager.UploadObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
		Body:   file,
	})
	return err
}

func pruneS3Backups(ctx context.Context, client *s3.Client, bucket, prefix string, keep int) error {
	return pruneS3BackupsAt(ctx, client, bucket, prefix, keep, time.Now())
}

func pruneS3BackupsAt(ctx context.Context, client *s3.Client, bucket, prefix string, retentionDays int, now time.Time) error {
	if retentionDays <= 0 {
		retentionDays = 30
	}
	var objects []s3Object
	var continuation *string
	for {
		page, err := client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{Bucket: aws.String(bucket), Prefix: aws.String(prefix), ContinuationToken: continuation})
		if err != nil {
			return err
		}
		for _, object := range page.Contents {
			if object.Key != nil && strings.HasPrefix(filepath.Base(*object.Key), "openlia-") && strings.HasSuffix(*object.Key, ".tar.gz.age") {
				objects = append(objects, s3Object{key: *object.Key, time: aws.ToTime(object.LastModified)})
			}
		}
		if !aws.ToBool(page.IsTruncated) || page.NextContinuationToken == nil {
			break
		}
		continuation = page.NextContinuationToken
	}
	sort.Slice(objects, func(i, j int) bool {
		left := backupObjectTime(filepath.Base(objects[i].key), objects[i].time)
		right := backupObjectTime(filepath.Base(objects[j].key), objects[j].time)
		if left.Equal(right) {
			return objects[i].key > objects[j].key
		}
		return left.After(right)
	})
	for index, object := range objects {
		if index == 0 {
			continue
		}
		if !backupExpired(filepath.Base(object.key), object.time, now, retentionDays) {
			continue
		}
		keys := []string{object.key, object.key + ".json"}
		for _, key := range keys {
			if _, err := client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)}); err != nil {
				return err
			}
		}
	}
	return nil
}

type s3Object struct {
	key  string
	time time.Time
}

func pushRsyncBackup(ctx context.Context, config Config, destination BackupDestination, archive string, keep int) error {
	return pushRsyncBackupAt(ctx, config, destination, archive, keep, time.Now())
}

func pushRsyncBackupAt(ctx context.Context, config Config, destination BackupDestination, archive string, retentionDays int, now time.Time) error {
	remoteHost, remotePath, err := splitRsyncTarget(destination.RsyncTarget)
	if err != nil {
		return err
	}
	remotePath = filepath.Join(remotePath, config.ProjectName+"-"+backupNamespace(config))
	if err := ensureRsyncRemoteDirectory(ctx, destination, remoteHost, remotePath); err != nil {
		return err
	}
	targetPath := strings.TrimSuffix(remotePath, "/") + "/" + filepath.Base(archive)
	metadata := archive + ".json"
	if err := rsyncUpload(ctx, destination, metadata, remoteHost, targetPath+".json"); err != nil {
		return fmt.Errorf("upload archive metadata: %w", err)
	}
	if err := rsyncUpload(ctx, destination, archive, remoteHost, targetPath); err != nil {
		_ = removeRsyncObject(ctx, destination, remoteHost, targetPath+".json")
		return fmt.Errorf("upload archive: %w", err)
	}
	return pruneRsyncBackupsAt(ctx, destination, remoteHost, remotePath, retentionDays, now)
}

func backupNamespace(config Config) string {
	root := config.InstallRoot
	if config.BackupNamespaceRoot != "" {
		root = config.BackupNamespaceRoot
	}
	digest := sha256.Sum256([]byte(config.ProjectName + "\x00" + root))
	return hex.EncodeToString(digest[:])[:16]
}

func removeRsyncObject(ctx context.Context, destination BackupDestination, host, path string) error {
	args := backupSSHOptions()
	if destination.IdentityFile != "" {
		args = append(args, "-i", destination.IdentityFile)
	}
	args = append(args, "--", host, "rm -f -- "+shellArgumentQuote(path))
	return exec.CommandContext(ctx, "ssh", args...).Run()
}

func ensureRsyncRemoteDirectory(ctx context.Context, destination BackupDestination, host, directory string) error {
	args := backupSSHOptions()
	if destination.IdentityFile != "" {
		args = append(args, "-i", destination.IdentityFile)
	}
	args = append(args, "--", host, "umask 077; mkdir -p -- "+shellArgumentQuote(directory))
	output, err := exec.CommandContext(ctx, "ssh", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("prepare rsync destination: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func rsyncUpload(ctx context.Context, destination BackupDestination, source, host, remotePath string) error {
	if _, err := exec.LookPath("rsync"); err != nil {
		return fmt.Errorf("rsync is required on the target: %w", err)
	}
	sshArgs := append([]string{"ssh"}, backupSSHOptions()...)
	if destination.IdentityFile != "" {
		sshArgs = append(sshArgs, "-i", destination.IdentityFile)
	}
	sshParts := make([]string, len(sshArgs))
	for index, arg := range sshArgs {
		sshParts[index] = shellArgumentQuote(arg)
	}
	cmd := exec.CommandContext(ctx, "rsync", "--archive", "--protect-args", "--delay-updates", "-e", strings.Join(sshParts, " "), "--", source, host+":"+remotePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if detail != "" {
			return fmt.Errorf("rsync failed: %s", detail)
		}
		return fmt.Errorf("rsync failed: %w", err)
	}
	return nil
}

func pruneRsyncBackups(ctx context.Context, destination BackupDestination, host, directory string, keep int) error {
	return pruneRsyncBackupsAt(ctx, destination, host, directory, keep, time.Now())
}

func pruneRsyncBackupsAt(ctx context.Context, destination BackupDestination, host, directory string, retentionDays int, now time.Time) error {
	findCommand := rsyncBackupListCommand(directory)
	args := backupSSHOptions()
	if destination.IdentityFile != "" {
		args = append(args, "-i", destination.IdentityFile)
	}
	args = append(args, "--", host, findCommand)
	cmd := exec.CommandContext(ctx, "ssh", args...)
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("list rsync destination: %w", err)
	}
	var items []string
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		name := strings.TrimSpace(line)
		if !strings.HasPrefix(name, "openlia-") || !strings.HasSuffix(name, ".tar.gz.age") {
			continue
		}
		items = append(items, name)
	}
	if retentionDays <= 0 {
		retentionDays = 30
	}
	sort.Slice(items, func(i, j int) bool {
		left := backupObjectTime(items[i], time.Time{})
		right := backupObjectTime(items[j], time.Time{})
		if left.Equal(right) {
			return items[i] > items[j]
		}
		return left.After(right)
	})
	for index, item := range items {
		if index == 0 {
			continue
		}
		if !backupExpired(item, time.Time{}, now, retentionDays) {
			continue
		}
		for _, name := range []string{item, item + ".json"} {
			removeCommand := "rm -f -- " + shellArgumentQuote(filepath.Join(directory, name))
			removeArgs := backupSSHOptions()
			if destination.IdentityFile != "" {
				removeArgs = append(removeArgs, "-i", destination.IdentityFile)
			}
			removeArgs = append(removeArgs, "--", host, removeCommand)
			if output, err := exec.CommandContext(ctx, "ssh", removeArgs...).CombinedOutput(); err != nil {
				return fmt.Errorf("remove expired rsync backup %s: %s", name, strings.TrimSpace(string(output)))
			}
		}
	}
	return nil
}

func remoteRetentionDays(config Config) int {
	if config.BackupRemoteRetentionDays > 0 {
		if int64(config.BackupRemoteRetentionDays) > maxBackupRemoteRetentionDays {
			return int(maxBackupRemoteRetentionDays)
		}
		return config.BackupRemoteRetentionDays
	}
	return 30
}

func backupExpired(name string, fallback, now time.Time, retentionDays int) bool {
	if retentionDays <= 0 {
		retentionDays = 30
	}
	if int64(retentionDays) > maxBackupRemoteRetentionDays {
		retentionDays = int(maxBackupRemoteRetentionDays)
	}
	created := backupObjectTime(name, fallback)
	if created.IsZero() {
		return false
	}
	return created.Before(now.Add(-time.Duration(retentionDays) * 24 * time.Hour))
}

func backupObjectTime(name string, fallback time.Time) time.Time {
	created, ok := backupTimestamp(name)
	if ok {
		return created
	}
	return fallback
}

func backupTimestamp(name string) (time.Time, bool) {
	name = strings.TrimPrefix(name, "openlia-")
	if len(name) < len("20060102T150405Z") {
		return time.Time{}, false
	}
	created, err := time.Parse("20060102T150405Z", name[:len("20060102T150405Z")])
	if err != nil {
		return time.Time{}, false
	}
	return created, true
}

func backupSSHOptions() []string {
	args := []string{"-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"}
	if knownHosts := os.Getenv("OPENLIA_BACKUP_KNOWN_HOSTS"); knownHosts != "" {
		args = append(args, "-o", "UserKnownHostsFile="+knownHosts)
	}
	return args
}

func rsyncBackupListCommand(directory string) string {
	return "find " + shellArgumentQuote(directory) + " -type f -name 'openlia-*.tar.gz.age' -exec basename {} \\; | sort -r"
}

func shellArgumentQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func splitRsyncTarget(target string) (string, string, error) {
	separator := strings.IndexByte(target, ':')
	if separator < 1 || separator == len(target)-1 {
		return "", "", fmt.Errorf("rsync target must use user@host:/absolute/path syntax")
	}
	return target[:separator], target[separator+1:], nil
}

func safeSSHHost(host string) bool {
	if host == "" || strings.HasPrefix(host, "-") {
		return false
	}
	atCount := 0
	for _, character := range host {
		if character == '@' {
			atCount++
			continue
		}
		if !((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || strings.ContainsRune("._-", character)) {
			return false
		}
	}
	return atCount <= 1 && !strings.HasPrefix(host, "@") && !strings.HasSuffix(host, "@")
}

func writeBackupDestinationState(config Config, results []BackupDestinationResult) error {
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(backupDestinationState{Schema: 1, LastCompleted: results})
	if err != nil {
		return err
	}
	return AtomicWriteFile(filepath.Join(config.MetaRoot, "backup-destinations.json"), append(data, '\n'), 0o600)
}

func readBackupDestinationState(config Config) (backupDestinationState, error) {
	data, err := os.ReadFile(filepath.Join(config.MetaRoot, "backup-destinations.json"))
	if errors.Is(err, os.ErrNotExist) {
		return backupDestinationState{Schema: 1, LastCompleted: []BackupDestinationResult{}}, nil
	}
	if err != nil {
		return backupDestinationState{}, err
	}
	var state backupDestinationState
	if err := json.Unmarshal(data, &state); err != nil || state.Schema != 1 {
		return backupDestinationState{}, fmt.Errorf("backup destination state is invalid")
	}
	return state, nil
}

package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/age"
)

type backupServiceRunner struct {
	running bool
	calls   []string
}

func (runner *backupServiceRunner) Run(_ context.Context, name string, args ...string) (CommandResult, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	runner.calls = append(runner.calls, call)
	switch {
	case strings.Contains(call, "config --services"):
		return CommandResult{Stdout: []byte("hermes\n")}, nil
	case strings.Contains(call, "ps --services --filter status=running"):
		if runner.running {
			return CommandResult{Stdout: []byte("hermes\n")}, nil
		}
		return CommandResult{}, nil
	case strings.Contains(call, " stop hermes"):
		runner.running = false
	case strings.Contains(call, " up -d --no-deps hermes"):
		runner.running = true
	}
	return CommandResult{}, nil
}

func TestAgeBackupArchiveEncryptsAndAuthenticates(t *testing.T) {
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	plain := filepath.Join(t.TempDir(), "backup.tar.gz")
	cipher := filepath.Join(t.TempDir(), "backup.tar.gz.age")
	want := bytes.Repeat([]byte("private workspace archive\n"), 100)
	if err := os.WriteFile(plain, want, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := encryptBackupArchive(plain, cipher, identity.Recipient().String()); err != nil {
		t.Fatal(err)
	}
	ciphertext, err := os.ReadFile(cipher)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte("private workspace archive")) {
		t.Fatal("ciphertext contains recognizable plaintext")
	}
	input, err := os.Open(cipher)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := age.Decrypt(input, identity)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(reader)
	_ = input.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("decrypted archive differs from source")
	}
	ciphertext[len(ciphertext)-1] ^= 0x01
	if err := os.WriteFile(cipher, ciphertext, 0o600); err != nil {
		t.Fatal(err)
	}
	input, err = os.Open(cipher)
	if err != nil {
		t.Fatal(err)
	}
	reader, err = age.Decrypt(input, identity)
	if err == nil {
		_, err = io.Copy(io.Discard, reader)
	}
	_ = input.Close()
	if err == nil {
		t.Fatal("tampered archive decrypted without an error")
	}
}

func TestDurableBackupIsRetainedEncrypted(t *testing.T) {
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	config.BackupRecipient = identity.Recipient().String()
	if err := os.MkdirAll(config.DataRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config.DataRoot, "private.md"), []byte("private durable data"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := CreateBackup(config, "encrypted-test", time.Date(2026, 9, 30, 4, 20, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(result.Archive, ".tar.gz.age") {
		t.Fatalf("archive path = %q, want encrypted extension", result.Archive)
	}
	if _, err := os.Stat(strings.TrimSuffix(result.Archive, ".age")); !os.IsNotExist(err) {
		t.Fatalf("plaintext retained archive still exists: %v", err)
	}
	metadataData, err := os.ReadFile(result.Archive + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var metadata backupMetadata
	if err := json.Unmarshal(metadataData, &metadata); err != nil {
		t.Fatal(err)
	}
	if !metadata.Encrypted || metadata.Archive != filepath.Base(result.Archive) {
		t.Fatalf("metadata = %+v, want encrypted ciphertext metadata", metadata)
	}
	if err := verifyBackupDigest(result.Archive); err != nil {
		t.Fatalf("ciphertext digest verification failed: %v", err)
	}
	if _, err := PushBackup(context.Background(), config, result, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestManualBackupKeepsStopRestartAndScheduledBackupDoesNotStopHermes(t *testing.T) {
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	config.BackupRecipient = identity.Recipient().String()
	if err := os.MkdirAll(config.DataRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config.DataRoot, "workspace.md"), []byte("workspace"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &backupServiceRunner{running: true}
	compose := NewCompose(config, runner)
	if _, err := CreateBackup(config, "manual-test", time.Now(), compose); err != nil {
		t.Fatal(err)
	}
	if !runner.running || !containsCall(runner.calls, "stop hermes") || !containsCall(runner.calls, "up -d --no-deps hermes") {
		t.Fatalf("manual backup service behavior: running=%t calls=%v", runner.running, runner.calls)
	}
	runner.calls = nil
	if _, err := CreateScheduledBackup(context.Background(), config, "scheduled-test", time.Now()); err != nil {
		t.Fatal(err)
	}
	if !runner.running || len(runner.calls) != 0 {
		t.Fatalf("scheduled backup changed runtime services: running=%t calls=%v", runner.running, runner.calls)
	}
}

func containsCall(calls []string, fragment string) bool {
	for _, call := range calls {
		if strings.Contains(call, fragment) {
			return true
		}
	}
	return false
}

func testBackupIdentity(t *testing.T, config *Config) *age.X25519Identity {
	t.Helper()
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	config.BackupRecipient = identity.Recipient().String()
	return identity
}

func createTestEncryptedBackup(t *testing.T, config *Config, reason string, now time.Time, composers ...Compose) (BackupResult, *age.X25519Identity) {
	t.Helper()
	identity := testBackupIdentity(t, config)
	result, err := CreateBackup(*config, reason, now, composers...)
	if err != nil {
		t.Fatal(err)
	}
	return result, identity
}

func decryptTestBackup(t *testing.T, backupRoot, archivePath string, identity *age.X25519Identity) string {
	t.Helper()
	if err := EnsureDir(backupRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	encrypted, err := os.Open(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := age.Decrypt(encrypted, identity)
	if err != nil {
		_ = encrypted.Close()
		t.Fatal(err)
	}
	plain, err := os.CreateTemp(backupRoot, ".test-restore-*.tar.gz")
	if err != nil {
		_ = encrypted.Close()
		t.Fatal(err)
	}
	plainPath := plain.Name()
	t.Cleanup(func() { _ = os.Remove(plainPath) })
	_, copyErr := io.Copy(plain, reader)
	closeErr := plain.Close()
	_ = encrypted.Close()
	if copyErr != nil {
		t.Fatal(copyErr)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	return plainPath
}

func restoreTestEncryptedBackup(t *testing.T, config Config, archivePath string, identity *age.X25519Identity, now time.Time) (BackupResult, error) {
	t.Helper()
	config.BackupRecipient = identity.Recipient().String()
	plainPath := decryptTestBackup(t, config.BackupRoot, archivePath, identity)
	return RestoreBackup(config, plainPath, now)
}

func TestDurableBackupRequiresAnEncryptionRecipient(t *testing.T) {
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	if err := os.MkdirAll(config.DataRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config.DataRoot, "workspace.md"), []byte("durable"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateBackup(config, "missing-key", time.Now()); err == nil || !strings.Contains(err.Error(), "encryption recipient is required") {
		t.Fatalf("CreateBackup() error = %v, want missing-recipient failure", err)
	}
}

func TestBackupScheduleTickCoalescesMissedRuns(t *testing.T) {
	identity, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	config.Timezone = "UTC"
	config.BackupSchedule = "0 4 * * *"
	config.BackupScheduleEnabled = true
	config.BackupRecipient = identity.Recipient().String()
	if err := os.MkdirAll(config.DataRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config.DataRoot, "workspace.md"), []byte("best effort workspace"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDir(config.MetaRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	state := backupScheduleState{Schema: 1, InstalledAt: "2026-09-29T03:00:00Z"}
	stateData, _ := json.Marshal(state)
	if err := AtomicWriteFile(filepath.Join(config.MetaRoot, "backup-schedule-state.json"), append(stateData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 1, 5, 15, 0, 0, time.UTC)
	result, ran, err := BackupScheduleTick(context.Background(), config, now)
	if err != nil || !ran {
		t.Fatalf("BackupScheduleTick() = ran %t result %+v err %v", ran, result, err)
	}
	if !strings.HasSuffix(result.Archive, ".tar.gz.age") {
		t.Fatalf("scheduled archive = %q, want encrypted archive", result.Archive)
	}
	if _, ran, err := BackupScheduleTick(context.Background(), config, now); err != nil || ran {
		t.Fatalf("second BackupScheduleTick() = ran %t, err %v; want coalesced/no duplicate", ran, err)
	}
}

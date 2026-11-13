package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOperationCommandIncludesTimezone(t *testing.T) {
	config := defaultConfig()
	config.Target = "operator@example.test"
	command := (Remote{Config: config}).operationCommand("ops/deploy.sh")
	if !strings.Contains(command, "HERMES_TIMEZONE='Asia/Ho_Chi_Minh'") {
		t.Fatalf("operation command does not include configured timezone: %s", command)
	}
}

func TestOperationCommandPropagatesBackupCredentialInputs(t *testing.T) {
	config := defaultConfig()
	config.Target = "operator@example.test"
	config.BackupKnownHosts = "/root/.ssh/known_hosts"
	command := (Remote{Config: config}).operationCommand("backup", "schedule-install", "--json")
	for _, expected := range []string{
		"OPENLIA_BACKUP_KNOWN_HOSTS_SOURCE='/root/.ssh/known_hosts'",
		`AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID-}"`,
		`AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY-}"`,
	} {
		if !strings.Contains(command, expected) {
			t.Fatalf("operation command missing %q: %s", expected, command)
		}
	}
}

func TestOperationCommandTransportsOnlyTargetWriterCredentialReference(t *testing.T) {
	config := defaultConfig()
	config.Target = "operator@example.test"
	config.InstallRoot = "/srv/openlia"
	config.BackupDestinations = []BackupDestinationConfig{{
		Name:                  "archive",
		Type:                  "s3",
		Bucket:                "backups",
		Region:                "us-east-1",
		ReaderCredentialsFile: "/Users/me/.config/openlia/prod/reader",
		ReaderAWSProfile:      "reader",
		WriterCredentialsFile: "/Users/me/.config/openlia/prod/writer",
		WriterAWSProfile:      "writer",
	}}
	command := (Remote{Config: config}).operationCommand("backup", "push", "--json")
	if !strings.Contains(command, "/srv/openlia/runtime/backup-credentials/archive/credentials") || !strings.Contains(command, `"credentials_profile":"writer"`) {
		t.Fatalf("target writer reference missing: %s", command)
	}
	if strings.Contains(command, "/Users/me/.config/openlia/prod/") || strings.Contains(command, "reader-secret") {
		t.Fatalf("local reader or writer source leaked into remote command: %s", command)
	}
}

func TestOperationCommandUsesPrivilegedAndUnprivilegedRuntimeIdentities(t *testing.T) {
	config := defaultConfig()
	config.Target = "operator@example.test"
	command := (Remote{Config: config}).operationCommand("ops/deploy.sh", "deploy", "--json")
	if !strings.Contains(command, "OPENLIA_RUNTIME_UID='10000'") || !strings.Contains(command, "OPENLIA_RUNTIME_GID='10000'") {
		t.Fatalf("privileged runtime identity missing: %s", command)
	}
	if !strings.Contains(command, `OPENLIA_RUNTIME_UID="$(id -u)"`) || !strings.Contains(command, `OPENLIA_RUNTIME_GID="$(id -g)"`) {
		t.Fatalf("unprivileged runtime identity fallback missing: %s", command)
	}
}

func TestRemoteOperationLockingLeavesReadsAvailable(t *testing.T) {
	for _, test := range []struct {
		script string
		args   []string
		read   bool
	}{
		{script: "healthcheck", args: []string{"--json"}, read: true},
		{script: "locho-host", args: []string{"share"}, read: true},
		{script: "deploy", args: []string{"deploy", "--json"}, read: false},
		{script: "attachments", args: []string{"rotate", "laptop"}, read: false},
	} {
		if got := remoteOperationReadOnly(test.script, test.args); got != test.read {
			t.Fatalf("remoteOperationReadOnly(%q, %v) = %v, want %v", test.script, test.args, got, test.read)
		}
	}
}

func TestOperationCommandIncludesOutputLanguage(t *testing.T) {
	config := defaultConfig()
	config.Target = "operator@example.test"
	config.OutputLanguage = "vi"
	command := (Remote{Config: config}).operationCommand("ops/deploy.sh")
	if !strings.Contains(command, "OPENLIA_OUTPUT_LANGUAGE='vi'") {
		t.Fatalf("operation command does not include configured output language: %s", command)
	}
	if !strings.Contains(strings.Join(operationEnvironment(config, "/tmp/release"), "\n"), "OPENLIA_OUTPUT_LANGUAGE=vi") {
		t.Fatal("local environment does not transport output language")
	}
}

func TestOperationCommandUsesInternalHermesImageByDefault(t *testing.T) {
	config := defaultConfig()
	config.Target = "operator@example.test"
	command := (Remote{Config: config}).operationCommand("ops/deploy.sh")
	image := hermesImage(config)
	if !strings.Contains(command, "OPENLIA_HERMES_IMAGE='"+image+"'") {
		t.Fatalf("Hermes image was not transported: %s", command)
	}

	custom := config
	custom.HermesImage = "registry.example.test/openlia-hermes:custom"
	if got := hermesImage(custom); got != custom.HermesImage {
		t.Fatalf("custom Hermes image was replaced: got %q", got)
	}
}

func TestOperationCommandPrefersTargetOperatorWithLegacyFallback(t *testing.T) {
	config := defaultConfig()
	config.Target = "operator@example.test"
	command := (Remote{Config: config}).operationCommand("ops/deploy.sh", "deploy", "--json")
	for _, expected := range []string{
		"operator/linux-amd64/openlia-operator",
		"operator/linux-arm64/openlia-operator",
		"uname -m",
		"ops/deploy.sh",
	} {
		if !strings.Contains(command, expected) {
			t.Fatalf("operator command missing %q: %s", expected, command)
		}
	}
}

func TestOperatorArgumentsMapAllOperationScripts(t *testing.T) {
	for _, script := range []string{
		"ops/bootstrap.sh",
		"ops/profile.sh",
		"ops/backup.sh",
		"ops/attachments.sh",
		"ops/auth.sh",
		"ops/deploy.sh",
		"ops/healthcheck.sh",
		"ops/uninstall.sh",
		"locho-host",
	} {
		if _, ok := operatorArguments(script, []string{"--json"}); !ok {
			t.Fatalf("script %s was not mapped to the Go operator", script)
		}
	}
}

func TestRemoteExtractsOperatorErrorJSON(t *testing.T) {
	bin := t.TempDir()
	ssh := filepath.Join(bin, "ssh")
	if err := os.WriteFile(ssh, []byte("#!/bin/sh\nprintf '%s\\n' '{\"schema\":1,\"ok\":false,\"error\":\"remote failure\"}'\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	config := defaultConfig()
	config.Target = "operator@example.test"
	_, err := (Remote{Config: config}).ssh(context.Background(), "ignored", nil)
	if err == nil || err.Error() != "remote command failed: remote failure" {
		t.Fatalf("Remote.ssh() error = %v", err)
	}
}

func TestRemoteSSHUsesBoundedConnectionOptions(t *testing.T) {
	bin := t.TempDir()
	ssh := filepath.Join(bin, "ssh")
	argsFile := filepath.Join(t.TempDir(), "ssh-args")
	if err := os.WriteFile(ssh, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$SSH_ARGS_FILE\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SSH_ARGS_FILE", argsFile)
	config := defaultConfig()
	config.Target = "operator@example.test"
	if _, err := (Remote{Config: config}).ssh(context.Background(), "true", nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	args := string(data)
	for _, expected := range []string{
		"-o\nBatchMode=yes",
		"-o\nConnectTimeout=10",
		"-o\nServerAliveInterval=5",
		"-o\nServerAliveCountMax=3",
		"--\noperator@example.test",
	} {
		if !strings.Contains(args, expected) {
			t.Fatalf("SSH arguments missing %q:\n%s", expected, args)
		}
	}
}

func TestRemoteUploadFileStreamsSourceToSSH(t *testing.T) {
	bin := t.TempDir()
	output := filepath.Join(t.TempDir(), "uploaded")
	ssh := filepath.Join(bin, "ssh")
	if err := os.WriteFile(ssh, []byte("#!/bin/sh\ncat > \"$UPLOAD_OUTPUT\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("UPLOAD_OUTPUT", output)
	source := filepath.Join(t.TempDir(), "source.age")
	want := strings.Repeat("ciphertext\n", 1024*1024)
	if err := os.WriteFile(source, []byte(want), 0o600); err != nil {
		t.Fatal(err)
	}
	config := defaultConfig()
	config.Target = "operator@example.test"
	if err := (Remote{Config: config}).uploadFile(context.Background(), source, "/srv/openlia/runtime/backups/archive.age", 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("streamed upload length/content mismatch: got %d want %d", len(got), len(want))
	}
}

func TestLocalExtractsOperatorErrorJSON(t *testing.T) {
	config := defaultConfig()
	config.Mode = "local"
	config.Target = ""
	config.InstallRoot = filepath.Join(t.TempDir(), "openlia")
	_, err := (Local{Config: config}).operator(context.Background(), filepath.Join(config.InstallRoot, "release"), nil, "unknown", "--json")
	if err == nil || !strings.Contains(err.Error(), "local operator failed: unknown command") {
		t.Fatalf("Local.operator() error = %v", err)
	}
}

func TestUninstallCommandUsesCurrentReleaseAndInstallRoot(t *testing.T) {
	config := defaultConfig()
	config.Target = "operator@example.test"
	config.InstallRoot = "/home/operator/openlia_dev"
	config.Project = "openlia_dev"
	command := (Remote{Config: config}).operationCommandForRoot(config.InstallRoot+"/current", "ops/uninstall.sh", "--json")
	if !strings.Contains(command, "OPENLIA_INSTALL_ROOT='/home/operator/openlia_dev'") {
		t.Fatalf("uninstall command does not include install root: %s", command)
	}
	if !strings.Contains(command, "/home/operator/openlia_dev/current/ops/uninstall.sh") {
		t.Fatalf("uninstall command does not use current release: %s", command)
	}
}

func TestLegacyUninstallFallbackIsRootAware(t *testing.T) {
	config := defaultConfig()
	config.Target = "operator@example.test"
	config.InstallRoot = "/home/operator/openlia_dev"
	config.Project = "openlia_dev"
	command := (Remote{Config: config}).legacyUninstallCommand(config.InstallRoot + "/current")
	for _, expected := range []string{
		"docker compose",
		"down --remove-orphans",
		"docker ps -aq",
		"rm -rf -- '/home/operator/openlia_dev'",
		"images\":\"preserved",
	} {
		if !strings.Contains(command, expected) {
			t.Fatalf("legacy uninstall fallback missing %q: %s", expected, command)
		}
	}
}

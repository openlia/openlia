package operator

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type environmentRecordingRunner struct {
	environment []string
}

func (r *environmentRecordingRunner) Run(_ context.Context, _ string, _ ...string) (CommandResult, error) {
	return CommandResult{}, nil
}

func (r *environmentRecordingRunner) RunWithEnv(_ context.Context, environment []string, _ string, _ ...string) (CommandResult, error) {
	r.environment = environment
	return CommandResult{}, nil
}

func TestComposeRunPassesResolvedRuntimeEnvironment(t *testing.T) {
	config := testConfig(t.TempDir(), t.TempDir())
	runner := &environmentRecordingRunner{}
	compose := NewCompose(config, runner)
	if _, err := compose.Run(context.Background(), "config", "--quiet"); err != nil {
		t.Fatal(err)
	}
	environment := strings.Join(runner.environment, "\n")
	for _, expected := range []string{
		"OPENLIA_DATA_ROOT=" + config.DataRoot,
		"OPENLIA_SECRET_DIR=" + config.SecretDir,
		"OPENLIA_NETWORK_NAME=" + config.NetworkName,
	} {
		if !strings.Contains(environment, expected) {
			t.Fatalf("Compose environment missing %q:\n%s", expected, environment)
		}
	}
}

func TestComposeRunPassesSchedulerCredentialSources(t *testing.T) {
	directory := t.TempDir()
	knownHosts := filepath.Join(directory, "known_hosts")
	awsCredentials := filepath.Join(directory, "credentials")
	awsConfig := filepath.Join(directory, "config")
	for _, path := range []string{knownHosts, awsCredentials, awsConfig} {
		if err := os.WriteFile(path, []byte("test\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("OPENLIA_BACKUP_KNOWN_HOSTS_SOURCE", knownHosts)
	t.Setenv("OPENLIA_AWS_CREDENTIALS_SOURCE", awsCredentials)
	t.Setenv("OPENLIA_AWS_CONFIG_SOURCE", awsConfig)
	runner := &environmentRecordingRunner{}
	if _, err := NewCompose(testConfig(t.TempDir(), t.TempDir()), runner).Run(context.Background(), "config", "--quiet"); err != nil {
		t.Fatal(err)
	}
	environment := strings.Join(runner.environment, "\n")
	for _, expected := range []string{
		"OPENLIA_BACKUP_KNOWN_HOSTS_SOURCE=" + knownHosts,
		"OPENLIA_AWS_CREDENTIALS_SOURCE=" + awsCredentials,
		"OPENLIA_AWS_CONFIG_SOURCE=" + awsConfig,
	} {
		if !strings.Contains(environment, expected) {
			t.Fatalf("Compose environment missing %q:\n%s", expected, environment)
		}
	}
}

func TestExecRunnerStreamsStderrWhileRetainingDiagnostics(t *testing.T) {
	script := filepath.Join(t.TempDir(), "stderr.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s\\n' progress >&2\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	var streamed bytes.Buffer
	result, err := (ExecRunner{Stderr: &streamed}).Run(context.Background(), script)
	if err != nil {
		t.Fatal(err)
	}
	if string(result.Stderr) != "progress\n" || streamed.String() != "progress\n" {
		t.Fatalf("stderr was not retained and streamed: result=%q streamed=%q", result.Stderr, streamed.String())
	}
}

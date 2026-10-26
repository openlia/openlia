package operator

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceUIEnablesPrivateHermesChat(t *testing.T) {
	repo := t.TempDir()
	config := testConfig(repo, filepath.Join(t.TempDir(), "runtime"))
	config.WorkspaceUIHost = "127.0.0.1"
	config.WorkspaceUIPort = 8089
	config.APIEnabled = false
	if err := os.MkdirAll(filepath.Join(repo, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(config.GeneratedCompose)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, expected := range []string{"API_SERVER_ENABLED: \"true\"", "API_SERVER_HOST: \"0.0.0.0\"", "OPENLIA_HERMES_API_URL: http://hermes:8642", "api-server.env"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %q", expected)
		}
	}
	for _, forbidden := range []string{"  open-webui:", ":8642:8642", "OPENAI_API_KEY:"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("unexpected public API / Open WebUI wiring %q", forbidden)
		}
	}
	key, err := readSecretValue(filepath.Join(config.SecretDir, "api-server.env"), "API_SERVER_KEY")
	if err != nil || key == "" {
		t.Fatalf("missing chat API credential: %v", err)
	}
	if strings.Contains(text, key) {
		t.Fatal("chat API credential leaked into generated Compose")
	}
	if info, err := os.Stat(filepath.Join(config.SecretDir, "api-server.env")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("chat API credential file must have mode 0600: %v", err)
	}
	serverKey, err := readSecretValue(config.SecretFile, "API_SERVER_KEY")
	if err != nil || serverKey != key {
		t.Fatalf("Hermes and Workspace UI credentials differ: %v", err)
	}
	if err := GenerateAttachments(config); err != nil {
		t.Fatal(err)
	}
	again, _ := readSecretValue(filepath.Join(config.SecretDir, "api-server.env"), "API_SERVER_KEY")
	if again != key {
		t.Fatal("chat API credential changed during reconciliation")
	}
}

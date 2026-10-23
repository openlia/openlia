package cli

import (
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestOpenWebUIPasswordHash(t *testing.T) {
	hash, err := hashOpenWebUIPassword("e2e-test-password")
	if err != nil {
		t.Fatal(err)
	}
	cost, err := bcrypt.Cost([]byte(hash))
	if err != nil || cost != 12 {
		t.Fatalf("unexpected bcrypt cost: %d, %v", cost, err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte("e2e-test-password")); err != nil {
		t.Fatal(err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte("wrong")); err == nil {
		t.Fatal("wrong password accepted")
	}
	for _, value := range []string{"", strings.Repeat("a", 73), strings.Repeat("é", 37)} {
		if _, err := hashOpenWebUIPassword(value); err == nil {
			t.Fatal("invalid password accepted")
		}
	}
	if _, err := hashOpenWebUIPassword(strings.Repeat("a", 72)); err != nil {
		t.Fatal(err)
	}
}

func TestOpenWebUIPasswordCommandRejectsUnsafeInput(t *testing.T) {
	if got := commandOpenWebUI(Options{NonInteractive: true}, []string{"password"}); got != ExitUsage {
		t.Fatalf("non-interactive command exit: %d", got)
	}
	for _, args := range [][]string{nil, {"password", "plaintext"}, {"unknown"}} {
		if got := commandOpenWebUI(Options{}, args); got != ExitUsage {
			t.Fatalf("invalid arguments exit: %d", got)
		}
	}
}

func TestOpenWebUIAdminConfigAndEnvironment(t *testing.T) {
	config := defaultConfig()
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIAdminEmail = "e2e@example.com"
	config.OpenWebUIAdminPasswordHash = "$2a$12$" + strings.Repeat("a", 53)
	if err := validateConfig(config); err != nil {
		t.Fatal(err)
	}
	parsed, err := parseConfig(renderConfig(config))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.OpenWebUIAdminEmail != config.OpenWebUIAdminEmail || parsed.OpenWebUIAdminPasswordHash != config.OpenWebUIAdminPasswordHash {
		t.Fatal("admin config did not round trip")
	}
	remoteCommand := (Remote{Config: config}).operationCommand("ops/deploy.sh")
	localEnv := strings.Join(operationEnvironment(config, t.TempDir()), "\n")
	for _, field := range []struct{ name, value string }{
		{"OPENLIA_OPEN_WEBUI_ADMIN_EMAIL", config.OpenWebUIAdminEmail},
		{"OPENLIA_OPEN_WEBUI_ADMIN_PASSWORD_HASH", config.OpenWebUIAdminPasswordHash},
	} {
		if !strings.Contains(remoteCommand, field.name+"="+shellQuote(field.value)) || !strings.Contains(localEnv, field.name+"="+field.value) {
			t.Fatalf("admin setting not propagated: %s", field.name)
		}
	}
	if strings.Contains(redact(renderConfig(config)), config.OpenWebUIAdminPasswordHash) || strings.Contains(redact(remoteCommand), config.OpenWebUIAdminPasswordHash) {
		t.Fatal("bcrypt hash was not redacted")
	}
	config.OpenWebUIAdminEmail = ""
	if err := validateConfig(config); err == nil {
		t.Fatal("incomplete admin config accepted")
	}
}

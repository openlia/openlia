package operator

import (
	"database/sql"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestOpenWebUIAdminSeeding(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 required for WebUI seeding")
	}
	config := testConfig(t.TempDir(), filepath.Join(t.TempDir(), "runtime"))
	if err := os.MkdirAll(filepath.Join(config.RepositoryRoot, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	config.OpenWebUIHost = "127.0.0.1"
	config.OpenWebUIAuth = true
	config.OpenWebUIAdminEmail = "E2E@example.com"
	var rotatedStamp string
	for index, password := range []string{"first-password", "rotated-password", "rotated-password"} {
		if index != 2 {
			hash, err := bcrypt.GenerateFromPassword([]byte(password), 10)
			if err != nil {
				t.Fatal(err)
			}
			config.OpenWebUIAdminPasswordHash = string(hash)
		}
		if err := GenerateAttachments(config); err != nil {
			t.Fatal(err)
		}
		db, err := sql.Open("sqlite", filepath.Join(config.OpenWebUIDataRoot, "webui.db"))
		if err != nil {
			t.Fatal(err)
		}
		var role, hash string
		var active, count int
		err = db.QueryRow(`SELECT u.role, a.password, a.active FROM "user" u JOIN auth a ON u.id = a.id WHERE u.email = 'e2e@example.com'`).Scan(&role, &hash, &active)
		if err != nil {
			db.Close()
			t.Fatal(err)
		}
		if role != "admin" || active != 1 || hash != config.OpenWebUIAdminPasswordHash {
			t.Fatal("admin credentials not reconciled")
		}
		if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
			t.Fatal(err)
		}
		if index > 0 && bcrypt.CompareHashAndPassword([]byte(hash), []byte("first-password")) == nil {
			t.Fatal("old password accepted after rotation")
		}
		if err := db.QueryRow(`SELECT count(*) FROM "user" WHERE email = 'e2e@example.com'`).Scan(&count); err != nil || count != 1 {
			t.Fatal("seeding created duplicate users")
		}
		if index == 0 {
			// Match newer WebUI schemas and retain unrelated accounts across rotation.
			if _, err := db.Exec(`ALTER TABLE auth ADD COLUMN session_stamp TEXT; UPDATE auth SET session_stamp = 'old-stamp'; INSERT INTO "user" (id,name,email,role,profile_image_url,created_at,updated_at,last_active_at) VALUES ('other','Other','other@example.com','user','/user.png',0,0,0); CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT); INSERT INTO config VALUES ('ui.enable_login_form', 'false'), ('ui.enable_signup', 'true'), ('other.setting', '123')`); err != nil {
				t.Fatal(err)
			}
		} else {
			var stamp, otherRole string
			if err := db.QueryRow(`SELECT session_stamp FROM auth`).Scan(&stamp); err != nil || stamp == "old-stamp" {
				t.Fatal("rotation did not invalidate previous sessions")
			}
			if index == 1 {
				rotatedStamp = stamp
			} else if stamp != rotatedStamp {
				t.Fatal("unchanged hash unnecessarily revoked sessions")
			}
			if err := db.QueryRow(`SELECT role FROM "user" WHERE id = 'other'`).Scan(&otherRole); err != nil || otherRole != "user" {
				t.Fatal("unrelated user changed")
			}
			for key, want := range map[string]string{"ui.enable_login_form": "true", "ui.enable_signup": "false", "other.setting": "123"} {
				var got string
				if err := db.QueryRow(`SELECT value FROM config WHERE key = ?`, key).Scan(&got); err != nil || got != want {
					t.Fatalf("persisted setting %s was not reconciled", key)
				}
			}
		}
		db.Close()
	}
	compose, err := os.ReadFile(config.GeneratedCompose)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{`ENABLE_LOGIN_FORM: "True"`, `ENABLE_SIGNUP: "False"`, `WEBUI_AUTH: "True"`} {
		if !strings.Contains(string(compose), value) {
			t.Fatalf("compose missing %s", value)
		}
	}
	env, err := os.ReadFile(filepath.Join(config.SecretDir, "open-webui.env"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(compose), config.OpenWebUIAdminPasswordHash) || strings.Contains(string(env), config.OpenWebUIAdminPasswordHash) {
		t.Fatal("admin hash leaked into container environment")
	}
}

func TestOpenWebUIAdminSeedFailure(t *testing.T) {
	if err := syncWebUIAdmin(filepath.Join(t.TempDir(), "missing", "webui.db"), "e2e@example.com", "hash"); err == nil {
		t.Fatal("database failure silently ignored")
	}
}

func TestLoadOpenWebUIAdminConfig(t *testing.T) {
	hash := "$2b$12$" + strings.Repeat("a", 53)
	values := map[string]string{
		"OPENLIA_REPO_ROOT":                      t.TempDir(),
		"OPENLIA_RUNTIME_ROOT":                   filepath.Join(t.TempDir(), "runtime"),
		"OPENLIA_OPEN_WEBUI_HOST":                "127.0.0.1",
		"OPENLIA_OPEN_WEBUI_ADMIN_EMAIL":         "e2e@example.com",
		"OPENLIA_OPEN_WEBUI_ADMIN_PASSWORD_HASH": hash,
	}
	config, err := LoadConfigFromEnv(values)
	if err != nil {
		t.Fatal(err)
	}
	if config.OpenWebUIAdminEmail != values["OPENLIA_OPEN_WEBUI_ADMIN_EMAIL"] || config.OpenWebUIAdminPasswordHash != hash {
		t.Fatal("admin settings not loaded")
	}
	values["OPENLIA_OPEN_WEBUI_AUTH"] = "false"
	if _, err := LoadConfigFromEnv(values); err == nil {
		t.Fatal("password-admin setup with auth disabled accepted")
	}
}

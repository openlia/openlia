package webuiauth

import (
	"strings"
	"testing"
)

func TestValidateAdmin(t *testing.T) {
	hash := "$2a$12$" + strings.Repeat("a", 53)
	for _, prefix := range []string{"$2a$", "$2b$", "$2y$"} {
		if err := ValidateAdmin("e2e@example.com", prefix+hash[4:], true, ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := ValidateAdmin("", "", false, "google-client"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, email, hash, google string
		auth                      bool
	}{
		{"missing email", "", hash, "", true},
		{"missing hash", "e2e@example.com", "", "", true},
		{"invalid email", "invalid", hash, "", true},
		{"display name", "E2E <e2e@example.com>", hash, "", true},
		{"plaintext", "e2e@example.com", "secret", "", true},
		{"invalid data", "e2e@example.com", hash[:59] + "!", "", true},
		{"short", "e2e@example.com", hash[:59], "", true},
		{"weak", "e2e@example.com", "$2a$04$" + hash[7:], "", true},
		{"excessive cost", "e2e@example.com", "$2a$31$" + hash[7:], "", true},
		{"auth disabled", "e2e@example.com", hash, "", false},
		{"oauth conflict", "e2e@example.com", hash, "google-client", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateAdmin(tc.email, tc.hash, tc.auth, tc.google); err == nil {
				t.Fatal("invalid settings accepted")
			}
		})
	}
}

// Package webuiauth validates the password-admin settings shared by CLI and operator.
package webuiauth

import (
	"fmt"
	"net/mail"
	"regexp"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

var bcryptHash = regexp.MustCompile(`^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$`)

func ValidateAdmin(email, hash string, auth bool, googleClientID string) error {
	if email == "" && hash == "" {
		return nil
	}
	if email == "" || hash == "" {
		return fmt.Errorf("open-webui.admin_email and admin_password_hash must be configured together")
	}
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email || strings.TrimSpace(email) != email {
		return fmt.Errorf("open-webui.admin_email must be a valid email address")
	}
	if !bcryptHash.MatchString(hash) {
		return fmt.Errorf("open-webui.admin_password_hash must be a bcrypt hash")
	}
	cost, err := bcrypt.Cost([]byte(hash))
	if err != nil || cost < 10 || cost > 14 {
		return fmt.Errorf("open-webui.admin_password_hash bcrypt cost must be between 10 and 14")
	}
	if !auth {
		return fmt.Errorf("open-webui.auth must be true when an admin password is configured")
	}
	if googleClientID != "" {
		return fmt.Errorf("open-webui password-admin setup cannot be combined with Google OAuth")
	}
	return nil
}

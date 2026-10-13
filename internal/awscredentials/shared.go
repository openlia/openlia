package awscredentials

import (
	"fmt"
	"os"
	"strings"
)

type Values struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

// ValidateProfile validates an AWS profile name against injection and control characters.
func ValidateProfile(profile string) error {
	if profile == "" {
		return nil
	}
	if len(profile) > 128 || strings.TrimSpace(profile) != profile || strings.ContainsAny(profile, "\r\n[]") {
		return fmt.Errorf("AWS profile must be a non-empty name without control characters or brackets")
	}
	return nil
}

func Read(path, profile string) (Values, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Values{}, err
	}
	values, found := parse(data, profile)
	if !found {
		return Values{}, fmt.Errorf("profile %q was not found", profile)
	}
	if values.AccessKeyID == "" || values.SecretAccessKey == "" {
		return Values{}, fmt.Errorf("profile %q does not contain a complete access key", profile)
	}
	return values, nil
}

func Filter(path, profile string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if _, err := Read(path, profile); err != nil {
		return nil, err
	}
	var output strings.Builder
	section := ""
	found := false
	for _, line := range strings.SplitAfter(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			section = strings.TrimSpace(trimmed[1 : len(trimmed)-1])
		}
		if section == profile {
			found = true
			output.WriteString(line)
		}
	}
	if !found {
		return nil, fmt.Errorf("profile %q was not found", profile)
	}
	return []byte(output.String()), nil
}

func parse(data []byte, profile string) (Values, bool) {
	section := ""
	values := Values{}
	found := false
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			section = strings.TrimSpace(trimmed[1 : len(trimmed)-1])
			if section == profile {
				found = true
			}
			continue
		}
		if section != profile {
			continue
		}
		key, value, ok := strings.Cut(trimmed, "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
			value = strings.Trim(value[1:len(value)-1], " ")
		}
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "aws_access_key_id":
			values.AccessKeyID = value
		case "aws_secret_access_key":
			values.SecretAccessKey = value
		case "aws_session_token", "aws_security_token":
			values.SessionToken = value
		}
	}
	return values, found
}

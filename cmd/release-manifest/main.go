package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
)

type manifest struct {
	Schema  int    `json:"schema"`
	OpenLia string `json:"openlia"`
	Remind  remind `json:"remind"`
	Hermes  image  `json:"hermes"`
	Locho   locho  `json:"locho"`
	Bun     bun    `json:"bun"`
}

type remind struct {
	Version      string `json:"version"`
	SourceURL    string `json:"source_url"`
	SourceSHA256 string `json:"source_sha256"`
}

type image struct {
	Image   string `json:"image"`
	Channel string `json:"channel"`
	Tag     string `json:"tag"`
	Digest  string `json:"digest"`
}

type locho struct {
	Version       string `json:"version"`
	LinuxX8664SHA string `json:"linux_x86_64_sha256"`
	LinuxARM64SHA string `json:"linux_aarch64_sha256"`
}

type bun struct {
	Version       string `json:"version"`
	LinuxX64SHA   string `json:"linux_x64_sha256"`
	LinuxARM64SHA string `json:"linux_aarch64_sha256"`
}

type replacement struct {
	file    string
	pattern *regexp.Regexp
	value   func(manifest) string
}

var (
	semverRe     = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	vSemverRe    = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+$`)
	digestRe     = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	hex64Re      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	replacements = []replacement{
		{
			file:    "docker/compose.yaml",
			pattern: regexp.MustCompile(`OPENLIA_HERMES_TAG:-v[0-9]+\.[0-9]+\.[0-9]+`),
			value:   func(m manifest) string { return "OPENLIA_HERMES_TAG:-" + m.Hermes.Tag },
		},
		{
			file:    "docker/compose.yaml",
			pattern: regexp.MustCompile(`OPENLIA_HERMES_DIGEST:-sha256:[0-9a-f]{64}`),
			value:   func(m manifest) string { return "OPENLIA_HERMES_DIGEST:-" + m.Hermes.Digest },
		},
		{
			file:    "docker/Dockerfile",
			pattern: regexp.MustCompile(`ARG HERMES_TAG=v[0-9]+\.[0-9]+\.[0-9]+`),
			value:   func(m manifest) string { return "ARG HERMES_TAG=" + m.Hermes.Tag },
		},
		{
			file:    "docker/Dockerfile",
			pattern: regexp.MustCompile(`ARG HERMES_DIGEST=sha256:[0-9a-f]{64}`),
			value:   func(m manifest) string { return "ARG HERMES_DIGEST=" + m.Hermes.Digest },
		},
		{
			file:    "docker/Dockerfile",
			pattern: regexp.MustCompile(`ARG BUN_VERSION=[0-9]+\.[0-9]+\.[0-9]+`),
			value:   func(m manifest) string { return "ARG BUN_VERSION=" + m.Bun.Version },
		},
		{
			file:    "docker/Dockerfile",
			pattern: regexp.MustCompile(`ARG BUN_LINUX_X64_SHA256=[0-9a-f]{64}`),
			value:   func(m manifest) string { return "ARG BUN_LINUX_X64_SHA256=" + m.Bun.LinuxX64SHA },
		},
		{
			file:    "docker/Dockerfile",
			pattern: regexp.MustCompile(`ARG BUN_LINUX_ARM64_SHA256=[0-9a-f]{64}`),
			value:   func(m manifest) string { return "ARG BUN_LINUX_ARM64_SHA256=" + m.Bun.LinuxARM64SHA },
		},
		{
			file:    "docker/workspace-ui.Dockerfile",
			pattern: regexp.MustCompile(`ARG BUN_VERSION=[0-9]+\.[0-9]+\.[0-9]+`),
			value:   func(m manifest) string { return "ARG BUN_VERSION=" + m.Bun.Version },
		},
		{
			file:    "docker/workspace-ui.Dockerfile",
			pattern: regexp.MustCompile(`ARG BUN_LINUX_X64_SHA256=[0-9a-f]{64}`),
			value:   func(m manifest) string { return "ARG BUN_LINUX_X64_SHA256=" + m.Bun.LinuxX64SHA },
		},
		{
			file:    "docker/workspace-ui.Dockerfile",
			pattern: regexp.MustCompile(`ARG BUN_LINUX_ARM64_SHA256=[0-9a-f]{64}`),
			value:   func(m manifest) string { return "ARG BUN_LINUX_ARM64_SHA256=" + m.Bun.LinuxARM64SHA },
		},
		{
			file:    "docker/.env.example",
			pattern: regexp.MustCompile(`OPENLIA_HERMES_IMAGE=openlia-hermes:v[0-9]+\.[0-9]+\.[0-9]+`),
			value:   func(m manifest) string { return "OPENLIA_HERMES_IMAGE=openlia-hermes:" + m.Hermes.Tag },
		},
		{
			file:    "docker/.env.example",
			pattern: regexp.MustCompile(`OPENLIA_BACKUP_SCHEDULER_IMAGE=openlia-backup-scheduler:v[0-9]+\.[0-9]+\.[0-9]+`),
			value: func(m manifest) string {
				return "OPENLIA_BACKUP_SCHEDULER_IMAGE=openlia-backup-scheduler:" + m.Hermes.Tag
			},
		},
		{
			file:    "docker/.env.example",
			pattern: regexp.MustCompile(`OPENLIA_LOCHO_IMAGE=openlia-locho:v[0-9]+\.[0-9]+\.[0-9]+`),
			value:   func(m manifest) string { return "OPENLIA_LOCHO_IMAGE=openlia-locho:v" + m.Locho.Version },
		},
		{
			file:    "docker/.env.example",
			pattern: regexp.MustCompile(`HERMES_BASE_TAG=v[0-9]+\.[0-9]+\.[0-9]+`),
			value:   func(m manifest) string { return "HERMES_BASE_TAG=" + m.Hermes.Tag },
		},
		{
			file:    "docker/.env.example",
			pattern: regexp.MustCompile(`HERMES_BASE_DIGEST=sha256:[0-9a-f]{64}`),
			value:   func(m manifest) string { return "HERMES_BASE_DIGEST=" + m.Hermes.Digest },
		},
		{
			file:    "examples/profiles/dev/config.toml.example",
			pattern: regexp.MustCompile(`(?m)^version = "[0-9]+\.[0-9]+\.[0-9]+"$`),
			value:   func(m manifest) string { return fmt.Sprintf("version = %q", m.OpenLia) },
		},
		{
			file:    "examples/profiles/dev/config.toml.example",
			pattern: regexp.MustCompile(`hermes_image = "openlia-hermes:v[0-9]+\.[0-9]+\.[0-9]+"`),
			value:   func(m manifest) string { return fmt.Sprintf("hermes_image = %q", "openlia-hermes:"+m.Hermes.Tag) },
		},
		{
			file:    "examples/profiles/dev/config.toml.example",
			pattern: regexp.MustCompile(`hermes_tag = "v[0-9]+\.[0-9]+\.[0-9]+"`),
			value:   func(m manifest) string { return fmt.Sprintf("hermes_tag = %q", m.Hermes.Tag) },
		},
		{
			file:    "examples/profiles/dev/config.toml.example",
			pattern: regexp.MustCompile(`hermes_digest = "sha256:[0-9a-f]{64}"`),
			value:   func(m manifest) string { return fmt.Sprintf("hermes_digest = %q", m.Hermes.Digest) },
		},
		{
			file:    "examples/profiles/dev/config.toml.example",
			pattern: regexp.MustCompile(`locho_image = "openlia-locho:v[0-9]+\.[0-9]+\.[0-9]+"`),
			value:   func(m manifest) string { return fmt.Sprintf("locho_image = %q", "openlia-locho:v"+m.Locho.Version) },
		},
		{
			file:    "examples/profiles/dev/config.toml.example",
			pattern: regexp.MustCompile(`locho_version = "[0-9]+\.[0-9]+\.[0-9]+"`),
			value:   func(m manifest) string { return fmt.Sprintf("locho_version = %q", m.Locho.Version) },
		},
		{
			file:    "examples/profiles/dev/config.toml.example",
			pattern: regexp.MustCompile(`locho_x86_64_sha256 = "[0-9a-f]{64}"`),
			value:   func(m manifest) string { return fmt.Sprintf("locho_x86_64_sha256 = %q", m.Locho.LinuxX8664SHA) },
		},
		{
			file:    "examples/profiles/dev/config.toml.example",
			pattern: regexp.MustCompile(`locho_arm64_sha256 = "[0-9a-f]{64}"`),
			value:   func(m manifest) string { return fmt.Sprintf("locho_arm64_sha256 = %q", m.Locho.LinuxARM64SHA) },
		},
		{
			file:    "docs/operator-guide.md",
			pattern: regexp.MustCompile(`(?m)^version = "[0-9]+\.[0-9]+\.[0-9]+"$`),
			value:   func(m manifest) string { return fmt.Sprintf("version = %q", m.OpenLia) },
		},
		{
			file:    "operator/attachments.go",
			pattern: regexp.MustCompile(`OPENLIA_WORKSPACE_UI_IMAGE:-openlia-workspace-ui:v[0-9]+\.[0-9]+\.[0-9]+`),
			value:   func(m manifest) string { return "OPENLIA_WORKSPACE_UI_IMAGE:-openlia-workspace-ui:v" + m.OpenLia },
		},
		{
			file:    "packages/openlia-browser/src/server.ts",
			pattern: regexp.MustCompile(`\{ name: "openlia-browser", version: "[0-9]+\.[0-9]+\.[0-9]+" \}`),
			value: func(m manifest) string {
				return fmt.Sprintf(`{ name: "openlia-browser", version: %q }`, m.OpenLia)
			},
		},
		{
			file:    "packages/openlia-browser/src/browser.ts",
			pattern: regexp.MustCompile(`\{ name: "openlia-browser", version: "[0-9]+\.[0-9]+\.[0-9]+" \}`),
			value: func(m manifest) string {
				return fmt.Sprintf(`{ name: "openlia-browser", version: %q }`, m.OpenLia)
			},
		},
	}
)

func main() {
	mode := "check"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	if mode != "check" && mode != "sync" {
		fail(fmt.Errorf("usage: go run ./cmd/release-manifest [check|sync]"))
	}

	m, err := loadManifest("release/manifest.json")
	if err != nil {
		fail(err)
	}
	if err := validate(m); err != nil {
		fail(err)
	}
	if err := syncGeneratedReleaseInfo("internal/releaseinfo/generated.go", m, mode == "sync"); err != nil {
		fail(err)
	}
	for _, item := range replacements {
		if err := applyReplacement(item, m, mode == "sync"); err != nil {
			fail(err)
		}
	}
}

func loadManifest(path string) (manifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return manifest{}, err
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return manifest{}, err
	}
	return m, nil
}

func validate(m manifest) error {
	if m.Schema != 1 {
		return fmt.Errorf("release/manifest.json schema must be 1, got %d", m.Schema)
	}
	if !semverRe.MatchString(m.OpenLia) {
		return fmt.Errorf("openlia version must be stable X.Y.Z, got %q", m.OpenLia)
	}
	if !semverRe.MatchString(m.Remind.Version) {
		return fmt.Errorf("remind version must be stable X.Y.Z, got %q", m.Remind.Version)
	}
	expectedRemindURL := fmt.Sprintf("https://dianne.skoll.ca/projects/remind/download/remind-%s.tar.gz", m.Remind.Version)
	if m.Remind.SourceURL != expectedRemindURL {
		return fmt.Errorf("remind source_url must be %q, got %q", expectedRemindURL, m.Remind.SourceURL)
	}
	if !hex64Re.MatchString(m.Remind.SourceSHA256) {
		return errors.New("remind source_sha256 must be 64 lowercase hex characters")
	}
	if err := validateImage("hermes", m.Hermes, "nousresearch/hermes-agent", vSemverRe); err != nil {
		return err
	}
	if !semverRe.MatchString(m.Locho.Version) {
		return fmt.Errorf("locho version must be stable X.Y.Z, got %q", m.Locho.Version)
	}
	if !hex64Re.MatchString(m.Locho.LinuxX8664SHA) || !hex64Re.MatchString(m.Locho.LinuxARM64SHA) {
		return errors.New("locho binary sha256 values must be 64 lowercase hex characters")
	}
	if !semverRe.MatchString(m.Bun.Version) {
		return fmt.Errorf("bun version must be stable X.Y.Z, got %q", m.Bun.Version)
	}
	if !hex64Re.MatchString(m.Bun.LinuxX64SHA) || !hex64Re.MatchString(m.Bun.LinuxARM64SHA) {
		return errors.New("bun archive sha256 values must be 64 lowercase hex characters")
	}
	return nil
}

func validateImage(name string, img image, expectedImage string, tagRe *regexp.Regexp) error {
	if img.Image != expectedImage {
		return fmt.Errorf("%s image must be %q, got %q", name, expectedImage, img.Image)
	}
	if img.Channel != "stable" {
		return fmt.Errorf("%s channel must be stable, got %q", name, img.Channel)
	}
	if !tagRe.MatchString(img.Tag) {
		return fmt.Errorf("%s tag must be an exact stable release tag without prerelease suffixes, got %q", name, img.Tag)
	}
	if !digestRe.MatchString(img.Digest) {
		return fmt.Errorf("%s digest must be sha256:<64 lowercase hex>, got %q", name, img.Digest)
	}
	return nil
}

func renderGeneratedReleaseInfo(m manifest) string {
	return fmt.Sprintf(`// Code generated by cmd/release-manifest; DO NOT EDIT.

package releaseinfo

var Default = Manifest{
	Schema:  %d,
	OpenLia: %q,
	Remind: RemindPin{
		Version:      %q,
		SourceURL:    %q,
		SourceSHA256: %q,
	},
	Hermes: ImagePin{
		Image:   %q,
		Channel: %q,
		Tag:     %q,
		Digest:  %q,
	},
	Locho: LochoPin{
		Version:       %q,
		LinuxX8664SHA: %q,
		LinuxARM64SHA: %q,
	},
	Bun: BunPin{
		Version:       %q,
		LinuxX64SHA:   %q,
		LinuxARM64SHA: %q,
	},
}
`, m.Schema, m.OpenLia, m.Remind.Version, m.Remind.SourceURL, m.Remind.SourceSHA256, m.Hermes.Image, m.Hermes.Channel, m.Hermes.Tag, m.Hermes.Digest, m.Locho.Version, m.Locho.LinuxX8664SHA, m.Locho.LinuxARM64SHA, m.Bun.Version, m.Bun.LinuxX64SHA, m.Bun.LinuxARM64SHA)
}

func syncGeneratedReleaseInfo(path string, m manifest, write bool) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	expected := renderGeneratedReleaseInfo(m)
	if string(raw) == expected {
		return nil
	}
	if !write {
		return fmt.Errorf("%s is out of sync with release/manifest.json; run `go run ./cmd/release-manifest sync`", path)
	}
	return os.WriteFile(path, []byte(expected), 0o644)
}

func applyReplacement(item replacement, m manifest, write bool) error {
	raw, err := os.ReadFile(item.file)
	if err != nil {
		return err
	}
	content := string(raw)
	matches := item.pattern.FindAllString(content, -1)
	if len(matches) == 0 {
		return fmt.Errorf("%s did not match %s", item.file, item.pattern.String())
	}
	expected := item.value(m)
	updated := item.pattern.ReplaceAllStringFunc(content, func(string) string { return expected })
	if content == updated {
		return nil
	}
	if !write {
		return fmt.Errorf("%s is out of sync with release/manifest.json (%s != %s); run `go run ./cmd/release-manifest sync`", item.file, strings.Join(matches, ", "), expected)
	}
	return os.WriteFile(item.file, []byte(updated), 0o644)
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "release-manifest: %v\n", err)
	os.Exit(1)
}

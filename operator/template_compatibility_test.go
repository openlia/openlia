package operator

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRuntimeMeetsMinimum(t *testing.T) {
	for _, tc := range []struct {
		version string
		minimum string
		want    bool
	}{
		{"1.2.3", ">=1.2.3", true},
		{"v1.2.3+build.42", ">=1.2.3", true},
		{"1.2.3-rc.1", ">=1.2.3", false},
		{"1.2.4-rc.1", ">=1.2.3", true},
		{"1.2.2", ">=1.2.3", false},
		{"1.10.0", ">=1.9.0", true},
		{"0.99.99", ">=1.0.0", false},
		{"2.0.0", ">=1.99.99", true},
	} {
		t.Run(tc.version+tc.minimum, func(t *testing.T) {
			got, err := runtimeMeetsMinimum(tc.version, tc.minimum)
			if err != nil || got != tc.want {
				t.Fatalf("got %v, %v; want %v", got, err, tc.want)
			}
		})
	}
	for _, version := range []string{"unknown", "1.2", "01.2.3", "1.2.3-01", "1.2.3\n"} {
		if _, err := runtimeMeetsMinimum(version, ">=1.2.3"); err == nil {
			t.Fatalf("accepted invalid runtime %q", version)
		}
	}
}

func TestParseOpenLiaRequirement(t *testing.T) {
	for _, data := range []string{"requires:\n  openlia: \">=1.2.3\"\n", "requires: {openlia: '>=1.2.3'}\n", "minimum: &minimum '>=1.2.3'\nrequires: {openlia: *minimum}\n"} {
		got, err := parseOpenLiaRequirement([]byte(data))
		if err != nil || got != ">=1.2.3" {
			t.Fatalf("got %q, %v", got, err)
		}
	}
	for _, value := range []string{"''", "null", "1", "[]", "{}", "'^1.2.3'", "'>=01.2.3'", "'>=1.2'", "'>=1.2.3-rc.1'", "' >=1.2.3'"} {
		if _, err := parseOpenLiaRequirement([]byte("requires: {openlia: " + value + "}\n")); err == nil {
			t.Fatalf("accepted invalid requirement %s", value)
		}
	}
	for _, data := range []string{"requires:\n  openlia: '>=1.2.3'\n  openlia: '>=0.1.0'\n", "requires: []\n", "requires: {openlia: '>=1.2.3'}\n---\nrequires: {openlia: '>=0.1.0'}\n"} {
		if _, err := parseOpenLiaRequirement([]byte(data)); err == nil {
			t.Fatalf("accepted malformed requirements %q", data)
		}
	}
}

func writeCompatibilityFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func compatibilityFeature(id, requires string) string {
	return fmt.Sprintf("schema: 1\nid: %s\nname: Test\nversion: 1.0.0\ndescription: Test\n%s", id, requires)
}

func fakeCompatibilityDocker(t *testing.T, identity string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "docker")
	writeCompatibilityFixture(t, path, "#!/bin/sh\ncase \"$*\" in\n*'exec -T workspace-ui cat /opt/openlia/runtime-release.json') printf '%s' '"+identity+"';;\n*) exit 9;;\nesac\n")
	if err := os.Chmod(path, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestCompatibilityPreflightDoesNotTrustCLIVersion(t *testing.T) {
	cfg := Config{OpenLiaVersion: "99.0.0"}
	fakeCompatibilityDocker(t, `{"schema":1,"openlia":"1.0.0"}`)
	err := newTemplatePreflight(cfg).check("feature calendar", ">=2.0.0")
	if err == nil || !strings.Contains(err.Error(), "detected deployed runtime 1.0.0") {
		t.Fatalf("expected target-version rejection, got %v", err)
	}
}

func TestCompatibilityIdentityFailsClosed(t *testing.T) {
	for _, identity := range []string{"", "{}", `{"schema":2,"openlia":"99.0.0"}`, `{"schema":1,"openlia":"unknown"}`} {
		t.Run(identity, func(t *testing.T) {
			fakeCompatibilityDocker(t, identity)
			if err := newTemplatePreflight(Config{}).check("test", ">=1.0.0"); err == nil {
				t.Fatal("accepted unverifiable target")
			}
		})
	}
	p := newTemplatePreflight(Config{})
	p.version = func() (string, error) { return "", errors.New("target unavailable") }
	if err := p.check("test", ">=1.0.0"); err == nil {
		t.Fatal("accepted unavailable target")
	}
	if err := p.check("legacy", ""); err != nil {
		t.Fatalf("legacy content should not need a running target: %v", err)
	}
}

func TestCompatibilityRejectionsPreserveInstalledFiles(t *testing.T) {
	for _, operation := range []string{"feature", "dependency", "profile", "profile-own", "profile-skill", "skill", "bundled-skill", "feature-skill", "feature-update", "skill-update", "import", "zip-import"} {
		t.Run(operation, func(t *testing.T) {
			cfg, _ := setupLeanWorkspaceForTest(t)
			cfg.OpenLiaVersion = "99.0.0" // Must not be used as deployed identity.
			fakeCompatibilityDocker(t, `{"schema":1,"openlia":"1.0.0"}`)
			catalog := filepath.Join(cfg.MetaRoot, "templates-cache")
			featureDir := filepath.Join(catalog, "features", "future")
			manifest := compatibilityFeature("future", "requires:\n  openlia: '>=2.0.0'\n")
			writeCompatibilityFixture(t, filepath.Join(featureDir, "feature.yaml"), manifest)
			writeCompatibilityFixture(t, filepath.Join(featureDir, "workspace", "future", "note.md"), "new data")
			writeCompatibilityFixture(t, filepath.Join(catalog, "features", "dependent", "feature.yaml"), compatibilityFeature("dependent", "requires: {features: [future]}\n"))
			writeCompatibilityFixture(t, filepath.Join(catalog, "skills", "future", "SKILL.md"), "---\nname: future\ndescription: Test\nrequires: {openlia: '>=2.0.0'}\n---\nTest\n")
			writeCompatibilityFixture(t, filepath.Join(featureDir, "skills", "bundled", "SKILL.md"), "---\nname: bundled\ndescription: Test\n---\nTest\n")
			writeCompatibilityFixture(t, filepath.Join(catalog, "profiles", "future", "profile.yaml"), "schema: 1\nid: future\nfeatures: [travel, future]\n")
			writeCompatibilityFixture(t, filepath.Join(catalog, "profiles", "skill-profile", "profile.yaml"), "schema: 1\nid: skill-profile\nfeatures: [travel]\nskills: [future]\n")
			writeCompatibilityFixture(t, filepath.Join(catalog, "profiles", "own-profile", "profile.yaml"), "schema: 1\nid: own-profile\nrequires: {openlia: '>=2.0.0'}\nfeatures: [travel]\n")
			writeCompatibilityFixture(t, filepath.Join(catalog, "features", "skill-feature", "feature.yaml"), compatibilityFeature("skill-feature", "skills:\n  - id: child\n    path: skills/child\n"))
			writeCompatibilityFixture(t, filepath.Join(catalog, "features", "skill-feature", "skills", "child", "SKILL.md"), "---\nname: child\ndescription: Test\nrequires: {openlia: '>=2.0.0'}\n---\nTest\n")
			writeCompatibilityFixture(t, filepath.Join(cfg.MetaRoot, "managed", "features", "future.json"), `{"schema":1,"id":"future","source":"builtin","manifest":{"id":"future"}}`)
			writeCompatibilityFixture(t, filepath.Join(cfg.DataRoot, "skills", "future", "SKILL.md"), "user customization")
			archive := filepath.Join(t.TempDir(), "future.zip")
			file, err := os.Create(archive)
			if err != nil {
				t.Fatal(err)
			}
			zw := zip.NewWriter(file)
			entry, err := zw.Create("feature.yaml")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := entry.Write([]byte(manifest)); err != nil {
				t.Fatal(err)
			}
			if err := zw.Close(); err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			beforeData, err := DirectorySHA256(cfg.DataRoot)
			if err != nil {
				t.Fatal(err)
			}
			beforeMeta, err := DirectorySHA256(cfg.MetaRoot)
			if err != nil {
				t.Fatal(err)
			}
			switch operation {
			case "feature":
				_, err = FeatureInstall(cfg, "future", false, time.Now())
			case "dependency":
				_, err = FeatureInstall(cfg, "dependent", false, time.Now())
			case "profile":
				_, err = InstallTemplateProfile(cfg, "future", false, time.Now())
			case "profile-skill":
				_, err = InstallTemplateProfile(cfg, "skill-profile", false, time.Now())
			case "profile-own":
				_, err = InstallTemplateProfile(cfg, "own-profile", false, time.Now())
			case "skill":
				_, err = SkillInstall(cfg, "future", time.Now())
			case "bundled-skill":
				_, err = SkillInstall(cfg, "bundled", time.Now())
			case "feature-skill":
				_, err = FeatureInstall(cfg, "skill-feature", false, time.Now())
			case "feature-update":
				_, err = RebaseInstalledFeature(cfg, "future", time.Now())
			case "skill-update":
				_, err = RebaseInstalledSkill(cfg, "future", time.Now())
			case "import":
				_, err = FeatureImport(cfg, featureDir, false, time.Now())
			case "zip-import":
				_, err = FeatureImport(cfg, archive, false, time.Now())
			}
			if err == nil || !strings.Contains(err.Error(), "requires OpenLia >=2.0.0") {
				t.Fatalf("expected compatibility rejection, got %v", err)
			}
			afterData, dataErr := DirectorySHA256(cfg.DataRoot)
			afterMeta, metaErr := DirectorySHA256(cfg.MetaRoot)
			if dataErr != nil || metaErr != nil || beforeData != afterData || beforeMeta != afterMeta {
				t.Fatalf("rejected operation changed installed files: data=%v meta=%v", dataErr, metaErr)
			}
		})
	}
}

func TestCompatibilityManifestRoundTrip(t *testing.T) {
	manifest, err := ParseFeatureManifest([]byte(compatibilityFeature("example", "requires: {openlia: '>=1.2.3'}\n")))
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseFeatureManifest(RenderFeatureManifest(manifest))
	if err != nil || got.Requires.OpenLia != ">=1.2.3" {
		t.Fatalf("requirement lost in rendering: %+v, %v", got, err)
	}
	profile, err := ParseProfileManifest([]byte("id: example\nrequires: {openlia: '>=1.2.3'}\n"))
	if err != nil || profile.Requires.OpenLia != ">=1.2.3" {
		t.Fatalf("profile requirement lost: %+v, %v", profile, err)
	}
}

func TestCompatibilityCycleRejected(t *testing.T) {
	cfg, _ := setupLeanWorkspaceForTest(t)
	catalog := filepath.Join(cfg.MetaRoot, "templates-cache", "features")
	writeCompatibilityFixture(t, filepath.Join(catalog, "cycle-a", "feature.yaml"), compatibilityFeature("cycle-a", "requires:\n  features: [cycle-b]\n"))
	writeCompatibilityFixture(t, filepath.Join(catalog, "cycle-b", "feature.yaml"), compatibilityFeature("cycle-b", "requires:\n  features: [cycle-a]\n"))
	if err := newTemplatePreflight(cfg).featureID("cycle-a"); err == nil || !strings.Contains(err.Error(), "cyclic") {
		t.Fatalf("expected cycle error, got %v", err)
	}
}

func TestCompatibilityAllowsMatchingTarget(t *testing.T) {
	cfg, ws := setupLeanWorkspaceForTest(t)
	fakeCompatibilityDocker(t, `{"schema":1,"openlia":"2.0.0"}`)
	dir := filepath.Join(cfg.MetaRoot, "templates-cache", "features", "compatible")
	writeCompatibilityFixture(t, filepath.Join(dir, "feature.yaml"), compatibilityFeature("compatible", "requires: {openlia: '>=2.0.0'}\n"))
	writeCompatibilityFixture(t, filepath.Join(dir, "workspace", "compatible", "note.md"), "starter data")
	if _, err := FeatureInstall(cfg, "compatible", false, time.Now()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(ws, "compatible", "note.md"))
	if err != nil || string(data) != "starter data" {
		t.Fatalf("compatible feature was not installed: %q, %v", data, err)
	}
}

func TestCompatibilityPackagingPreservesRequirements(t *testing.T) {
	cfg, _ := setupLeanWorkspaceForTest(t)
	manifestPath := filepath.Join(cfg.MetaRoot, "templates-cache", "features", "travel", "feature.yaml")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := ParseFeatureManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Requires.OpenLia = ">=2.0.0"
	manifest.Requires.Features = []string{"dependency"}
	writeCompatibilityFixture(t, manifestPath, string(RenderFeatureManifest(manifest)))
	output := filepath.Join(t.TempDir(), "travel.zip")
	if _, err := FeaturePackage(cfg, FeaturePackageOptions{FeatureID: "travel", OutputPath: output}); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.OpenReader(output)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	for _, file := range archive.File {
		if file.Name != "feature.yaml" {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		data, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		packaged, err := ParseFeatureManifest(data)
		if err != nil || packaged.Requires.OpenLia != ">=2.0.0" || len(packaged.Requires.Features) != 1 || packaged.Requires.Features[0] != "dependency" {
			t.Fatalf("packaging dropped compatibility requirements: %+v, %v", packaged.Requires, err)
		}
		return
	}
	t.Fatal("archive is missing feature.yaml")
}

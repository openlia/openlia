package operator

import (
	"archive/zip"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func minionFixture(t *testing.T, featureDir string, requiredSetting bool) string {
	t.Helper()
	app := filepath.Join(featureDir, "workspace", "minions", "demo")
	files := map[string]string{
		"README.md":                   "---\nname: Demo\n---\n# Demo\n",
		"dashboard.openui":            `Callout(variant: "info", title: "Demo", description: "Configure this app before use.")`,
		"input.openui":                `Form(name: "minionInput", fields: [], buttons: Buttons(buttons: []))`,
		"input.schema.json":           `{"type":"object"}`,
		"main.py":                     "# upstream v1\nprint('never execute during install')\n",
		"input.py":                    "# input handler\n",
		"scripts/helper.py":           "# helper\n",
		"tests/test_main.py":          "# reviewed offline test\n",
		"tests/fixtures/example.json": `{"example":true}`,
		"requirements.txt":            "# no install hooks\n",
	}
	schema := `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["trigger"],"properties":{"trigger":{"type":"object","properties":{"on_new_entry":{"type":"boolean"},"cron":{"type":"string"}},"default":{"on_new_entry":true,"cron":"0 * * * *"}},"target":{"type":"integer","default":3}}}`
	if requiredSetting {
		schema = strings.Replace(schema, `["trigger"]`, `["trigger","endpoint"]`, 1)
	}
	files["config.schema.json"] = schema
	paths := []string{}
	for name, content := range files {
		paths = append(paths, name)
		writeCompatibilityFixture(t, filepath.Join(app, filepath.FromSlash(name)), content)
	}
	data, _ := json.Marshal(minionDistribution{Schema: 1, Files: paths})
	writeCompatibilityFixture(t, filepath.Join(app, minionPackageFile), string(data))
	manifest := FeatureManifest{Schema: 1, ID: "demo-app", Name: "Demo app", Version: "1.0.0", Description: "Test app", Domains: []WorkspaceDomain{{Path: "minions/demo", Kind: "extension", Label: "Demo", Purpose: "Test", Lifecycle: "active"}}}
	writeCompatibilityFixture(t, filepath.Join(featureDir, "feature.yaml"), string(RenderFeatureManifest(manifest)))
	return app
}

func assertMinionFile(t *testing.T, root, rel, expected string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil || string(data) != expected {
		t.Fatalf("%s: got %q, %v; want %q", rel, data, err, expected)
	}
}

func TestMinionDistributionPaths(t *testing.T) {
	data, err := os.ReadFile("../tests/fixtures/minion-package-paths.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases map[string][]string
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for group, paths := range cases {
		for _, path := range paths {
			if portableMinionFile(path) != (group == "allowed") {
				t.Errorf("%s: %q", group, path)
			}
		}
	}
	for _, path := range []string{"minions", "minions/demo/data", "minions/../demo", "minions/Bad_ID"} {
		if _, _, err := minionDomainID(path); err == nil {
			t.Errorf("accepted %s", path)
		}
	}
}

func TestMinionDistributionConfigDefaults(t *testing.T) {
	data, err := os.ReadFile("../tests/fixtures/minion-config-defaults.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string
		Schema   json.RawMessage
		Expected map[string]any
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, item := range cases {
		t.Run(item.Name, func(t *testing.T) {
			_, defaults, err := compileMinionConfig(item.Schema)
			if err != nil || !reflect.DeepEqual(defaults, item.Expected) {
				t.Fatalf("got %+v, %v; want %+v", defaults, err, item.Expected)
			}
		})
	}
}

func TestMinionDistributionExportAndImport(t *testing.T) {
	cfg, workspace := setupLeanWorkspaceForTest(t)
	source := filepath.Join(t.TempDir(), "source")
	app := minionFixture(t, source, false)
	if err := copyDirectoryContents(filepath.Join(source, "workspace"), workspace); err != nil {
		t.Fatal(err)
	}
	creatorConfig := `{"trigger":{"on_new_entry":true},"target":99}`
	writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/config.json"), creatorConfig)
	writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/data/private.json"), "private records")
	writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/node_modules/pkg/index.js"), "dependency")
	for _, includeRecords := range []bool{false, true} {
		result, err := FeaturePackage(cfg, FeaturePackageOptions{FeatureID: "demo-app", Domains: []string{"minions/demo"}, IncludeRecords: includeRecords, OutputPath: filepath.Join(t.TempDir(), "app.zip")})
		if err != nil {
			t.Fatal(err)
		}
		reader, err := zip.OpenReader(result.OutputPath)
		if err != nil {
			t.Fatal(err)
		}
		names := map[string]bool{}
		for _, file := range reader.File {
			names[file.Name] = true
		}
		reader.Close()
		for _, file := range []string{"main.py", "dashboard.openui", "scripts/helper.py", "tests/test_main.py", "tests/fixtures/example.json", minionPackageFile} {
			if !names["workspace/minions/demo/"+file] {
				t.Errorf("missing %s", file)
			}
		}
		for _, file := range []string{"config.json", "data/private.json", "node_modules/pkg/index.js"} {
			if names["workspace/minions/demo/"+file] {
				t.Errorf("exported local state %s", file)
			}
		}
		recipient, recipientWorkspace := setupLeanWorkspaceForTest(t)
		installed, err := FeatureImport(recipient, result.OutputPath, false, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if len(installed.Minions) != 1 || installed.Minions[0].ConfigurationRequired {
			t.Fatalf("status: %+v", installed.Minions)
		}
		config, _ := os.ReadFile(filepath.Join(recipientWorkspace, "minions/demo/config.json"))
		var value map[string]any
		if json.Unmarshal(config, &value) != nil || value["target"] != float64(3) || value["trigger"].(map[string]any)["on_new_entry"] != false {
			t.Fatalf("unsafe defaults: %s", config)
		}
		if _, err := os.Stat(filepath.Join(recipientWorkspace, "minions/demo/data")); !os.IsNotExist(err) {
			t.Fatal("imported user data")
		}
		if _, err := os.Stat(filepath.Join(recipient.MetaRoot, "managed/features/demo-app/base/minions/demo/config.json")); !os.IsNotExist(err) {
			t.Fatal("configuration entered managed base")
		}
	}
	_ = app
}

func TestMinionDistributionPendingAndPreflight(t *testing.T) {
	for _, scenario := range []string{"required-config", "local-state", "undeclared-file", "unsafe-list", "duplicate-case", "mixed-input", "symlink", "collision", "destination-symlink", "remote-schema", "credential"} {
		t.Run(scenario, func(t *testing.T) {
			cfg, workspace := setupLeanWorkspaceForTest(t)
			feature := filepath.Join(cfg.MetaRoot, "templates-cache/features/demo-app")
			app := minionFixture(t, feature, scenario == "required-config")
			switch scenario {
			case "local-state":
				writeCompatibilityFixture(t, filepath.Join(app, "data/private.json"), "private")
			case "undeclared-file":
				writeCompatibilityFixture(t, filepath.Join(app, "extra.py"), "# not reviewed")
			case "unsafe-list":
				data, _ := os.ReadFile(filepath.Join(app, minionPackageFile))
				writeCompatibilityFixture(t, filepath.Join(app, minionPackageFile), strings.Replace(string(data), `"README.md"`, `"config.json"`, 1))
			case "duplicate-case", "mixed-input":
				data, _ := os.ReadFile(filepath.Join(app, minionPackageFile))
				var manifest minionDistribution
				json.Unmarshal(data, &manifest)
				name := "readme.md"
				if scenario == "mixed-input" {
					name = "input.ts"
					writeCompatibilityFixture(t, filepath.Join(app, name), "// wrong input runtime")
				}
				manifest.Files = append(manifest.Files, name)
				data, _ = json.Marshal(manifest)
				writeCompatibilityFixture(t, filepath.Join(app, minionPackageFile), string(data))
			case "symlink":
				os.Remove(filepath.Join(app, "main.py"))
				if err := os.Symlink("input.py", filepath.Join(app, "main.py")); err != nil {
					t.Fatal(err)
				}
			case "collision":
				writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/config.json"), "local config")
			case "destination-symlink":
				if err := os.Symlink(t.TempDir(), filepath.Join(workspace, "minions")); err != nil {
					t.Fatal(err)
				}
			case "remote-schema":
				writeCompatibilityFixture(t, filepath.Join(app, "config.schema.json"), `{"type":"object","required":["trigger"],"$ref":"https://example.invalid/schema"}`)
			case "credential":
				writeCompatibilityFixture(t, filepath.Join(app, "main.py"), "# -----BEGIN PRIVATE KEY-----")
			}
			result, err := FeatureInstall(cfg, "demo-app", false, time.Now())
			if scenario == "required-config" {
				if err != nil || len(result.Minions) != 1 || !result.Minions[0].ConfigurationRequired {
					t.Fatalf("%+v %v", result, err)
				}
				if _, err := os.Stat(filepath.Join(workspace, "minions/demo/config.json")); !os.IsNotExist(err) {
					t.Fatal("invented required settings")
				}
				return
			}
			if err == nil {
				t.Fatal("unsafe package accepted")
			}
			if _, err := os.Stat(filepath.Join(workspace, "minions/demo/main.py")); !os.IsNotExist(err) {
				t.Fatal("preflight mutated workspace")
			}
			if scenario == "collision" {
				assertMinionFile(t, workspace, "minions/demo/config.json", "local config")
			}
		})
	}
}

func TestMinionDistributionRebasePreservesInstanceState(t *testing.T) {
	cfg, workspace := setupLeanWorkspaceForTest(t)
	feature := filepath.Join(cfg.MetaRoot, "templates-cache/features/demo-app")
	app := minionFixture(t, feature, false)
	if _, err := FeatureInstall(cfg, "demo-app", false, time.Now()); err != nil {
		t.Fatal(err)
	}
	config := `{"trigger":{"on_new_entry":true},"target":17}`
	writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/config.json"), config)
	writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/data/entries.json"), "user data")
	// Simulate an older release which wrongly included instance state in its base.
	base := filepath.Join(cfg.MetaRoot, "managed/features/demo-app/base/minions/demo")
	writeCompatibilityFixture(t, filepath.Join(base, "config.json"), "old creator settings")
	writeCompatibilityFixture(t, filepath.Join(base, "data/entries.json"), "old creator data")
	writeCompatibilityFixture(t, filepath.Join(app, "main.py"), "# upstream v2\n")
	result, err := RebaseInstalledFeature(cfg, "demo-app", time.Now())
	if err != nil || result.Status == "conflict" || result.AutoForked {
		t.Fatalf("%+v %v", result, err)
	}
	assertMinionFile(t, workspace, "minions/demo/main.py", "# upstream v2\n")
	assertMinionFile(t, workspace, "minions/demo/config.json", config)
	assertMinionFile(t, workspace, "minions/demo/data/entries.json", "user data")
	// Custom code conflicts stage a proposal and leave every live file untouched.
	writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/main.py"), "# local customization\n")
	writeCompatibilityFixture(t, filepath.Join(app, "main.py"), "# upstream v3\n")
	result, err = RebaseInstalledFeature(cfg, "demo-app", time.Now())
	if err != nil || result.Status != "conflict" {
		t.Fatalf("%+v %v", result, err)
	}
	assertMinionFile(t, workspace, "minions/demo/main.py", "# local customization\n")
	assertMinionFile(t, workspace, "minions/demo/config.json", config)
	assertMinionFile(t, workspace, "minions/demo/data/entries.json", "user data")
	if _, err := FeatureRemove(cfg, "demo-app", time.Now()); err != nil {
		t.Fatal(err)
	}
	assertMinionFile(t, workspace, "minions/demo/config.json", config)
	assertMinionFile(t, workspace, "minions/demo/data/entries.json", "user data")
}

func TestMinionDistributionCrossRuntime(t *testing.T) {
	if _, err := exec.LookPath("bun"); err != nil {
		t.Skip("Bun is required for cross-runtime archive checks")
	}
	cfg, workspace := setupLeanWorkspaceForTest(t)
	source := filepath.Join(t.TempDir(), "source")
	minionFixture(t, source, false)
	writeCompatibilityFixture(t, filepath.Join(source, "workspace/minions/demo/config.json"), `{"trigger":"both","target":99}`)
	writeCompatibilityFixture(t, filepath.Join(source, "workspace/minions/demo/data/private.json"), "creator records")
	script := filepath.Join(cfg.RepositoryRoot, "packages/workspace-ui/scripts/check-minion-package.ts")
	archive := filepath.Join(t.TempDir(), "typescript.zip")
	command := exec.Command("bun", script, "export", source, archive)
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("TypeScript export: %v\n%s", err, out)
	}
	if _, err := FeatureImport(cfg, archive, false, time.Now()); err != nil {
		t.Fatal(err)
	}
	writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/data/recipient.json"), "recipient records")
	packaged, err := FeaturePackage(cfg, FeaturePackageOptions{FeatureID: "demo-app", IncludeRecords: true, OutputPath: filepath.Join(t.TempDir(), "go.zip")})
	if err != nil {
		t.Fatal(err)
	}
	catalog := filepath.Join(t.TempDir(), "catalog")
	feature := filepath.Join(catalog, "demo-app")
	if err := extractAndValidateFeatureZip(packaged.OutputPath, feature); err != nil {
		t.Fatal(err)
	}
	command = exec.Command("bun", script, "install", catalog, filepath.Join(t.TempDir(), "typescript-recipient"))
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("TypeScript import: %v\n%s", err, out)
	}
}

func TestMinionDistributionReimportPreservesLineageAndDeletedConfig(t *testing.T) {
	cfg, workspace := setupLeanWorkspaceForTest(t)
	source := filepath.Join(t.TempDir(), "source")
	app := minionFixture(t, source, false)
	if _, err := FeatureImport(cfg, source, false, time.Now()); err != nil {
		t.Fatal(err)
	}
	config := "{ locally invalid settings to repair later"
	writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/config.json"), config)
	writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/data/entries.json"), "user records")
	writeCompatibilityFixture(t, filepath.Join(app, "main.py"), "# imported v2\n")
	result, err := FeatureImport(cfg, source, false, time.Now())
	if err != nil || !result.Minions[0].ConfigurationRequired {
		t.Fatalf("%+v %v", result, err)
	}
	assertMinionFile(t, workspace, "minions/demo/main.py", "# imported v2\n")
	assertMinionFile(t, workspace, "minions/demo/config.json", config)
	assertMinionFile(t, workspace, "minions/demo/data/entries.json", "user records")
	// Updates must preserve intentional local deletions, not reseed them.
	if err := os.Remove(filepath.Join(workspace, "minions/demo/config.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(workspace, "minions/demo/scripts/helper.py")); err != nil {
		t.Fatal(err)
	}
	if _, err := FeatureImport(cfg, source, false, time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"config.json", "scripts/helper.py"} {
		if _, err := os.Stat(filepath.Join(workspace, "minions/demo", rel)); !os.IsNotExist(err) {
			t.Fatalf("reseeded local deletion: %s", rel)
		}
	}
	// A later conflicting update must still compare with the original base.
	writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/main.py"), "# local v3\n")
	writeCompatibilityFixture(t, filepath.Join(app, "main.py"), "# imported v3\n")
	if _, err := FeatureImport(cfg, source, false, time.Now()); err == nil || !strings.Contains(err.Error(), "conflicts") {
		t.Fatalf("expected rebase conflict, got %v", err)
	}
	assertMinionFile(t, workspace, "minions/demo/main.py", "# local v3\n")
	assertMinionFile(t, workspace, "minions/demo/data/entries.json", "user records")
}

func TestMinionDistributionArchiveRejectsAmbiguousAndUnsafePaths(t *testing.T) {
	for _, names := range [][]string{
		{"feature.yaml", "feature.yaml"},
		{"feature.yaml", "FEATURE.yaml"},
		{"wrapper/feature.yaml", "other/file.py"},
		{"wrapper/feature.yaml", "other/feature.yaml"},
		{"feature.yaml", "workspace/../outside.py"},
		{"feature.yaml", "workspace\\outside.py"},
	} {
		t.Run(strings.Join(names, ","), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "unsafe.zip")
			file, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			archive := zip.NewWriter(file)
			for _, name := range names {
				writer, err := archive.Create(name)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := writer.Write([]byte("test")); err != nil {
					t.Fatal(err)
				}
			}
			archive.Close()
			file.Close()
			if err := extractAndValidateFeatureZip(path, t.TempDir()); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}

func TestMinionDistributionFailedExportPreservesPreviousArchive(t *testing.T) {
	cfg, workspace := setupLeanWorkspaceForTest(t)
	source := filepath.Join(t.TempDir(), "source")
	minionFixture(t, source, false)
	if err := copyDirectoryContents(filepath.Join(source, "workspace"), workspace); err != nil {
		t.Fatal(err)
	}
	writeCompatibilityFixture(t, filepath.Join(workspace, "minions/demo/main.py"), "# -----BEGIN PRIVATE KEY-----")
	destination := filepath.Join(t.TempDir(), "app.zip")
	writeCompatibilityFixture(t, destination, "previous export")
	if _, err := FeaturePackage(cfg, FeaturePackageOptions{FeatureID: "demo-app", Domains: []string{"minions/demo"}, OutputPath: destination}); err == nil {
		t.Fatal("unsafe export accepted")
	}
	assertMinionFile(t, filepath.Dir(destination), "app.zip", "previous export")
}

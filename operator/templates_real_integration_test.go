package operator

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"openlia/internal/releaseinfo"
)

// Invoked only by the paired-revision runner. Production functions are called
// directly: no mocked parser, sync, installer, profile installer, or importer.
// Docker release identity is simulated; no live deployment is touched.
func TestRealTemplatesCatalogIntegration(t *testing.T) {
	source := os.Getenv("OPENLIA_INTEGRATION_TEMPLATES_ROOT")
	if source == "" {
		t.Skip("requires the paired runtime/templates integration runner")
	}
	repository, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	cfg := Config{RepositoryRoot: repository, DataRoot: filepath.Join(root, "data"), MetaRoot: filepath.Join(root, "meta"), TemplatesRepo: source, OutputLanguage: "en"}
	res, err := SyncTemplatesCatalog(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	// Explicitly consume the staged cache, not the mutable input checkout.
	cfg.TemplatesRepo = res.CacheDir
	t.Setenv("OPENLIA_TEMPLATES_ROOT", res.CacheDir)
	fakeCompatibilityDocker(t, `{"schema":1,"openlia":"`+releaseinfo.Default.OpenLia+`"}`)
	manifests, _, err := LoadCatalogFeaturesForConfig(cfg)
	if err != nil || len(manifests) == 0 {
		t.Fatalf("no actual catalog features: %v", err)
	}
	type item struct {
		ID      string `json:"id"`
		Version string `json:"version"`
	}
	summary := struct {
		Schema         int      `json:"schema"`
		Features       []item   `json:"features"`
		Profiles       []item   `json:"profiles"`
		Skills         []string `json:"skills"`
		TargetIdentity string   `json:"target_identity"`
		Tools          string   `json:"tools"`
	}{Schema: 1, TargetIdentity: "simulated deployed identity; real Go operator implementation", Tools: "registration verified; binaries not executed"}
	newConfig := func() Config {
		next := cfg
		dir := t.TempDir()
		next.DataRoot = filepath.Join(dir, "data")
		next.MetaRoot = filepath.Join(dir, "meta")
		return next
	}
	for _, manifest := range manifests {
		t.Run(manifest.ID, func(t *testing.T) {
			installCfg := newConfig()
			result, err := FeatureInstall(installCfg, manifest.ID, false, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if len(result.InstalledSkills) != len(manifest.Skills) {
				t.Fatalf("bundled skill fields were lost: %+v", result)
			}
			state, err := LoadLocalToolsState(installCfg.DataRoot)
			if err != nil {
				t.Fatal(err)
			}
			for _, tool := range manifest.Requires.Tools {
				if _, ok := state.Tools[tool]; !ok {
					t.Fatalf("required tool %s was not registered", tool)
				}
			}
			for _, domain := range manifest.Domains {
				if _, err := os.Stat(filepath.Join(installCfg.DataRoot, "workspace", domain.Path)); err != nil {
					t.Fatal(err)
				}
			}
			archive := filepath.Join(t.TempDir(), manifest.ID+".zip")
			if _, err := FeaturePackage(installCfg, FeaturePackageOptions{FeatureID: manifest.ID, OutputPath: archive}); err != nil {
				t.Fatal(err)
			}
			importCfg := newConfig()
			imported, err := FeatureImport(importCfg, archive, false, time.Now())
			if err != nil || imported.FeatureID != manifest.ID || len(imported.InstalledSkills) != len(manifest.Skills) {
				t.Fatalf("actual catalog package/import failed: %+v %v", imported, err)
			}
		})
		summary.Features = append(summary.Features, item{manifest.ID, manifest.Version})
	}
	profiles, err := filepath.Glob(filepath.Join(res.CacheDir, "profiles", "*", "profile.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range profiles {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		manifest, err := ParseProfileManifest(data)
		if err != nil {
			t.Fatal(err)
		}
		profileCfg := newConfig()
		if _, err := InstallTemplateProfile(profileCfg, manifest.ID, false, time.Now()); err != nil {
			t.Fatal(err)
		}
		summary.Profiles = append(summary.Profiles, item{manifest.ID, manifest.Version})
	}
	skills, err := LoadCatalogSkills(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for id := range skills {
		skillCfg := newConfig()
		result, err := SkillInstall(skillCfg, id, time.Now())
		if err != nil || result.Outcome != "installed" {
			t.Fatalf("actual catalog skill install %s failed: %+v %v", id, result, err)
		}
		summary.Skills = append(summary.Skills, id)
	}
	if t.Failed() {
		return
	}
	report := os.Getenv("OPENLIA_INTEGRATION_GO_REPORT")
	if report == "" {
		t.Fatal("paired runner must supply an isolated Go integration report path")
	}
	data, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := AtomicWriteFile(report, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

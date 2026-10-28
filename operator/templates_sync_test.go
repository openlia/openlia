package operator

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func catalogGitTest(t *testing.T, root string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", root, "-c", "user.name=Catalog Test", "-c", "user.email=catalog@example.invalid", "-c", "commit.gpgsign=false"}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

func writeSyncCatalog(t *testing.T, root, version string) {
	t.Helper()
	writeCompatibilityFixture(t, filepath.Join(root, "features", "example", "feature.yaml"), "schema: 1\nid: example\nname: Example\nversion: "+version+"\ndescription: Example\n")
	writeCompatibilityFixture(t, filepath.Join(root, "features", "example", "workspace", "example", "note.md"), "version "+version)
	writeCompatibilityFixture(t, filepath.Join(root, "catalog.json"), `{"schema":1,"features":[{"id":"example","version":"`+version+`","path":"features/example"}]}`)
}

func syncConfigTest(t *testing.T, source string) Config {
	t.Helper()
	root := t.TempDir()
	return Config{RepositoryRoot: filepath.Join(root, "runtime"), DataRoot: filepath.Join(root, "data"), MetaRoot: filepath.Join(root, "meta"), TemplatesRepo: source}
}

func TestTemplatesSyncPinnedRefsAndSourceChanges(t *testing.T) {
	source := t.TempDir()
	catalogGitTest(t, source, "init", "-q")
	writeSyncCatalog(t, source, "1.0.0")
	catalogGitTest(t, source, "add", ".")
	catalogGitTest(t, source, "commit", "-qm", "first")
	first := catalogGitTest(t, source, "rev-parse", "HEAD")
	catalogGitTest(t, source, "tag", "catalog-v1")
	writeSyncCatalog(t, source, "2.0.0")
	catalogGitTest(t, source, "add", ".")
	catalogGitTest(t, source, "commit", "-qm", "second")
	second := catalogGitTest(t, source, "rev-parse", "HEAD")
	cfg := syncConfigTest(t, source)
	for _, ref := range []string{first, second, "catalog-v1", second} {
		cfg.TemplatesRef = ref
		result, err := SyncTemplatesCatalog(context.Background(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		want := second
		if ref == first || ref == "catalog-v1" {
			want = first
		}
		if result.Catalog.Revision != want || result.Catalog.Ref != ref || result.Catalog.Mode != "git" || result.Catalog.Dirty {
			t.Fatalf("wrong provenance: %+v", result.Catalog)
		}
		if ResolveTemplatesRoot(cfg) != result.CacheDir {
			t.Fatal("explicit ref must not read the live checkout")
		}
	}
	other := t.TempDir()
	catalogGitTest(t, other, "init", "-q")
	writeSyncCatalog(t, other, "3.0.0")
	catalogGitTest(t, other, "add", ".")
	catalogGitTest(t, other, "commit", "-qm", "other source")
	cfg.TemplatesRepo = other
	cfg.TemplatesRef = catalogGitTest(t, other, "rev-parse", "HEAD")
	result, err := SyncTemplatesCatalog(context.Background(), cfg)
	if err != nil || result.Catalog.Revision != cfg.TemplatesRef || result.Source != other {
		t.Fatalf("source change failed: %+v %v", result, err)
	}
	if !result.UIRefreshRequired {
		t.Fatal("replacement must report stale existing bind mounts")
	}
	previous, err := os.ReadFile(filepath.Join(result.PreviousCacheDir, "features/example/workspace/example/note.md"))
	if err != nil || string(previous) != "version 2.0.0" {
		t.Fatalf("mounted previous snapshot was not retained: %q %v", previous, err)
	}
	installed, err := FeatureInstall(cfg, "example", false, time.Now())
	if err != nil || installed.Catalog.Revision != cfg.TemplatesRef {
		t.Fatalf("install provenance missing: %+v %v", installed, err)
	}
	show, err := FeatureShow(cfg, "example")
	if err != nil || show.Status.InstalledCatalog.Revision != cfg.TemplatesRef {
		t.Fatalf("status provenance missing: %+v %v", show, err)
	}
}

func TestTemplatesSyncFailuresPreservePreviousCache(t *testing.T) {
	for _, failure := range []string{"missing-ref", "invalid-manifest", "stale-index", "symlink", "canceled"} {
		t.Run(failure, func(t *testing.T) {
			source := t.TempDir()
			writeSyncCatalog(t, source, "1.0.0")
			cfg := syncConfigTest(t, source)
			result, err := SyncTemplatesCatalog(context.Background(), cfg)
			if err != nil {
				t.Fatal(err)
			}
			before, err := DirectorySHA256(result.CacheDir)
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			switch failure {
			case "missing-ref":
				catalogGitTest(t, source, "init", "-q")
				cfg.TemplatesRef = "missing-ref"
			case "invalid-manifest":
				writeCompatibilityFixture(t, filepath.Join(source, "features/example/feature.yaml"), "schema: [invalid\n")
			case "stale-index":
				writeCompatibilityFixture(t, filepath.Join(source, "catalog.json"), `{"schema":1,"features":[]}`)
			case "symlink":
				if err := os.Symlink(t.TempDir(), filepath.Join(source, "outside")); err != nil {
					t.Fatal(err)
				}
			case "canceled":
				catalogGitTest(t, source, "init", "-q")
				cfg.TemplatesRef = "HEAD"
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if _, err := SyncTemplatesCatalog(ctx, cfg); err == nil {
				t.Fatalf("accepted %s", failure)
			}
			after, err := DirectorySHA256(result.CacheDir)
			if err != nil || before != after {
				t.Fatalf("failed sync changed previous cache: %v", err)
			}
		})
	}
}

func TestTemplatesLocalSnapshotReportsDirtyContentAndPrunesRemovedFiles(t *testing.T) {
	source := t.TempDir()
	catalogGitTest(t, source, "init", "-q")
	writeSyncCatalog(t, source, "1.0.0")
	catalogGitTest(t, source, "add", ".")
	catalogGitTest(t, source, "commit", "-qm", "initial")
	cfg := syncConfigTest(t, source)
	first, err := SyncTemplatesCatalog(context.Background(), cfg)
	if err != nil || first.Catalog.Dirty {
		t.Fatalf("clean checkout: %+v %v", first, err)
	}
	before, err := os.Stat(first.CacheDir)
	if err != nil {
		t.Fatal(err)
	}
	unchanged, err := SyncTemplatesCatalog(context.Background(), cfg)
	if err != nil || unchanged.UIRefreshRequired || unchanged.PreviousCacheDir != "" {
		t.Fatalf("unchanged sync must preserve active mounts: %+v %v", unchanged, err)
	}
	after, err := os.Stat(first.CacheDir)
	if err != nil || !os.SameFile(before, after) {
		t.Fatal("unchanged sync replaced the mounted directory")
	}
	writeCompatibilityFixture(t, filepath.Join(source, "extra.md"), "local edit")
	second, err := SyncTemplatesCatalog(context.Background(), cfg)
	if err != nil || !second.Catalog.Dirty || second.Catalog.ContentSHA256 == first.Catalog.ContentSHA256 {
		t.Fatalf("dirty checkout: %+v %v", second, err)
	}
	if err := os.Remove(filepath.Join(source, "extra.md")); err != nil {
		t.Fatal(err)
	}
	third, err := SyncTemplatesCatalog(context.Background(), cfg)
	if err != nil || third.Catalog.ContentSHA256 != first.Catalog.ContentSHA256 {
		t.Fatalf("resync: %+v %v", third, err)
	}
	if _, err := os.Stat(filepath.Join(third.CacheDir, "extra.md")); !os.IsNotExist(err) {
		t.Fatal("removed source files must not remain cached")
	}
	var recorded TemplatesCatalogProvenance
	data, err := os.ReadFile(filepath.Join(third.CacheDir, catalogProvenanceFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &recorded); err != nil || recorded.ContentSHA256 != third.Catalog.ContentSHA256 {
		t.Fatal("missing persisted sync identity")
	}
}

func TestTemplatesInstallationAdoptsChangedPinAndRecordsSkillCatalog(t *testing.T) {
	source := t.TempDir()
	catalogGitTest(t, source, "init", "-q")
	writeSyncCatalog(t, source, "1.0.0")
	catalogGitTest(t, source, "add", ".")
	catalogGitTest(t, source, "commit", "-qm", "first")
	first := catalogGitTest(t, source, "rev-parse", "HEAD")
	writeSyncCatalog(t, source, "2.0.0")
	catalogGitTest(t, source, "add", ".")
	catalogGitTest(t, source, "commit", "-qm", "second")
	second := catalogGitTest(t, source, "rev-parse", "HEAD")
	cfg := syncConfigTest(t, source)
	cfg.TemplatesRef = first
	if _, err := SyncTemplatesCatalog(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	cfg.TemplatesRef = second
	installed, err := FeatureInstall(cfg, "example", false, time.Now())
	if err != nil || installed.Catalog.Revision != second {
		t.Fatalf("installation used stale pin: %+v %v", installed, err)
	}

	local, _ := setupLeanWorkspaceForTest(t)
	for i := 0; i < 2; i++ {
		if _, err := SkillInstall(local, "personal-finance", time.Now()); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(local.MetaRoot, "managed/skills/personal-finance.json")
		metadata, err := readFullSkillMetadata(path, "personal-finance")
		if err != nil || metadata.Catalog == nil || metadata.CatalogArtifactPath != "features/personal-finance/skills/personal-finance" {
			t.Fatalf("skill provenance lost or invalid: %+v %v", metadata, err)
		}
	}
}

func TestTemplatesDefaultsArePinnedAndSiblingIsNotImplicit(t *testing.T) {
	if len(DefaultTemplatesRef) != 40 || strings.Trim(DefaultTemplatesRef, "0123456789abcdef") != "" {
		t.Fatal("default catalog ref must be a full SHA")
	}
	root := t.TempDir()
	writeSyncCatalog(t, filepath.Join(root, "openlia_templates"), "1.0.0")
	cfg := Config{RepositoryRoot: filepath.Join(root, "open_lia"), MetaRoot: filepath.Join(root, "meta")}
	if ResolveTemplatesRoot(cfg) == filepath.Join(root, "openlia_templates") {
		t.Fatal("unconfigured sibling must not override the production pin")
	}
}

func TestTemplatesSyncCannotReplaceCatalogDuringInstallation(t *testing.T) {
	source := t.TempDir()
	catalogGitTest(t, source, "init", "-q")
	writeSyncCatalog(t, source, "1.0.0")
	catalogGitTest(t, source, "add", ".")
	catalogGitTest(t, source, "commit", "-qm", "initial")
	cfg := syncConfigTest(t, source)
	cfg.TemplatesRef = catalogGitTest(t, source, "rev-parse", "HEAD")
	if _, err := SyncTemplatesCatalog(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	unlock, err := lockTemplatesCatalogForRead(cfg)
	if err != nil {
		t.Fatal(err)
	}
	_, syncErr := SyncTemplatesCatalog(context.Background(), cfg)
	unlock()
	if syncErr == nil || !strings.Contains(syncErr.Error(), "already in progress") {
		t.Fatalf("writer replaced a generation in use: %v", syncErr)
	}
	if _, err := SyncTemplatesCatalog(context.Background(), cfg); err != nil {
		t.Fatalf("sync remained locked after install: %v", err)
	}
}

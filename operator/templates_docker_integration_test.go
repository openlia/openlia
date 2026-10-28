package operator

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTemplatesDockerBindMountLifecycle(t *testing.T) {
	if os.Getenv("OPENLIA_INTEGRATION_DOCKER") != "true" {
		t.Skip("requires --docker in the paired integration runner")
	}
	source := t.TempDir()
	writeSyncCatalog(t, source, "1.0.0")
	cfg := syncConfigTest(t, source)
	cfg.ProjectName = fmt.Sprintf("openlia-catalog-test-%d", time.Now().UnixNano())
	cfg.ComposeProjectDir = t.TempDir()
	cfg.ComposeFile = filepath.Join(cfg.ComposeProjectDir, "compose.yaml")
	cfg.WorkspaceUIHost = "127.0.0.1"
	initial, err := SyncTemplatesCatalog(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	writeCompatibilityFixture(t, cfg.ComposeFile, fmt.Sprintf("services:\n  workspace-ui:\n    image: alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\n    command: [sleep, '300']\n    network_mode: none\n    read_only: true\n    volumes:\n      - %q\n", initial.CacheDir+":/templates-cache:ro"))
	compose := NewCompose(cfg, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	t.Cleanup(func() {
		cleanupCtx, done := context.WithTimeout(context.Background(), 30*time.Second)
		defer done()
		if _, err := compose.Run(cleanupCtx, "down", "--remove-orphans"); err != nil {
			t.Errorf("cleanup isolated catalog test containers: %v", err)
		}
	})
	if result, err := compose.Run(ctx, "up", "-d"); err != nil {
		t.Fatalf("start isolated bind mount consumer: %v %s", err, result.Stderr)
	}
	writeSyncCatalog(t, source, "2.0.0")
	changed, err := SyncTemplatesCatalog(ctx, cfg)
	if err != nil || !changed.UIRefreshRequired {
		t.Fatalf("old Docker mount was not detected: %+v %v", changed, err)
	}
	repeated, err := SyncTemplatesCatalog(ctx, cfg)
	if err != nil || !repeated.UIRefreshRequired {
		t.Fatalf("identical sync incorrectly acknowledged old Docker mount: %+v %v", repeated, err)
	}
	if result, err := compose.Run(ctx, "up", "-d", "--no-deps", "--force-recreate", "workspace-ui"); err != nil {
		t.Fatalf("recreate isolated consumer: %v %s", err, result.Stderr)
	}
	current, err := SyncTemplatesCatalog(ctx, cfg)
	if err != nil || current.UIRefreshRequired {
		t.Fatalf("recreated Docker mount was not acknowledged: %+v %v", current, err)
	}
}

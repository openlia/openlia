package operator

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRemindProvisioningRejectsWrongNativeVersion(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "remind")
	writeCompatibilityFixture(t, binary, "#!/bin/sh\necho 04.03.01\n")
	if err := os.Chmod(binary, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := Config{DataRoot: filepath.Join(root, "data"), RepositoryRoot: root, MetaRoot: filepath.Join(root, "meta")}
	writeCompatibilityFixture(t, localToolsOverridesPath(cfg.DataRoot), "tools:\n  remind:\n    binary_path: "+binary+"\n")
	if _, err := ProvisionRequiredTools(cfg, []string{"remind"}, "test"); err == nil {
		t.Fatal("older distro binary was accepted as the pinned Remind")
	}
	state, err := LoadLocalToolsState(cfg.DataRoot)
	if err != nil || len(state.Tools) != 0 {
		t.Fatal("failed provisioning published a false version record")
	}
}

func TestRemindWrapperRevalidatesNativeVersionAndRestoreMigratesPin(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "remind")
	writeCompatibilityFixture(t, binary, "#!/bin/sh\necho "+toolcatalogRemindVersion()+"\n")
	if err := os.Chmod(binary, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := Config{DataRoot: filepath.Join(root, "data"), RepositoryRoot: root, MetaRoot: filepath.Join(root, "meta")}
	writeCompatibilityFixture(t, localToolsOverridesPath(cfg.DataRoot), "tools:\n  remind:\n    binary_path: "+binary+"\n")
	if _, err := ProvisionRequiredTools(cfg, []string{"remind"}, "test"); err != nil {
		t.Fatal(err)
	}
	exposed := filepath.Join(cfg.DataRoot, ".local/bin/remind")
	if output, err := exec.Command(exposed, "--version").CombinedOutput(); err != nil || strings.TrimSpace(string(output)) != toolcatalogRemindVersion() {
		t.Fatalf("pinned wrapper failed: %s %v", output, err)
	}
	writeCompatibilityFixture(t, binary, "#!/bin/sh\necho 04.03.01\n")
	if _, err := exec.Command(exposed, "--version").Output(); err == nil {
		t.Fatal("host downgrade silently changed the pinned executable")
	}
	writeCompatibilityFixture(t, binary, "#!/bin/sh\necho "+toolcatalogRemindVersion()+"\n")
	state, err := LoadLocalToolsState(cfg.DataRoot)
	if err != nil {
		t.Fatal(err)
	}
	record := state.Tools["remind"]
	record.Version = "05.00.02"
	state.Tools["remind"] = record
	if err := SaveLocalToolsState(cfg.DataRoot, state); err != nil {
		t.Fatal(err)
	}
	if err := ReprovisionLocalStore(cfg); err != nil {
		t.Fatal(err)
	}
	state, err = LoadLocalToolsState(cfg.DataRoot)
	if err != nil || state.Tools["remind"].Version != toolcatalogRemindVersion() {
		t.Fatalf("restore did not migrate the Remind pin: %+v %v", state, err)
	}
}

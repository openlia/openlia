package cli

import (
	"runtime/debug"
	"testing"
)

func TestVersionInfoFromCleanBuild(t *testing.T) {
	info := versionInfoFromSettings([]debug.BuildSetting{
		{Key: "vcs.revision", Value: "471234288494f25aca1bce5493ce5c2b8355a308"},
		{Key: "vcs.modified", Value: "false"},
	})
	if info.Release != "0.1.0+release.471234288494" || info.Modified {
		t.Fatalf("unexpected clean build info: %#v", info)
	}
	if info.Hermes != "v0.22.4" || info.Locho != "1.3.0-beta.2" {
		t.Fatalf("unexpected component versions: %#v", info)
	}
}

func TestVersionInfoFromDirtyBuild(t *testing.T) {
	info := versionInfoFromSettings([]debug.BuildSetting{
		{Key: "vcs.revision", Value: "471234288494f25aca1bce5493ce5c2b8355a308"},
		{Key: "vcs.modified", Value: "true"},
	})
	if info.Release != "0.1.0+dev.471234288494.dirty" || !info.Modified {
		t.Fatalf("unexpected dirty build info: %#v", info)
	}
}

func TestVersionInfoWithoutBuildMetadataFailsClosed(t *testing.T) {
	info := versionInfoFromSettings(nil)
	if info.Release != "0.1.0+unknown" || !info.Modified || info.Revision != "" {
		t.Fatalf("unexpected missing metadata info: %#v", info)
	}
}

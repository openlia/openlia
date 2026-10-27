package toolcatalog

import (
	"strings"
	"testing"
)

func TestManagedHermesImageIsStableForRequiredDependencies(t *testing.T) {
	first := ManagedHermesImage("project", "v1", "digest-a", "snapshot")
	second := ManagedHermesImage("project", "v1", "digest-a", "snapshot")
	if first != second {
		t.Fatalf("tool order changed managed image: %q != %q", first, second)
	}
}

func TestManagedHermesImageSeparatesProjectsAndBaseImages(t *testing.T) {
	base := ManagedHermesImage("project", "v1", "digest-a", "snapshot")
	for _, different := range []string{
		ManagedHermesImage("other", "v1", "digest-a", "snapshot"),
		ManagedHermesImage("project", "v2", "digest-a", "snapshot"),
		ManagedHermesImage("project", "v1", "digest-b", "snapshot"),
		ManagedHermesImage("project", "v1", "digest-a", "other-snapshot"),
	} {
		if base == different {
			t.Fatalf("managed image identity collision: %q", base)
		}
	}
}

func TestManagedHermesImageBoundsLongProjectNames(t *testing.T) {
	image := ManagedHermesImage(strings.Repeat("p", 200), "v1", "digest", "snapshot")
	if len(image) > 128 {
		t.Fatalf("managed image exceeds Docker tag length: %d", len(image))
	}
}

func TestCuratedToolCatalogLookupAndValidation(t *testing.T) {
	for _, name := range []string{"hledger", "remind", "jq", "sqlite3"} {
		if err := ValidateToolName(name); err != nil {
			t.Fatalf("expected %s to be valid: %v", name, err)
		}
		spec, ok := LookupTool(name)
		if !ok || spec.Binary != name || spec.DefaultVersion == "" {
			t.Fatalf("unexpected ToolSpec for %s: %+v", name, spec)
		}
	}
	if err := ValidateToolName("unknown-binary"); err == nil {
		t.Fatal("expected unsupported tool name to fail validation")
	}
}

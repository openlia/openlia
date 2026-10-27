package validator

import (
	"os"
	"path/filepath"
	"testing"

	"openlia/operator/migration"
)

func TestValidateMarkdownFrontmatter(t *testing.T) {
	// Valid markdown with frontmatter
	validContent := "---\ntitle: My Document\ncategory: Notes\ntags:\n  - idea\n  - review\n---\n# Body text\n"
	f := validateMarkdownFrontmatter("doc1.md", []byte(validContent))
	if f != nil {
		t.Fatalf("expected nil finding for valid frontmatter, got: %+v", f)
	}

	// Markdown without frontmatter
	noFrontmatter := "# Regular Markdown\nJust content.\n"
	f = validateMarkdownFrontmatter("doc2.md", []byte(noFrontmatter))
	if f != nil {
		t.Fatalf("expected nil finding for markdown without frontmatter, got: %+v", f)
	}

	// Unclosed frontmatter
	unclosed := "---\ntitle: Missing closing\n# Content\n"
	f = validateMarkdownFrontmatter("doc3.md", []byte(unclosed))
	if f == nil || f.Severity != "error" {
		t.Fatalf("expected error finding for unclosed frontmatter, got: %+v", f)
	}

	// Invalid YAML syntax (non-key-value unindented line)
	badYAML := "---\ntitle: Broken\ninvalid unindented text without colon\n---\n# Content\n"
	f = validateMarkdownFrontmatter("doc4.md", []byte(badYAML))
	if f == nil || f.Severity != "error" {
		t.Fatalf("expected error finding for bad YAML line, got: %+v", f)
	}
	if f.Line != 3 {
		t.Errorf("expected error on line 3, got line %d", f.Line)
	}
}

func TestValidateProposalWorkspace(t *testing.T) {
	tmpDir := t.TempDir()

	validMD := "---\ntitle: Hello\n---\n# World\n"
	badMD := "---\nbad line without colon\n---\n"
	_ = os.WriteFile(filepath.Join(tmpDir, "good.md"), []byte(validMD), 0o600)
	_ = os.WriteFile(filepath.Join(tmpDir, "bad.md"), []byte(badMD), 0o600)

	changedFiles := []migration.ChangedFileEntry{
		{Path: "good.md", Status: "added"},
		{Path: "bad.md", Status: "modified"},
		{Path: "deleted.md", Status: "deleted"},
	}

	findings := ValidateProposalWorkspace(tmpDir, changedFiles)
	if len(findings) != 1 {
		t.Fatalf("expected 1 finding for bad.md, got %d: %+v", len(findings), findings)
	}
	if findings[0].File != "bad.md" {
		t.Errorf("expected finding for bad.md, got %s", findings[0].File)
	}
}

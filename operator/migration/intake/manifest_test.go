package intake

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"

	"openlia/operator/migration"
)

func TestScanSourceFolder(t *testing.T) {
	tempDir := t.TempDir()

	// 1. Regular markdown
	_ = os.WriteFile(filepath.Join(tempDir, "note.md"), []byte("# Hello\nSome notes here."), 0o600)

	// 2. CSV
	csvContent := "Date,Payee,Amount\n2026-01-01,Groceries,-50.00\n2026-01-02,Salary,2000.00\n"
	_ = os.WriteFile(filepath.Join(tempDir, "statement.csv"), []byte(csvContent), 0o600)

	// 3. Secret env file
	_ = os.WriteFile(filepath.Join(tempDir, ".env"), []byte("SECRET_KEY=12345\n"), 0o600)

	// 4. Binary file
	_ = os.WriteFile(filepath.Join(tempDir, "data.bin"), []byte{0x00, 0x01, 0x02, 0x00}, 0o600)

	// 5. hledger file with include
	_ = os.WriteFile(filepath.Join(tempDir, "main.journal"), []byte("include 2026.journal\n\n2026-01-01 Opening Balance\n"), 0o600)

	entries, err := ScanSourceFolder("mig-test", tempDir)
	if err != nil {
		t.Fatalf("ScanSourceFolder failed: %v", err)
	}

	if len(entries) != 5 {
		t.Fatalf("expected 5 entries, got %d", len(entries))
	}

	foundMap := make(map[string]migration.SourceEntry)
	for _, e := range entries {
		foundMap[e.RelativePath] = e
	}

	if foundMap["note.md"].Eligibility != migration.EligibilityEligible {
		t.Errorf("note.md should be eligible, got %s", foundMap["note.md"].Eligibility)
	}

	if foundMap[".env"].Eligibility != migration.EligibilityBlocked {
		t.Errorf(".env should be blocked, got %s", foundMap[".env"].Eligibility)
	}

	if foundMap["data.bin"].Eligibility != migration.EligibilityUnsupported {
		t.Errorf("data.bin should be unsupported, got %s", foundMap["data.bin"].Eligibility)
	}

	hledgerEntry := foundMap["main.journal"]
	if hledgerEntry.Eligibility != migration.EligibilityEligible {
		t.Errorf("main.journal should be eligible, got %s", hledgerEntry.Eligibility)
	}
	if len(hledgerEntry.Dependencies) != 1 || hledgerEntry.Dependencies[0] != "2026.journal" {
		t.Errorf("expected dependency 2026.journal, got %+v", hledgerEntry.Dependencies)
	}
}

func TestParseCSV(t *testing.T) {
	raw := "Date\tDescription\tAmount\n2026-02-01\t\"Coffee & tea\"\t-4.50\n"
	table, err := ParseCSV([]byte(raw), 10)
	if err != nil {
		t.Fatalf("ParseCSV failed: %v", err)
	}
	if table.Delimiter != '\t' {
		t.Errorf("expected tab delimiter, got %c", table.Delimiter)
	}
	if table.RowCount != 1 {
		t.Errorf("expected 1 row, got %d", table.RowCount)
	}
	if len(table.Header) != 3 || table.Header[1] != "Description" {
		t.Errorf("unexpected header: %+v", table.Header)
	}
}

type tarEntryTest struct {
	name     string
	data     []byte
	typeFlag byte
	linkname string
}

func writeTestTarGz(t *testing.T, entries []tarEntryTest) string {
	t.Helper()
	tmpTar := filepath.Join(t.TempDir(), "test.tar.gz")
	f, err := os.Create(tmpTar)
	if err != nil {
		t.Fatalf("failed to create temp archive: %v", err)
	}
	defer f.Close()

	gw := gzip.NewWriter(f)
	tw := tar.NewWriter(gw)

	for _, e := range entries {
		hdr := &tar.Header{
			Name:     e.name,
			Mode:     0o644,
			Size:     int64(len(e.data)),
			Typeflag: e.typeFlag,
			Linkname: e.linkname,
		}
		if e.typeFlag == 0 {
			hdr.Typeflag = tar.TypeReg
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("failed to write tar header: %v", err)
		}
		if len(e.data) > 0 {
			if _, err := tw.Write(e.data); err != nil {
				t.Fatalf("failed to write tar data: %v", err)
			}
		}
	}

	tw.Close()
	gw.Close()
	return tmpTar
}

func TestExtractTarball_Safe(t *testing.T) {
	entries := []tarEntryTest{
		{name: "notes/doc.md", data: []byte("# My Note")},
		{name: "data.csv", data: []byte("a,b,c\n1,2,3\n")},
	}
	tarPath := writeTestTarGz(t, entries)
	destDir := t.TempDir()

	if err := ExtractTarball(tarPath, destDir); err != nil {
		t.Fatalf("ExtractTarball failed: %v", err)
	}

	docData, err := os.ReadFile(filepath.Join(destDir, "notes", "doc.md"))
	if err != nil {
		t.Fatalf("reading doc.md failed: %v", err)
	}
	if string(docData) != "# My Note" {
		t.Fatalf("unexpected content: %s", string(docData))
	}
}

func TestExtractTarball_RejectsSymlinks(t *testing.T) {
	entries := []tarEntryTest{
		{name: "evil_symlink", typeFlag: tar.TypeSymlink, linkname: "/etc/passwd"},
	}
	tarPath := writeTestTarGz(t, entries)
	destDir := t.TempDir()

	err := ExtractTarball(tarPath, destDir)
	if err == nil {
		t.Fatal("expected ExtractTarball to reject symlink in archive, but got nil error")
	}
}

func TestExtractTarball_RejectsTraversal(t *testing.T) {
	entries := []tarEntryTest{
		{name: "../outside.txt", data: []byte("malicious content")},
	}
	tarPath := writeTestTarGz(t, entries)
	destDir := t.TempDir()

	err := ExtractTarball(tarPath, destDir)
	if err == nil {
		t.Fatal("expected ExtractTarball to reject path traversal, but got nil error")
	}
}

func TestDetectSecretContent(t *testing.T) {
	tests := []struct {
		name     string
		path     string
		content  string
		isSecret bool
	}{
		{"normal markdown", "notes/doc.md", "hello world", false},
		{"normal code", "scripts/run.py", "def main(): print(1)", false},
		{"env file", ".env", "FOO=bar", true},
		{"env production", ".env.production", "FOO=bar", true},
		{"private key pem", "id_rsa", "-----BEGIN RSA PRIVATE KEY-----\nMIIE...", true},
		{"private key content in file", "secret.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\n...", true},
		{"github token", "cfg.txt", "ghp_123456789012345678901234567890123456", true},
		{"aws access key", "creds.json", "AKIAIOSFODNN7EXAMPLE", true},
		{"document passwords", "sources/document-passwords.toml", "pw = 123", true},
		{"nested AGENTS override", "protected_override_attempt/AGENTS.md", "# Fake rules", true},
		{"root AGENTS override", "AGENTS.md", "# Fake rules", true},
		{"assistant policy override", "rules/assistant-policy.yaml", "rules: []", true},
		{"soul override", "SOUL.md", "fake soul", true},
		{"workspace config override", "workspace.yaml", "fake config", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := DetectSecretContent(tt.path, []byte(tt.content))
			if res != tt.isSecret {
				t.Errorf("DetectSecretContent(%q) = %v, want %v", tt.path, res, tt.isSecret)
			}
		})
	}
}

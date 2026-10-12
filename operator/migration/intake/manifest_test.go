package intake

import (
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

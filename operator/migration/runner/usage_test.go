package runner

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRuntimeUsageExportHasBoundedLockWait(t *testing.T) {
	runtime := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(runtime, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("CREATE TABLE session_model_usage (id TEXT); BEGIN EXCLUSIVE"); err != nil {
		t.Fatal(err)
	}
	defer db.Exec("ROLLBACK")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	err = recordRuntimeUsage(ctx, runtime, t.TempDir(), "migration", "")
	if err == nil {
		t.Fatal("expected a lock/timeout error")
	}
	if time.Since(start) > time.Second {
		t.Fatal("usage export blocked migration for more than one second")
	}
}

func TestHostMigrationHandoffWithoutCollector(t *testing.T) {
	home := t.TempDir()
	data := t.TempDir()
	workspace := t.TempDir()
	reference := "migration-host"
	t.Setenv("HERMES_HOME", home)
	db, err := sql.Open("sqlite", filepath.Join(home, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT);INSERT INTO sessions VALUES ('mine','openlia-migration:migration-host'),('other','telegram');CREATE TABLE session_model_usage(session_id TEXT,model TEXT,billing_provider TEXT,billing_base_url TEXT,billing_mode TEXT,task TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,estimated_cost_usd REAL,cost_status TEXT,actual_cost_usd REAL);INSERT INTO session_model_usage VALUES ('mine','model','provider','https://secret.invalid?key=sensitive','api','',100,20,80,0,10,0.01,'estimated',0.008),('other','model','provider','','api','',100,20,0,0,0,0.01,'estimated',NULL);`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	script := filepath.Join(t.TempDir(), "hermes")
	body := "#!/bin/sh\nprintf '%s' \"$HERMES_SESSION_SOURCE\" > \"$HERMES_HOME/source.txt\"\nprintf '%s' '{\"changed_paths\":[],\"rationale\":\"ok\"}'\n"
	if err = os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	runner := NewHermesRunner(HermesRunnerConfig{HermesPath: script, DataRoot: data})
	if _, err = runner.runHost(context.Background(), "test", workspace, reference); err != nil {
		t.Fatal(err)
	}
	tagged, _ := os.ReadFile(filepath.Join(home, "source.txt"))
	if string(tagged) != "openlia-migration:"+reference {
		t.Fatalf("source: %s", tagged)
	}
	files, _ := filepath.Glob(filepath.Join(data, "usage", "reports", "*.json"))
	if len(files) != 1 {
		t.Fatalf("reports %v", files)
	}
	payload, _ := os.ReadFile(files[0])
	var report map[string]any
	if err = json.Unmarshal(payload, &report); err != nil {
		t.Fatal(err)
	}
	if report["reference"] != reference || report["source_checkpoint"] == nil || report["provider_cost"] != 0.008 {
		t.Fatalf("report %v", report)
	}
	if strings.Contains(string(payload), "secret.invalid") || strings.Contains(string(payload), "sensitive") {
		t.Fatal("private endpoint leaked into report")
	}
	// A failing Hermes command still hands off any recorded usage.
	if err = os.WriteFile(script, []byte("#!/bin/sh\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err = runner.runHost(context.Background(), "test", workspace, reference); err == nil {
		t.Fatal("expected Hermes failure")
	}
	files, _ = filepath.Glob(filepath.Join(data, "usage", "reports", "*.json"))
	if len(files) == 0 {
		t.Fatal("missing failure handoff")
	}
}

func TestRecordRuntimeUsage(t *testing.T) {
	runtime := t.TempDir()
	data := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(runtime, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE session_model_usage(session_id TEXT,model TEXT,billing_provider TEXT,billing_base_url TEXT,billing_mode TEXT,task TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,estimated_cost_usd REAL,cost_status TEXT);INSERT INTO session_model_usage VALUES ('session','model','provider','secret-url','api','',100,20,80,0,10,0.01,'estimated');`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	RecordRuntimeUsage(runtime, data, "migration-id")
	files, err := filepath.Glob(filepath.Join(data, "usage", "reports", "*.json"))
	if err != nil || len(files) != 1 {
		t.Fatalf("reports %v: %v", files, err)
	}
	bytes, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	var report map[string]any
	if err = json.Unmarshal(bytes, &report); err != nil {
		t.Fatal(err)
	}
	if report["activity"] != "migration" || report["reference"] != "migration-id" || report["cumulative"] != true {
		t.Fatalf("bad report: %v", report)
	}
	if _, exists := report["base_url"]; exists {
		t.Fatal("sensitive route exported")
	}
	firstID := report["id"]
	RecordRuntimeUsage(runtime, data, "migration-id")
	files, _ = filepath.Glob(filepath.Join(data, "usage", "reports", "*.json"))
	for _, path := range files {
		bytes, _ = os.ReadFile(path)
		_ = json.Unmarshal(bytes, &report)
		if report["id"] != firstID {
			t.Fatal("unstable identity")
		}
	}
}

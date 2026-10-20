package runner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// RecordRuntimeUsage exports cumulative aggregates from the isolated Hermes home.
// Stable identities and collector high-water marks make replay safe. Best effort:
// monitoring failures must not change migration outcomes.
func RecordRuntimeUsage(runtimeDir, dataRoot, reference string, owners ...int) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := recordRuntimeUsage(ctx, runtimeDir, dataRoot, reference, "", owners...); err != nil {
		log.Printf("migration usage export unavailable: %v", err)
	}
}

// Shared homes use the same checkpoint identity as the collector, preventing
// double counting regardless of whether the report or the polling import wins.
func RecordSharedRuntimeUsage(runtimeDir, dataRoot, reference string, owners ...int) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := recordRuntimeUsage(ctx, runtimeDir, dataRoot, reference, "openlia-migration:"+reference, owners...); err != nil {
		log.Printf("migration usage export unavailable: %v", err)
	}
}

func recordRuntimeUsage(ctx context.Context, runtimeDir, dataRoot, reference, source string, owners ...int) error {
	if runtimeDir == "" || dataRoot == "" {
		return nil
	}
	path, _ := filepath.Abs(filepath.Join(runtimeDir, "state.db"))
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	u := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err = db.ExecContext(ctx, "PRAGMA busy_timeout=250"); err != nil {
		return err
	}
	columns, err := db.QueryContext(ctx, "PRAGMA table_info(session_model_usage)")
	if err != nil {
		return err
	}
	hasActual := false
	for columns.Next() {
		var cid, notnull, pk int
		var name, typ string
		var def any
		if columns.Scan(&cid, &name, &typ, &notnull, &def, &pk) == nil && name == "actual_cost_usd" {
			hasActual = true
		}
	}
	if err = columns.Err(); err != nil {
		columns.Close()
		return err
	}
	columns.Close()
	actualColumn := "NULL"
	if hasActual {
		actualColumn = "u.actual_cost_usd"
	}
	query := `SELECT u.session_id,u.model,u.billing_provider,u.billing_base_url,u.billing_mode,u.task,u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_write_tokens,u.reasoning_tokens,u.estimated_cost_usd,u.cost_status,` + actualColumn + ` FROM session_model_usage u`
	var args []any
	if source != "" {
		query += ` JOIN sessions s ON s.id=u.session_id WHERE s.source=?`
		args = append(args, source)
	}
	query += ` ORDER BY u.session_id,u.model,u.billing_provider,u.billing_base_url,u.billing_mode,u.task`
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return err
		}
		var session, model, provider, base, mode, task string
		var input, output, read, write, reasoning int64
		var cost sql.NullFloat64
		var actual sql.NullFloat64
		var status sql.NullString
		if err := rows.Scan(&session, &model, &provider, &base, &mode, &task, &input, &output, &read, &write, &reasoning, &cost, &status, &actual); err != nil {
			return err
		}
		identity, _ := json.Marshal([]string{path, session, model, provider, base, mode, task})
		hash := sha256.Sum256(identity)
		var fallback any
		if cost.Valid && status.Valid && (status.String == "estimated" || status.String == "actual" || status.String == "included") {
			fallback = cost.Float64
		}
		report := map[string]any{"id": "migration:" + hex.EncodeToString(hash[:]), "cumulative": true, "activity": "migration", "provider": provider, "model": model, "timestamp": float64(time.Now().Unix()), "reference": reference, "tokens": map[string]int64{"input_tokens": input, "output_tokens": output, "cache_read_tokens": read, "cache_write_tokens": write, "reasoning_tokens": reasoning}, "complete": true, "fallback_cost": fallback}
		if actual.Valid {
			report["provider_cost"] = actual.Float64
		}
		if source != "" {
			var encoded bytes.Buffer
			encoder := json.NewEncoder(&encoded)
			encoder.SetEscapeHTML(false)
			_ = encoder.Encode([]string{session, model, provider, base, mode, task})
			checkpoint := sha256.Sum256(bytes.TrimSuffix(encoded.Bytes(), []byte("\n")))
			report["source_checkpoint"] = hex.EncodeToString(checkpoint[:])
		}
		if err := publishUsageReport(report, dataRoot, owners...); err != nil {
			return err
		}
	}
	return rows.Err()
}

func publishUsageReport(report map[string]any, dataRoot string, owners ...int) error {
	encoded, err := json.Marshal(report)
	if err != nil {
		return err
	}
	id := sha256.Sum256(encoded)
	dir := filepath.Join(dataRoot, "usage", "reports")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if len(owners) == 2 && owners[0] > 0 {
		if err := os.Chown(dir, owners[0], owners[1]); err != nil {
			return err
		}
	}
	tmp, err := os.CreateTemp(dir, ".usage-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(encoded); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if len(owners) == 2 && owners[0] > 0 {
		if err := os.Chown(name, owners[0], owners[1]); err != nil {
			return err
		}
	}
	return os.Rename(name, filepath.Join(dir, hex.EncodeToString(id[:])+".json"))
}

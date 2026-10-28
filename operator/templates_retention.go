package operator

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"golang.org/x/sys/unix"
)

type TemplatesPruneResult struct {
	OK       bool     `json:"ok"`
	Action   string   `json:"action"`
	Removed  []string `json:"removed"`
	Retained int      `json:"retained"`
	Skipped  []string `json:"skipped_unidentified"`
}

// This is deliberately explicit, never automatic. Only the operator can confirm
// that all consumers (not just the selected UI container) released old mounts.
func PruneTemplatesCatalogSnapshots(ctx context.Context, config Config, keep int, confirmedUnmounted bool) (TemplatesPruneResult, error) {
	result := TemplatesPruneResult{Action: "templates-cache-prune"}
	if !confirmedUnmounted {
		return result, fmt.Errorf("recreate all containers using retired catalogs first, then pass --confirm-unmounted")
	}
	if keep < 2 {
		return result, fmt.Errorf("keep must be at least 2 retired snapshots")
	}
	if err := normalizeAndValidateFeatureConfig(&config); err != nil {
		return result, err
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	file, err := os.OpenFile(filepath.Join(config.MetaRoot, ".templates-sync.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return result, err
	}
	defer file.Close()
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return result, fmt.Errorf("templates catalog is in use: %w", err)
	}
	defer unix.Flock(int(file.Fd()), unix.LOCK_UN)
	if err := recoverCatalogActivation(config.MetaRoot); err != nil {
		return result, err
	}
	paths, err := filepath.Glob(filepath.Join(config.MetaRoot, ".templates-previous-*"))
	if err != nil {
		return result, err
	}
	type snapshot struct {
		path     string
		modified time.Time
	}
	var snapshots []snapshot
	for _, path := range paths {
		info, err := os.Lstat(path)
		if err != nil {
			return result, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			result.Skipped = append(result.Skipped, path)
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(path, catalogProvenanceFile))
		var provenance TemplatesCatalogProvenance
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || readErr != nil || json.Unmarshal(data, &provenance) != nil || provenance.Schema != 1 {
			result.Skipped = append(result.Skipped, path)
			continue
		}
		hash, err := templatesTreeHash(path)
		if err != nil || hash != provenance.ContentSHA256 {
			result.Skipped = append(result.Skipped, path)
			continue
		}
		snapshots = append(snapshots, snapshot{path, info.ModTime()})
	}
	sort.Slice(snapshots, func(i, j int) bool {
		if snapshots[i].modified.Equal(snapshots[j].modified) {
			return snapshots[i].path > snapshots[j].path
		}
		return snapshots[i].modified.After(snapshots[j].modified)
	})
	for i, snapshot := range snapshots {
		if i < keep {
			result.Retained++
			continue
		}
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if err := os.RemoveAll(snapshot.path); err != nil {
			return result, err
		}
		result.Removed = append(result.Removed, snapshot.path)
	}
	result.Retained += len(result.Skipped)
	result.OK = true
	return result, nil
}

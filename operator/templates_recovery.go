package operator

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const catalogActivationFile = ".templates-activation.json"
const catalogUIRefreshFile = ".templates-ui-refresh.json"

type catalogActivation struct {
	Schema   int    `json:"schema"`
	Stage    string `json:"stage"`
	Previous string `json:"previous,omitempty"`
	NewHash  string `json:"new_hash"`
	OldHash  string `json:"old_hash,omitempty"`
}

type catalogUIRefresh struct {
	Schema        int    `json:"schema"`
	Required      bool   `json:"required"`
	ContentSHA256 string `json:"content_sha256"`
	Previous      string `json:"previous_cache_dir,omitempty"`
}

func writeCatalogState(meta, name string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := AtomicWriteFile(filepath.Join(meta, name), append(data, '\n'), 0o600); err != nil {
		return err
	}
	return syncCatalogDirectory(meta)
}

func syncCatalogDirectory(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

func catalogDirectoryHash(path string) (string, bool, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", true, fmt.Errorf("catalog activation path must be a real directory: %s", path)
	}
	hash, err := templatesTreeHash(path)
	return hash, true, err
}

func finishCatalogActivation(meta string, journal catalogActivation) error {
	previous := ""
	if journal.Previous != "" {
		previous = filepath.Join(meta, journal.Previous)
	}
	if err := writeCatalogState(meta, catalogUIRefreshFile, catalogUIRefresh{Schema: 1, Required: previous != "", ContentSHA256: journal.NewHash, Previous: previous}); err != nil {
		return err
	}
	return clearCatalogActivation(meta)
}

func clearCatalogActivation(meta string) error {
	if err := os.Remove(filepath.Join(meta, catalogActivationFile)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncCatalogDirectory(meta)
}

// Must run with the exclusive catalog lock. Recovery never fetches from Git and
// never deletes unknown trees: only a journal-owned stage with the expected hash.
func recoverCatalogActivation(meta string) error {
	data, err := os.ReadFile(filepath.Join(meta, catalogActivationFile))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var journal catalogActivation
	if err := json.Unmarshal(data, &journal); err != nil || journal.Schema != 1 || len(journal.NewHash) != 64 {
		return fmt.Errorf("invalid catalog activation journal; retained directories were not changed")
	}
	if filepath.Base(journal.Stage) != journal.Stage || !strings.HasPrefix(journal.Stage, ".templates-stage-") {
		return fmt.Errorf("unsafe catalog activation stage path")
	}
	if journal.Previous != "" && (filepath.Base(journal.Previous) != journal.Previous || !strings.HasPrefix(journal.Previous, ".templates-previous-")) {
		return fmt.Errorf("unsafe catalog activation previous path")
	}
	cache, stage := filepath.Join(meta, "templates-cache"), filepath.Join(meta, journal.Stage)
	cacheHash, cacheExists, err := catalogDirectoryHash(cache)
	if err != nil {
		return err
	}
	stageHash, stageExists, err := catalogDirectoryHash(stage)
	if err != nil {
		return err
	}
	if stageExists && stageHash != journal.NewHash {
		return fmt.Errorf("catalog activation stage changed; leaving all directories intact")
	}
	if cacheExists {
		if cacheHash == journal.NewHash && !stageExists {
			return finishCatalogActivation(meta, journal)
		}
		if cacheHash != journal.OldHash || journal.Previous == "" {
			return fmt.Errorf("ambiguous catalog activation; leaving all directories intact")
		}
		if _, exists, err := catalogDirectoryHash(filepath.Join(meta, journal.Previous)); err != nil || exists {
			return fmt.Errorf("ambiguous previous catalog directory; leaving all directories intact")
		}
		if stageExists {
			if err := os.RemoveAll(stage); err != nil {
				return err
			}
		}
		return clearCatalogActivation(meta)
	}
	if journal.Previous != "" {
		previous := filepath.Join(meta, journal.Previous)
		hash, exists, err := catalogDirectoryHash(previous)
		if err != nil {
			return err
		}
		if !exists || hash != journal.OldHash {
			return fmt.Errorf("previous catalog is missing or changed; leaving activation journal intact")
		}
		if err := os.Rename(previous, cache); err != nil {
			return err
		}
		if stageExists {
			if err := os.RemoveAll(stage); err != nil {
				return err
			}
		}
		return clearCatalogActivation(meta)
	}
	if !stageExists {
		return fmt.Errorf("initial catalog activation stage is missing")
	}
	if err := os.Rename(stage, cache); err != nil {
		return err
	}
	return finishCatalogActivation(meta, journal)
}

func recoverTemplatesCatalog(config Config) error {
	if config.MetaRoot == "" {
		return nil
	}
	if _, err := os.Lstat(filepath.Join(config.MetaRoot, catalogActivationFile)); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(config.MetaRoot, ".templates-sync.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fmt.Errorf("catalog activation is in progress; retry: %w", err)
	}
	defer unix.Flock(int(file.Fd()), unix.LOCK_UN)
	return recoverCatalogActivation(config.MetaRoot)
}

func activateTemplatesCatalog(config Config, stage string, info *TemplatesCatalogProvenance) (string, error) {
	meta, cache := config.MetaRoot, filepath.Join(config.MetaRoot, "templates-cache")
	oldHash, exists, err := catalogDirectoryHash(cache)
	if err != nil {
		return "", err
	}
	journal := catalogActivation{Schema: 1, Stage: filepath.Base(stage), NewHash: info.ContentSHA256, OldHash: oldHash}
	if exists {
		previous, err := os.MkdirTemp(meta, ".templates-previous-*")
		if err != nil {
			return "", err
		}
		if err := os.Remove(previous); err != nil {
			return "", err
		}
		journal.Previous = filepath.Base(previous)
	}
	if err := writeCatalogState(meta, catalogActivationFile, journal); err != nil {
		return "", err
	}
	if exists {
		if err := os.Rename(cache, filepath.Join(meta, journal.Previous)); err != nil {
			return "", err
		}
		if err := syncCatalogDirectory(meta); err != nil {
			return "", err
		}
	}
	if err := os.Rename(stage, cache); err != nil {
		if recoveryErr := recoverCatalogActivation(meta); recoveryErr != nil {
			return "", fmt.Errorf("activate catalog: %v; recovery: %w", err, recoveryErr)
		}
		return "", err
	}
	if err := syncCatalogDirectory(meta); err != nil {
		return "", err
	}
	if err := finishCatalogActivation(meta, journal); err != nil {
		return "", err
	}
	if journal.Previous == "" {
		return "", nil
	}
	return filepath.Join(meta, journal.Previous), nil
}

// Pending refresh is cleared only after the running UI reports the active
// catalog generation. A failed/unavailable Docker probe never means "current".
func templatesUIRefreshStatus(ctx context.Context, config Config) (catalogUIRefresh, error) {
	var state catalogUIRefresh
	data, err := os.ReadFile(filepath.Join(config.MetaRoot, catalogUIRefreshFile))
	if os.IsNotExist(err) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(data, &state); err != nil || state.Schema != 1 {
		return state, fmt.Errorf("invalid pending catalog UI refresh state")
	}
	if state.Required && config.WorkspaceUIHost != "" {
		probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		result, err := NewCompose(config, nil).Run(probeCtx, "exec", "-T", "workspace-ui", "cat", "/templates-cache/"+catalogProvenanceFile)
		var mounted TemplatesCatalogProvenance
		if err == nil && json.Unmarshal(result.Stdout, &mounted) == nil && mounted.Schema == 1 && mounted.ContentSHA256 == state.ContentSHA256 {
			state.Required = false
			if err := writeCatalogState(config.MetaRoot, catalogUIRefreshFile, state); err != nil {
				return state, err
			}
		}
	}
	return state, nil
}

package propgit

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"openlia/operator/migration"
)

// ProposalRepo manages the isolated Git repository where migration proposals accumulate.
type ProposalRepo struct {
	RepoDir string
}

// OpenOrCreateRepo initializes a Git repository under repoDir if not already present.
func OpenOrCreateRepo(repoDir string) (*ProposalRepo, error) {
	if err := os.MkdirAll(repoDir, 0o700); err != nil {
		return nil, fmt.Errorf("create repo dir: %w", err)
	}

	r := &ProposalRepo{RepoDir: repoDir}
	gitDir := filepath.Join(repoDir, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		if out, err := r.runGit("init"); err != nil {
			return nil, fmt.Errorf("git init failed: %s: %w", string(out), err)
		}
		// Configure dummy user for local migration repo
		_, _ = r.runGit("config", "user.name", "OpenLia Migration")
		_, _ = r.runGit("config", "user.email", "migration@openlia.local")
	}

	return r, nil
}

func (r *ProposalRepo) runGit(args ...string) ([]byte, error) {
	fullArgs := append([]string{"-c", "safe.directory=*"}, args...)
	cmd := exec.Command("git", fullArgs...)
	cmd.Dir = r.RepoDir
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
	)
	return cmd.CombinedOutput()
}

// CaptureBaseline copies the live workspace (excluding .git, secrets) and creates initial baseline commit.
func (r *ProposalRepo) CaptureBaseline(liveWorkspaceRoot string) (string, error) {
	absLive, err := filepath.Abs(liveWorkspaceRoot)
	if err != nil {
		return "", err
	}

	// Copy files from live workspace to proposal repo
	err = filepath.Walk(absLive, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(absLive, path)
		if err != nil || rel == "." {
			return nil
		}
		slashRel := filepath.ToSlash(rel)

		// Exclude live .git directory and known secret files
		if info.IsDir() {
			if slashRel == ".git" || strings.HasPrefix(slashRel, ".git/") {
				return filepath.SkipDir
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			// Skip symlinks, sockets, pipes, devices
			return nil
		}
		if slashRel == "sources/document-passwords.toml" {
			return nil
		}

		destPath := filepath.Join(r.RepoDir, rel)
		if err := os.MkdirAll(filepath.Dir(destPath), 0o700); err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(destPath, data, 0o600)
	})

	if err != nil {
		return "", fmt.Errorf("copy live workspace to baseline: %w", err)
	}

	if out, err := r.runGit("add", "-A"); err != nil {
		return "", fmt.Errorf("git add baseline: %s: %w", string(out), err)
	}

	// Commit initial baseline
	commitMsg := "baseline: initial snapshot from live workspace"
	out, err := r.runGit("commit", "--allow-empty", "-m", commitMsg)
	if err != nil {
		return "", fmt.Errorf("git commit baseline: %s: %w", string(out), err)
	}

	commitHash, err := r.GetHeadCommit()
	if err != nil {
		return "", err
	}
	return commitHash, nil
}

// CheckpointJob stages changes and commits for a completed job.
func (r *ProposalRepo) CheckpointJob(jobID string, sourcePath string) (string, error) {
	if out, err := r.runGit("add", "-A"); err != nil {
		return "", fmt.Errorf("git add job changes: %s: %w", string(out), err)
	}

	statusOut, _ := r.runGit("status", "--porcelain")
	if len(strings.TrimSpace(string(statusOut))) == 0 {
		// No changes produced
		return r.GetHeadCommit()
	}

	commitMsg := fmt.Sprintf("job(%s): import %s", jobID, sourcePath)
	out, err := r.runGit("commit", "-m", commitMsg)
	if err != nil {
		return "", fmt.Errorf("git commit job: %s: %w", string(out), err)
	}

	return r.GetHeadCommit()
}

// GetHeadCommit returns current HEAD commit hash.
func (r *ProposalRepo) GetHeadCommit() (string, error) {
	out, err := r.runGit("rev-parse", "HEAD")
	if err != nil {
		return "", fmt.Errorf("git rev-parse HEAD: %s: %w", string(out), err)
	}
	return strings.TrimSpace(string(out)), nil
}

// GetTreeHash returns the Git tree hash of a given commit.
func (r *ProposalRepo) GetTreeHash(commit string) (string, error) {
	out, err := r.runGit("rev-parse", commit+"^{tree}")
	if err != nil {
		return "", fmt.Errorf("git rev-parse tree: %s: %w", string(out), err)
	}
	return strings.TrimSpace(string(out)), nil
}

// ReadFileAtCommit extracts a file's content directly from an immutable Git commit object.
func (r *ProposalRepo) ReadFileAtCommit(commitHash, relPath string) ([]byte, error) {
	out, rerr := r.runGit("cat-file", "blob", fmt.Sprintf("%s:%s", commitHash, relPath))
	if rerr != nil {
		return nil, fmt.Errorf("read blob %s:%s: %s: %w", commitHash, relPath, string(out), rerr)
	}
	return out, nil
}

// Diff returns the unified Git diff between fromCommit and toCommit.
func (r *ProposalRepo) Diff(fromCommit, toCommit string) (string, error) {
	out, err := r.runGit("diff", "--no-renames", fromCommit, toCommit)
	if err != nil {
		return "", fmt.Errorf("git diff %s %s: %s: %w", fromCommit, toCommit, string(out), err)
	}
	return string(out), nil
}

// ComputePatchHash computes the SHA-256 digest of a diff string.
func ComputePatchHash(diff string) string {
	h := sha256.Sum256([]byte(diff))
	return hex.EncodeToString(h[:])
}

// GetChangedFiles inspects changed files between two commits using null-separated diff-tree.
// It populates full OldHash (SHA-256 of pre-image) and NewHash (SHA-256 of post-image).
// --no-renames is passed to guarantee deterministic decomposition into deleted + added files.
func (r *ProposalRepo) GetChangedFiles(fromCommit, toCommit string) ([]migration.ChangedFileEntry, error) {
	// Use git diff-tree -r -z --no-commit-id --no-renames
	out, err := r.runGit("diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", fromCommit, toCommit)
	if err != nil {
		return nil, fmt.Errorf("git diff-tree: %s: %w", string(out), err)
	}

	var list []migration.ChangedFileEntry
	records := bytes.Split(out, []byte{0})
	for i := 0; i < len(records); {
		meta := string(records[i])
		if strings.TrimSpace(meta) == "" {
			i++
			continue
		}
		// meta format: :<srcMode> <dstMode> <srcSha> <dstSha> <status>
		parts := strings.Fields(meta)
		if len(parts) < 5 {
			i++
			continue
		}
		statusCode := parts[4]
		i++
		if i >= len(records) {
			break
		}
		filePath := string(records[i])
		i++

		status := "modified"
		if strings.HasPrefix(statusCode, "A") {
			status = "added"
		} else if strings.HasPrefix(statusCode, "D") {
			status = "deleted"
		} else if strings.HasPrefix(statusCode, "R") {
			status = "renamed"
			// renamed includes second path
			if i < len(records) {
				filePath = string(records[i])
				i++
			}
		}

		entry := migration.ChangedFileEntry{
			Path:   filePath,
			Status: status,
		}

		// Compute SHA-256 hashes of pre-image (fromCommit) and post-image (toCommit)
		if status != "added" && fromCommit != "" {
			if oldData, err := r.ReadFileAtCommit(fromCommit, filePath); err == nil {
				h := sha256.Sum256(oldData)
				entry.OldHash = hex.EncodeToString(h[:])
			}
		}
		if status != "deleted" && toCommit != "" {
			if newData, err := r.ReadFileAtCommit(toCommit, filePath); err == nil {
				h := sha256.Sum256(newData)
				entry.NewHash = hex.EncodeToString(h[:])
			}
		}

		list = append(list, entry)
	}
	return list, nil
}

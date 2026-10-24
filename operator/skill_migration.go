package operator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const migrationProtocolSchema = 1

type SkillForkResult struct {
	OK        bool   `json:"ok"`
	Action    string `json:"action"`
	Skill     string `json:"skill"`
	Ownership string `json:"ownership"`
	PatchHash string `json:"patch_hash"`
	ForkHash  string `json:"fork_hash"`
	Backup    string `json:"backup,omitempty"`
}

type SkillMigrationContext struct {
	Schema           int    `json:"schema"`
	Skill            string `json:"skill"`
	OldBaseHash      string `json:"old_base_hash"`
	CurrentForkHash  string `json:"current_fork_hash"`
	CurrentPatchHash string `json:"current_patch_hash"`
	NewBaseHash      string `json:"new_base_hash"`
	NewVersion       string `json:"new_version"`
	NewSource        string `json:"new_source"`
	CreatedAt        string `json:"created_at"`
}

type SkillMigrationContextResult struct {
	OK      bool                  `json:"ok"`
	Action  string                `json:"action"`
	Skill   string                `json:"skill"`
	Context string                `json:"context"`
	Details SkillMigrationContext `json:"details"`
}

type SkillMigrationProposal struct {
	Schema           int      `json:"schema"`
	ID               string   `json:"id"`
	Skill            string   `json:"skill"`
	State            string   `json:"state"`
	OldBaseHash      string   `json:"old_base_hash"`
	CurrentForkHash  string   `json:"current_fork_hash"`
	OldPatchHash     string   `json:"old_patch_hash"`
	NewBaseHash      string   `json:"new_base_hash"`
	NewPatchHash     string   `json:"new_patch_hash"`
	ProposedForkHash string   `json:"proposed_fork_hash"`
	Conflicts        []string `json:"conflicts"`
	CreatedAt        string   `json:"created_at"`
	AppliedAt        string   `json:"applied_at,omitempty"`
	RejectedAt       string   `json:"rejected_at,omitempty"`
}

type SkillMigrationResult struct {
	OK        bool   `json:"ok"`
	Action    string `json:"action"`
	Proposal  string `json:"proposal"`
	Skill     string `json:"skill"`
	State     string `json:"state"`
	Backup    string `json:"backup,omitempty"`
	ForkHash  string `json:"fork_hash,omitempty"`
	PatchHash string `json:"patch_hash,omitempty"`
}

func ReadSkillMigrationProposal(config Config, proposalID string) (SkillMigrationProposal, error) {
	if err := config.ValidatePaths(); err != nil {
		return SkillMigrationProposal{}, err
	}
	if err := ValidateSafeComponent(proposalID, "proposal"); err != nil {
		return SkillMigrationProposal{}, err
	}
	path := filepath.Join(config.DataRoot, ".openlia", "proposals", proposalID, "proposal.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return SkillMigrationProposal{}, err
	}
	var proposal SkillMigrationProposal
	if err := json.Unmarshal(data, &proposal); err != nil {
		return SkillMigrationProposal{}, err
	}
	if proposal.Schema != migrationProtocolSchema || proposal.ID != proposalID {
		return SkillMigrationProposal{}, fmt.Errorf("invalid migration proposal")
	}
	return proposal, nil
}

func ForkSkill(config Config, name string, now time.Time) (SkillForkResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return SkillForkResult{}, err
	}
	if err := ValidateSafeComponent(name, "skill"); err != nil {
		return SkillForkResult{}, err
	}
	if isProtectedSystemSkill(name) {
		return SkillForkResult{}, fmt.Errorf("protected system skill cannot be forked")
	}
	metadataPath := filepath.Join(config.MetaRoot, "managed", "skills", name+".json")
	metadata, err := readFullSkillMetadata(metadataPath, name)
	if err != nil {
		return SkillForkResult{}, err
	}
	if metadata.Ownership == "forked" {
		return SkillForkResult{}, fmt.Errorf("skill is already forked: %s", name)
	}
	source := filepath.Join(config.RepositoryRoot, "profile", "skills", name)
	destination := filepath.Join(config.DataRoot, "skills", name)
	basePath := filepath.Join(config.MetaRoot, filepath.FromSlash(metadata.BaseSnapshot))
	if _, err := os.Stat(source); err != nil {
		return SkillForkResult{}, fmt.Errorf("skill is not bundled: %s", name)
	}
	baseHash, err := DirectorySHA256(basePath)
	if err != nil || "sha256:"+baseHash != metadata.ContentSHA256 {
		return SkillForkResult{}, fmt.Errorf("skill base snapshot is missing or invalid")
	}
	if info, err := os.Lstat(destination); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return SkillForkResult{}, fmt.Errorf("installed skill is missing or unsafe: %s", name)
	}
	currentHash, err := DirectorySHA256(destination)
	if err != nil {
		return SkillForkResult{}, err
	}
	resume, err := pauseHermesForSkillMutation(config)
	if err != nil {
		return SkillForkResult{}, err
	}
	defer resume()
	patch, err := GenerateSkillPatch(basePath, destination, name)
	if err != nil {
		return SkillForkResult{}, err
	}
	patchPath := filepath.Join(config.MetaRoot, filepath.FromSlash(metadata.PatchPath))
	backup, err := CreateRollback(config, "skill-fork", now, runtimeRelativePath(config, destination), runtimeRelativePath(config, metadataPath), runtimeRelativePath(config, basePath), runtimeRelativePath(config, patchPath))
	if err != nil {
		return SkillForkResult{}, err
	}
	patchHash, err := WriteSkillPatch(patchPath, patch)
	if err != nil {
		return SkillForkResult{}, err
	}
	metadata.Ownership = "forked"
	metadata.ForkSHA256 = "sha256:" + currentHash
	metadata.PatchSHA256 = patchHash
	metadata.ForkedAt = utcTimestamp(now)
	metadata.UpdatedAt = utcTimestamp(now)
	if err := writeSkillMetadata(metadataPath, metadata); err != nil {
		return SkillForkResult{}, err
	}
	if err := RecordChange(config, "skill-fork", "ok", backup.Archive, "skill="+name, now); err != nil {
		return SkillForkResult{}, err
	}
	return SkillForkResult{OK: true, Action: "fork", Skill: name, Ownership: metadata.Ownership, PatchHash: patchHash, ForkHash: metadata.ForkSHA256, Backup: backup.Archive}, nil
}

func PrepareSkillMigration(config Config, name string, now time.Time) (SkillMigrationContextResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return SkillMigrationContextResult{}, err
	}
	if err := ValidateSafeComponent(name, "skill"); err != nil {
		return SkillMigrationContextResult{}, err
	}
	metadataPath := filepath.Join(config.MetaRoot, "managed", "skills", name+".json")
	metadata, err := readFullSkillMetadata(metadataPath, name)
	if err != nil {
		return SkillMigrationContextResult{}, err
	}
	if metadata.Ownership != "forked" {
		return SkillMigrationContextResult{}, fmt.Errorf("skill is not forked: %s", name)
	}
	basePath := filepath.Join(config.MetaRoot, filepath.FromSlash(metadata.BaseSnapshot))
	destination := filepath.Join(config.DataRoot, "skills", name)
	newBase := filepath.Join(config.RepositoryRoot, "profile", "skills", name)
	if _, err := os.Stat(newBase); err != nil {
		return SkillMigrationContextResult{}, fmt.Errorf("skill is no longer bundled: %s", name)
	}
	currentForkHash, err := DirectorySHA256(destination)
	if err != nil {
		return SkillMigrationContextResult{}, err
	}
	oldBaseHash, err := DirectorySHA256(basePath)
	if err != nil {
		return SkillMigrationContextResult{}, err
	}
	newBaseHash, err := DirectorySHA256(newBase)
	if err != nil {
		return SkillMigrationContextResult{}, err
	}
	patch, err := GenerateSkillPatch(basePath, destination, name)
	if err != nil {
		return SkillMigrationContextResult{}, err
	}
	patchHash, err := SkillPatchHash(patch)
	if err != nil {
		return SkillMigrationContextResult{}, err
	}
	contextRoot := filepath.Join(config.DataRoot, ".openlia", "migrations", name)
	if err := removeSafeDirectory(contextRoot); err != nil {
		return SkillMigrationContextResult{}, err
	}
	if err := EnsureDir(filepath.Dir(contextRoot), 0o700); err != nil {
		return SkillMigrationContextResult{}, err
	}
	if err := ensureRuntimeOwner(filepath.Join(config.DataRoot, ".openlia"), config.RuntimeUID, config.RuntimeGID, 0o700); err != nil {
		return SkillMigrationContextResult{}, err
	}
	if err := ensureRuntimeOwner(filepath.Dir(contextRoot), config.RuntimeUID, config.RuntimeGID, 0o700); err != nil {
		return SkillMigrationContextResult{}, err
	}
	if err := CopyDir(basePath, filepath.Join(contextRoot, "old-base")); err != nil {
		return SkillMigrationContextResult{}, err
	}
	if err := CopyDir(destination, filepath.Join(contextRoot, "current-fork")); err != nil {
		return SkillMigrationContextResult{}, err
	}
	if err := CopyDir(newBase, filepath.Join(contextRoot, "new-base")); err != nil {
		return SkillMigrationContextResult{}, err
	}
	if _, err := WriteSkillPatch(filepath.Join(contextRoot, "customization.patch"), patch); err != nil {
		return SkillMigrationContextResult{}, err
	}
	version, source := (&ProfileOperator{Config: config}).distributionInfo()
	details := SkillMigrationContext{Schema: migrationProtocolSchema, Skill: name, OldBaseHash: "sha256:" + oldBaseHash, CurrentForkHash: "sha256:" + currentForkHash, CurrentPatchHash: patchHash, NewBaseHash: "sha256:" + newBaseHash, NewVersion: version, NewSource: source, CreatedAt: utcTimestamp(now)}
	data, err := json.Marshal(details)
	if err != nil {
		return SkillMigrationContextResult{}, err
	}
	if err := AtomicWriteFile(filepath.Join(contextRoot, "context.json"), append(data, '\n'), 0o600); err != nil {
		return SkillMigrationContextResult{}, err
	}
	return SkillMigrationContextResult{OK: true, Action: "migration-prepare", Skill: name, Context: contextRoot, Details: details}, nil
}

func ApplySkillMigration(config Config, proposalID string, now time.Time) (SkillMigrationResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return SkillMigrationResult{}, err
	}
	if err := ValidateSafeComponent(proposalID, "proposal"); err != nil {
		return SkillMigrationResult{}, err
	}
	proposalRoot := filepath.Join(config.DataRoot, ".openlia", "proposals", proposalID)
	proposalPath := filepath.Join(proposalRoot, "proposal.json")
	proposalData, err := os.ReadFile(proposalPath)
	if err != nil {
		return SkillMigrationResult{}, fmt.Errorf("read migration proposal: %w", err)
	}
	var proposal SkillMigrationProposal
	if err := json.Unmarshal(proposalData, &proposal); err != nil {
		return SkillMigrationResult{}, fmt.Errorf("parse migration proposal: %w", err)
	}
	if proposal.Schema != migrationProtocolSchema || proposal.ID != proposalID || proposal.State != "pending" {
		return SkillMigrationResult{}, fmt.Errorf("migration proposal is not pending")
	}
	if len(proposal.Conflicts) != 0 {
		return SkillMigrationResult{}, fmt.Errorf("migration proposal still has unresolved conflicts")
	}
	if err := ValidateSafeComponent(proposal.Skill, "skill"); err != nil {
		return SkillMigrationResult{}, err
	}
	resume, err := pauseHermesForSkillMutation(config)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	defer resume()
	metadataPath := filepath.Join(config.MetaRoot, "managed", "skills", proposal.Skill+".json")
	metadata, err := readFullSkillMetadata(metadataPath, proposal.Skill)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	if metadata.Ownership != "forked" {
		return SkillMigrationResult{}, fmt.Errorf("skill is not forked: %s", proposal.Skill)
	}
	if proposal.OldBaseHash != metadata.ContentSHA256 {
		return markProposalStale(proposalPath, proposal, now, "fork base changed")
	}
	destination := filepath.Join(config.DataRoot, "skills", proposal.Skill)
	currentHash, err := DirectorySHA256(destination)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	if "sha256:"+currentHash != proposal.CurrentForkHash {
		return markProposalStale(proposalPath, proposal, now, "current fork changed")
	}
	source := filepath.Join(config.RepositoryRoot, "profile", "skills", proposal.Skill)
	newBaseHash, err := DirectorySHA256(source)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	if "sha256:"+newBaseHash != proposal.NewBaseHash {
		return markProposalStale(proposalPath, proposal, now, "upstream base changed")
	}
	patchPath := filepath.Join(proposalRoot, "customization.patch")
	patch, err := ReadSkillPatch(patchPath)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	if patch.Skill != proposal.Skill || patch.BaseHash != proposal.NewBaseHash {
		return SkillMigrationResult{}, fmt.Errorf("migration proposal patch does not match the proposal")
	}
	patchHash, err := SkillPatchHash(patch)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	if patchHash != proposal.NewPatchHash {
		return SkillMigrationResult{}, fmt.Errorf("migration proposal patch hash mismatch")
	}
	proposedTree := filepath.Join(proposalRoot, ".validated-skill")
	if err := removeSafeDirectory(proposedTree); err != nil {
		return SkillMigrationResult{}, err
	}
	if err := ApplySkillPatch(source, proposedTree, patch); err != nil {
		return SkillMigrationResult{}, fmt.Errorf("validate migration patch: %w", err)
	}
	proposedHash, err := DirectorySHA256(proposedTree)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	if "sha256:"+proposedHash != proposal.ProposedForkHash {
		return SkillMigrationResult{}, fmt.Errorf("migration proposal fork hash mismatch")
	}
	oldBase := filepath.Join(config.MetaRoot, filepath.FromSlash(metadata.BaseSnapshot))
	oldPatch := filepath.Join(config.MetaRoot, filepath.FromSlash(metadata.PatchPath))
	backup, err := CreateRollback(config, "skill-migration", now, runtimeRelativePath(config, destination), runtimeRelativePath(config, metadataPath), runtimeRelativePath(config, oldBase), runtimeRelativePath(config, oldPatch))
	if err != nil {
		return SkillMigrationResult{}, err
	}
	oldMetadata, err := os.ReadFile(metadataPath)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	oldPatchData, err := os.ReadFile(oldPatch)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	txRoot, err := os.MkdirTemp(filepath.Join(config.MetaRoot, "managed"), ".migration-tx-")
	if err != nil {
		return SkillMigrationResult{}, err
	}
	defer os.RemoveAll(txRoot)
	oldFork := filepath.Join(txRoot, "old-fork")
	oldBaseCopy := filepath.Join(txRoot, "old-base")
	if err := CopyDir(destination, oldFork); err != nil {
		return SkillMigrationResult{}, err
	}
	if err := CopyDir(oldBase, oldBaseCopy); err != nil {
		return SkillMigrationResult{}, err
	}
	if err := replaceDirectory(proposedTree, destination); err != nil {
		return rollbackSkillMigration(destination, oldFork, oldBase, oldBaseCopy, oldPatch, oldPatchData, metadataPath, oldMetadata, proposalPath, proposalData, err)
	}
	if err := replaceDirectory(source, oldBase); err != nil {
		return rollbackSkillMigration(destination, oldFork, oldBase, oldBaseCopy, oldPatch, oldPatchData, metadataPath, oldMetadata, proposalPath, proposalData, err)
	}
	if err := AtomicWriteFile(oldPatch, mustPatchBytes(patch), 0o600); err != nil {
		return rollbackSkillMigration(destination, oldFork, oldBase, oldBaseCopy, oldPatch, oldPatchData, metadataPath, oldMetadata, proposalPath, proposalData, err)
	}
	metadata.ContentSHA256 = proposal.NewBaseHash
	metadata.DistributionVersion, metadata.SourceID = (&ProfileOperator{Config: config}).distributionInfo()
	metadata.PatchSHA256 = patchHash
	metadata.ForkSHA256 = proposal.ProposedForkHash
	metadata.UpdatedAt = utcTimestamp(now)
	metadataData, err := json.Marshal(metadata)
	if err != nil {
		return rollbackSkillMigration(destination, oldFork, oldBase, oldBaseCopy, oldPatch, oldPatchData, metadataPath, oldMetadata, proposalPath, proposalData, err)
	}
	if err := AtomicWriteFile(metadataPath, append(metadataData, '\n'), 0o600); err != nil {
		return rollbackSkillMigration(destination, oldFork, oldBase, oldBaseCopy, oldPatch, oldPatchData, metadataPath, oldMetadata, proposalPath, proposalData, err)
	}
	proposal.State = "applied"
	proposal.AppliedAt = utcTimestamp(now)
	updatedProposal, err := json.Marshal(proposal)
	if err != nil {
		return rollbackSkillMigration(destination, oldFork, oldBase, oldBaseCopy, oldPatch, oldPatchData, metadataPath, oldMetadata, proposalPath, proposalData, err)
	}
	if err := AtomicWriteFile(proposalPath, append(updatedProposal, '\n'), 0o600); err != nil {
		return rollbackSkillMigration(destination, oldFork, oldBase, oldBaseCopy, oldPatch, oldPatchData, metadataPath, oldMetadata, proposalPath, proposalData, err)
	}
	if err := RecordChange(config, "skill-migration", "ok", backup.Archive, "skill="+proposal.Skill+" proposal="+proposalID, now); err != nil {
		return rollbackSkillMigration(destination, oldFork, oldBase, oldBaseCopy, oldPatch, oldPatchData, metadataPath, oldMetadata, proposalPath, proposalData, err)
	}
	return SkillMigrationResult{OK: true, Action: "skill-migration", Proposal: proposalID, Skill: proposal.Skill, State: proposal.State, Backup: backup.Archive, ForkHash: proposal.ProposedForkHash, PatchHash: patchHash}, nil
}

func pauseHermesForSkillMutation(config Config) (func(), error) {
	compose := NewCompose(config, nil)
	ctx := context.Background()
	if !compose.ServiceRunning(ctx, "hermes") {
		return func() {}, nil
	}
	if _, err := compose.Run(ctx, "stop", "hermes"); err != nil {
		return nil, fmt.Errorf("stop Hermes for skill mutation: %w", err)
	}
	if err := WriteState(config, stateStopped); err != nil {
		_, _ = compose.Run(ctx, "up", "-d", "--no-deps", "hermes")
		return nil, err
	}
	return func() {
		if _, err := compose.Run(ctx, "up", "-d", "--no-deps", "hermes"); err == nil {
			_ = WriteState(config, stateRunning)
		}
	}, nil
}

func RejectSkillMigration(config Config, proposalID string, now time.Time) (SkillMigrationResult, error) {
	if err := config.ValidatePaths(); err != nil {
		return SkillMigrationResult{}, err
	}
	if err := ValidateSafeComponent(proposalID, "proposal"); err != nil {
		return SkillMigrationResult{}, err
	}
	path := filepath.Join(config.DataRoot, ".openlia", "proposals", proposalID, "proposal.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	var proposal SkillMigrationProposal
	if err := json.Unmarshal(data, &proposal); err != nil {
		return SkillMigrationResult{}, err
	}
	if proposal.Schema != migrationProtocolSchema || proposal.ID != proposalID || proposal.State != "pending" {
		return SkillMigrationResult{}, fmt.Errorf("migration proposal is not pending")
	}
	proposal.State = "rejected"
	proposal.RejectedAt = utcTimestamp(now)
	updated, err := json.Marshal(proposal)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	if err := AtomicWriteFile(path, append(updated, '\n'), 0o600); err != nil {
		return SkillMigrationResult{}, err
	}
	return SkillMigrationResult{OK: true, Action: "skill-migration-reject", Proposal: proposalID, Skill: proposal.Skill, State: proposal.State}, nil
}

func readFullSkillMetadata(path, expectedSkill string) (SkillMetadata, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return SkillMetadata{}, err
	}
	var metadata SkillMetadata
	if err := json.Unmarshal(data, &metadata); err != nil || !validSkillMetadata(metadata, expectedSkill) {
		return SkillMetadata{}, fmt.Errorf("invalid skill provenance for %s", expectedSkill)
	}
	return metadata, nil
}

func removeSafeDirectory(path string) error {
	if path == "" || filepath.Clean(path) == string(filepath.Separator) {
		return fmt.Errorf("refusing to remove unsafe directory")
	}
	if info, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	} else if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to remove symlink directory")
	}
	return os.RemoveAll(path)
}

func mustPatchBytes(patch SkillPatch) []byte {
	data, _ := json.Marshal(patch)
	return append(data, '\n')
}

func markProposalStale(path string, proposal SkillMigrationProposal, now time.Time, reason string) (SkillMigrationResult, error) {
	proposal.State = "stale"
	proposal.RejectedAt = utcTimestamp(now)
	data, err := json.Marshal(proposal)
	if err != nil {
		return SkillMigrationResult{}, err
	}
	if err := AtomicWriteFile(path, append(data, '\n'), 0o600); err != nil {
		return SkillMigrationResult{}, err
	}
	return SkillMigrationResult{}, fmt.Errorf("migration proposal is stale: %s", reason)
}

func rollbackSkillMigration(destination, oldFork, base, oldBase, patch string, oldPatch []byte, metadataPath string, oldMetadata []byte, proposalPath string, oldProposal []byte, cause error) (SkillMigrationResult, error) {
	_ = replaceDirectory(oldFork, destination)
	_ = replaceDirectory(oldBase, base)
	_ = AtomicWriteFile(patch, oldPatch, 0o600)
	_ = AtomicWriteFile(metadataPath, oldMetadata, 0o600)
	_ = AtomicWriteFile(proposalPath, oldProposal, 0o600)
	return SkillMigrationResult{}, cause
}

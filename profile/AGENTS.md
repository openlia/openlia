# OpenLia Agent Instructions

This deployment runs Hermes Agent with persistent state under `/opt/data` and user workspace files under `/opt/data/workspace`.

## Safe defaults

- Read and analyze relevant files before proposing or making changes.
- Keep workspace file writes under `/opt/data/workspace` unless the user explicitly asks otherwise.
- Preserve existing user files and prefer targeted, reviewable edits over whole-file replacements.
- Treat Hermes-managed `memories/USER.md` and `memories/MEMORY.md` as compact entry lists managed via Hermes's native memory tools.
- Never place raw API keys, passwords, or private keys into workspace documents or prompts; credentials belong in the runtime environment or secret store.
- Require explicit user confirmation before sending external messages, modifying external accounts, making purchases, or deleting user data.

---
name: workspace-git
description: Record consolidated daily workspace changes in local Git history with structured commits.
version: 0.3.0
platforms: [linux]
required_environment_variables: []
required_credential_files: []
metadata:
  hermes:
    tags: [personal-os, history, git]
    category: productivity
---

# Workspace Git History

The OpenLia workspace is `/opt/data/workspace`. It is maintained as a local
Git repository for history tracking. OpenLia does not configure Git remotes or
synchronize workspace history over the network.

## Operating Model

- **Scheduled Daily Run**: This skill runs automatically once a day (default every
  night at 04:00, configured in `config.toml` under `[workspace_git]`).
- **On-Demand**: It can also be invoked manually on demand (`/workspace-git`).
- **No Change, No Commit**: If `git status` reports no uncommitted working tree
  changes, no commit is created.
- **Multiple Appropriate Commits**: When changes exist, files are grouped logically
  by workspace domain or topic and committed in separate, structured commits rather
  than a single monolithic commit.
- **Conversational Decoupling**: Daytime interactive tasks and routine skills
  (such as `inbox-triage` and `workspace-organize`) do not perform immediate Git commits;
  all changes are consolidated into this skill's scheduled run.

## Safety Rules

- Never put tokens, credentials, OAuth files, private keys, or raw secret
  exports in the workspace.
- `sources/document-passwords.toml` is an intentional plaintext exception for
  user-provided document-unlock passwords. Never print its contents or include
  password values in commit messages or reports.
- Never stage or commit `.env`, `auth.json`, `sessions/`, `logs/`, or `cache/`.
- Never use `git reset --hard`, `git clean`, or destructive conflict handling.
- Do not add a Git remote or use Git network operations; use OpenLia backups
  for durable encrypted recovery.

## History Recording Procedure

1. **Check Status**:
   ```bash
   cd /opt/data/workspace
   git status --short --branch
   ```

2. **Evaluate Changes**:
   - If the output shows no modifications or untracked files, report:
     `"Workspace Git working tree is clean. No commits required."`
     and exit immediately without creating empty commits.

3. **Plan Commit Batches**:
   Use the bundled deterministic helper to group changed files into domains:
   ```bash
   git status --porcelain | awk '{print $2}' | python /opt/data/skills/workspace-git/scripts/check_workspace_git.py --plan
   ```
   Or group files logically by directory:
   - `tasks/` -> `docs(tasks): update task records`
   - `goals/` -> `docs(goals): update goal records`
   - `inbox/` -> `docs(inbox): file intake records`
    - `knowledge/` -> `feat(knowledge): update research and claims`
    - `sources/` -> `docs(sources): update retained source artifacts`
   - `reports/` -> `docs(reports): archive generated reports`
   - `decisions/` -> `docs(decisions): record decision log`
   - `areas/` -> `docs(areas): update area standards`
   - Root configuration -> `chore(workspace): update workspace files`

4. **Execute Structured Commits**:
   For each group with safe files:
   ```bash
   git add -- <group-files>
   git diff --cached --name-only
   git commit -m "<conventional commit message describing updates>"
   ```

5. **Report Summary**:
   Provide a concise summary of the commits created and verify the working tree
   is clean.

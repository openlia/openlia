"""Shared, stdlib-only checkpoint engine used by Hermes and the Workspace UI.

Only the UI exposes approve/dismiss. Proposals never stage the user's index.
Commit objects are prepared off-index and published by one compare-and-swap.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone


class ProposalError(Exception):
    def __init__(self, code, status=409):
        self.code, self.status = code, status
        super().__init__(code)


def protected(path):
    parts = PurePosixPath(path).parts
    return (
        not parts or path.startswith("/") or any(p in ("..", ".git") for p in parts)
        or any(p == ".env" or p.startswith(".env.") or ".secret" in p for p in parts)
        or any(p in ("auth.json", "sessions", "logs", "cache", "browser-profile", "mcp-tokens", "pairing") for p in parts)
        or path.lower().endswith((".pem", ".key", ".p12", ".pfx"))
    )


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True).encode()


class Checkpoints:
    def __init__(self, workspace):
        self.root = Path(workspace).resolve()
        # A real local repository only: no linked worktrees, symlinked Git dirs,
        # or redirection to another user's repository.
        git = self.root / ".git"
        if git.is_symlink() or not git.is_dir():
            raise ProposalError("workspace_git_not_configured", 400)
        self.git_dir = git
        self.store = git / "openlia-checkpoints"
        if self.store.is_symlink():
            raise ProposalError("unsafe_proposal_store", 400)
        self.store.mkdir(mode=0o700, exist_ok=True)

    def git(self, *args, data=None, index=None, extra_env=None, check=True):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update({"GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
        if index:
            env["GIT_INDEX_FILE"] = str(index)
        env.update(extra_env or {})
        result = subprocess.run(
            ["git", "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", str(self.root), *args],
            input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=30,
        )
        if check and result.returncode:
            raise ProposalError("git_operation_failed", 409)
        return result.stdout if check else result

    @contextlib.contextmanager
    def locked(self):
        with open(self.store / "lock", "a+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def save(self, name, value):
        fd, tmp = tempfile.mkstemp(dir=self.store)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(encoded(value))
                out.flush()
                os.fsync(out.fileno())
            os.replace(tmp, self.store / name)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def load(self, name):
        try:
            return json.loads((self.store / name).read_bytes())
        except FileNotFoundError:
            raise ProposalError("proposal_not_found", 404) from None

    def head(self):
        branch = self.git("symbolic-ref", "--quiet", "HEAD").decode().strip()
        if branch != "refs/heads/main":
            raise ProposalError("workspace_branch_must_be_main", 409)
        return self.git("rev-parse", "HEAD").decode().strip()

    def changed_paths(self):
        paths = self.git("diff", "HEAD", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z") + self.git("ls-files", "--others", "--exclude-standard", "-z")
        return sorted(set(os.fsdecode(p) for p in paths.split(b"\0") if p))

    def summary(self):
        self.head()
        paths = self.changed_paths()
        count = sum(not protected(path) for path in paths)
        return {"dirty": count > 0, "changed_count": count, "excluded_count": len(paths) - count}

    def entry(self, path):
        if protected(path):
            raise ProposalError("protected_workspace_path", 400)
        parts = PurePosixPath(path).parts
        directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            # Resolve each component through directory descriptors, so replacing
            # an ancestor with a symlink cannot redirect a read outside the root.
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return {"path": path, "oid": None, "mode": None}
        except OSError:
            raise ProposalError("symlink_not_supported", 400) from None
        finally:
            os.close(directory)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ProposalError("unsupported_workspace_file", 400)
            content = source.read(2 * 1024 * 1024 + 1)
            if len(content) > 2 * 1024 * 1024:
                raise ProposalError("checkpoint_file_too_large", 413)
        oid = self.git("hash-object", "-w", "--stdin", data=content).decode().strip()
        return {"path": path, "oid": oid, "mode": "100755" if info.st_mode & 0o111 else "100644", "size": len(content)}

    def put_entries(self, index, entries):
        # NUL records support spaces, tabs, newlines and Unicode without shell parsing.
        records = b""
        zero = "0" * len(self.head())
        for entry in entries:
            records += f"{entry['mode'] or '0'} {entry['oid'] or zero}\t".encode() + os.fsencode(entry["path"]) + b"\0"
        self.git("update-index", "-z", "--index-info", data=records, index=index)

    @contextlib.contextmanager
    def temporary_index(self, head):
        with tempfile.TemporaryDirectory(dir=self.store) as directory:
            index = Path(directory) / "index"
            self.git("read-tree", head, index=index)
            yield index

    def inspect(self):
        with self.locked():
            head = self.head()
            if self.git("ls-files", "-u", "-z"):
                raise ProposalError("workspace_has_conflicts")
            paths = self.changed_paths()
            if len(paths) > 500:
                raise ProposalError("too_many_checkpoint_files", 413)
            files, excluded, exclusion_reasons = [], [], {}
            for path in paths:
                if protected(path):
                    excluded.append(path)
                    exclusion_reasons[path] = "Protected credential or runtime path"
                else:
                    try:
                        files.append(self.entry(path))
                    except ProposalError as error:
                        if error.code != "checkpoint_file_too_large":
                            raise
                        excluded.append(path)
                        exclusion_reasons[path] = "Exceeds the 2 MiB per-file review limit"
            if sum(f.get("size", 0) for f in files) > 8 * 1024 * 1024:
                raise ProposalError("checkpoint_too_large", 413)
            with self.temporary_index(head) as index:
                self.put_entries(index, files)
                for file in files:
                    # The documented plaintext password exception may be committed,
                    # but its values must never be exposed to the model or UI.
                    if file["path"] == "sources/document-passwords.toml":
                        file["diff"] = "Sensitive document passwords: content hidden."
                    else:
                        diff = self.git("diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--", file["path"], index=index)
                        if len(diff) > 256 * 1024:
                            raise ProposalError("checkpoint_diff_too_large", 413)
                        file["diff"] = diff.decode("utf-8", errors="replace")
            if sum(len(f["diff"].encode()) for f in files) > 2 * 1024 * 1024:
                raise ProposalError("checkpoint_diff_too_large", 413)
            if self.head() != head or any(self.entry(f["path"]) != {k: v for k, v in f.items() if k != "diff"} for f in files):
                raise ProposalError("workspace_changed_during_review")
            snapshot = {"base_head": head, "files": files, "excluded": excluded, "exclusion_reasons": exclusion_reasons}
            snapshot_id = digest(encoded(snapshot))
            self.save(f"snapshot-{snapshot_id}.json", snapshot)
            return {"snapshot_id": snapshot_id, **snapshot}

    def snapshot(self, snapshot_id):
        if not isinstance(snapshot_id, str) or len(snapshot_id) != 64 or any(c not in "0123456789abcdef" for c in snapshot_id):
            raise ProposalError("invalid_snapshot_id", 400)
        return self.load(f"snapshot-{snapshot_id}.json")

    def proposals(self):
        with self.locked():
            stored = [self.load(p.name) for p in self.store.glob("proposal-*.json")]
            latest = sorted(stored, key=lambda p: p["updated_at"], reverse=True)[:50]
            return [self.public(self.recover(p)) for p in latest]

    def proposal(self, proposal_id):
        if not isinstance(proposal_id, str) or len(proposal_id) != 32 or any(c not in "0123456789abcdef" for c in proposal_id):
            raise ProposalError("invalid_proposal_id", 400)
        return self.load(f"proposal-{proposal_id}.json")

    def persist(self, proposal):
        self.save(f"proposal-{proposal['id']}.json", proposal)

    def public(self, proposal):
        result = {k: v for k, v in proposal.items() if k != "publication"}
        snapshot = self.snapshot(proposal["snapshot_id"])
        result["files"] = snapshot["files"]
        result["exclusion_reasons"] = snapshot.get("exclusion_reasons", {})
        result["excluded"] = sorted(set(snapshot["excluded"] + [f["path"] for f in snapshot["files"] if f["path"] not in {p for c in proposal["commits"] for p in c["files"]}]))
        if result["status"] == "pending":
            selected = {p for c in proposal["commits"] for p in c["files"]}
            try:
                result["stale"] = self.head() != proposal["base_head"] or any(self.entry(f["path"]) != {k: v for k, v in f.items() if k != "diff"} for f in snapshot["files"] if f["path"] in selected)
            except (ProposalError, OSError):
                result["stale"] = True
        return result

    def index_digest(self):
        index = self.git_dir / "index"
        return digest(index.read_bytes()) if index.exists() else None

    def propose(self, snapshot_id, commits, proposal_id=None, expected_revision=None, session_id=None):
        with self.locked():
            snapshot = self.snapshot(snapshot_id)
            known = {f["path"] for f in snapshot["files"]}
            if not isinstance(commits, list) or not 1 <= len(commits) <= 30:
                raise ProposalError("invalid_commit_groups", 400)
            selected = set()
            clean = []
            for commit in commits:
                if not isinstance(commit, dict):
                    raise ProposalError("invalid_commit_group", 400)
                message, rationale, files = commit.get("message"), commit.get("rationale"), commit.get("files")
                if not isinstance(message, str) or not message.strip() or len(message) > 500 or any(c in message for c in "\0\r\n") or not isinstance(rationale, str) or len(rationale) > 4000 or not isinstance(files, list) or not files:
                    raise ProposalError("invalid_commit_group", 400)
                for path in files:
                    if not isinstance(path, str) or path not in known or path in selected or protected(path):
                        raise ProposalError("invalid_or_duplicate_commit_path", 400)
                    selected.add(path)
                clean.append({"message": message.strip(), "rationale": rationale, "files": files})
            previous = self.recover(self.proposal(proposal_id)) if proposal_id else None
            if previous and (type(expected_revision) is not int or previous["status"] != "pending" or previous["revision"] != expected_revision):
                raise ProposalError("proposal_revision_conflict")
            now = datetime.now(timezone.utc).isoformat()
            proposal = {
                "id": proposal_id or uuid.uuid4().hex, "revision": previous["revision"] + 1 if previous else 1,
                "snapshot_id": snapshot_id, "base_head": snapshot["base_head"], "status": "pending",
                "created_at": previous["created_at"] if previous else now, "updated_at": now,
                "session_id": session_id or (previous or {}).get("session_id"), "commits": clean, "hashes": [],
            }
            if self.public(proposal)["stale"]:
                raise ProposalError("proposal_stale")
            if previous:
                self.save(f"revision-{previous['id']}-{previous['revision']}.json", previous)
            self.persist(proposal)
            return self.public(proposal)

    def recover(self, proposal):
        publication = proposal.get("publication")
        if not publication or proposal["status"] != "publishing":
            return proposal
        current = self.head()
        if current == publication["after"] or self.git("merge-base", "--is-ancestor", publication["after"], current, check=False).returncode == 0:
            # Finish only our own index lock, never an index subsequently edited by Git.
            lock = self.git_dir / "index.lock"
            if lock.exists() and digest(lock.read_bytes()) == publication["index_digest"]:
                if self.index_digest() == publication["original_index_digest"]:
                    os.replace(lock, self.git_dir / "index")
                else:
                    raise ProposalError("checkpoint_index_recovery_required")
            elif current == publication["after"] and self.index_digest() != publication["index_digest"]:
                raise ProposalError("checkpoint_index_recovery_required")
            proposal["status"] = "applied"
            proposal["hashes"] = publication["hashes"]
        elif current == publication["before"]:
            lock = self.git_dir / "index.lock"
            if lock.exists() and digest(lock.read_bytes()) == publication["index_digest"]:
                lock.unlink()
            proposal["status"] = "pending"
        else:
            raise ProposalError("checkpoint_publication_recovery_required")
        self.persist(proposal)
        return proposal

    def approve(self, proposal_id, revision):
        with self.locked():
            proposal = self.recover(self.proposal(proposal_id))
            if type(revision) is not int or proposal["revision"] != revision:
                raise ProposalError("proposal_revision_conflict")
            if proposal["status"] == "applied":
                return self.public(proposal)
            if proposal["status"] != "pending":
                raise ProposalError("proposal_not_pending")
            if self.public(proposal)["stale"]:
                raise ProposalError("proposal_stale")
            snapshot = self.snapshot(proposal["snapshot_id"])
            files = {f["path"]: f for f in snapshot["files"]}
            selected = [files[p] for c in proposal["commits"] for p in c["files"]]
            index_path, lock_path = self.git_dir / "index", self.git_dir / "index.lock"
            try:
                fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                raise ProposalError("git_index_busy") from None
            published = False
            try:
                with os.fdopen(fd, "wb") as out:
                    original_digest = self.index_digest()
                    if index_path.exists():
                        original = index_path.read_bytes()
                    else:
                        with self.temporary_index(proposal["base_head"]) as empty_index:
                            original = empty_index.read_bytes()
                    out.write(original)
                # Refuse partial staging on selected paths rather than losing the
                # user's staged/unstaged boundary. Unrelated staging is preserved.
                for file in selected:
                    staged = self.git("ls-files", "--stage", "-z", "--", file["path"])
                    base = self.git("ls-tree", "-z", proposal["base_head"], "--", file["path"])
                    staged_entry = staged.split(b"\t", 1)[0].split()[:2] if staged else []
                    base_entry = base.split(b"\t", 1)[0].split() if base else []
                    base_entry = [base_entry[0], base_entry[2]] if base_entry else []
                    target = [file["mode"].encode(), file["oid"].encode()] if file["oid"] else []
                    if staged_entry != base_entry and staged_entry != target:
                        raise ProposalError("selected_file_partially_staged")
                self.put_entries(lock_path, selected)
                with open(lock_path, "rb") as prepared_index:
                    os.fsync(prepared_index.fileno())
                with self.temporary_index(proposal["base_head"]) as index:
                    parent, hashes = proposal["base_head"], []
                    for commit in proposal["commits"]:
                        self.put_entries(index, [files[p] for p in commit["files"]])
                        tree = self.git("write-tree", index=index).decode().strip()
                        parent = self.git("commit-tree", tree, "-p", parent, data=(commit["message"] + "\n").encode(), extra_env={
                            "GIT_AUTHOR_NAME": "OpenLia Agent", "GIT_AUTHOR_EMAIL": "openlia@localhost",
                            "GIT_COMMITTER_NAME": "OpenLia Agent", "GIT_COMMITTER_EMAIL": "openlia@localhost",
                        }).decode().strip()
                        hashes.append(parent)
                if self.public(proposal)["stale"]:
                    raise ProposalError("proposal_stale")
                proposal["status"] = "publishing"
                proposal["publication"] = {"before": proposal["base_head"], "after": parent, "hashes": hashes, "index_digest": digest(lock_path.read_bytes()), "original_index_digest": original_digest}
                self.persist(proposal)
                self.git("update-ref", "-m", "OpenLia approved checkpoint", "refs/heads/main", parent, proposal["base_head"])
                published = True
                os.replace(lock_path, index_path)
                proposal["status"], proposal["hashes"] = "applied", hashes
                proposal["updated_at"] = datetime.now(timezone.utc).isoformat()
                self.persist(proposal)
                return self.public(proposal)
            finally:
                # Once journaled, a failed/ambiguous update-ref is recovered on
                # the next request. Never remove its prepared index prematurely.
                if not published and proposal["status"] != "publishing" and lock_path.exists():
                    lock_path.unlink()

    def dismiss(self, proposal_id, revision):
        with self.locked():
            proposal = self.recover(self.proposal(proposal_id))
            if type(revision) is not int or proposal["revision"] != revision or proposal["status"] != "pending":
                raise ProposalError("proposal_revision_conflict")
            proposal["status"] = "dismissed"
            proposal["updated_at"] = datetime.now(timezone.utc).isoformat()
            self.persist(proposal)
            return self.public(proposal)


def main():
    try:
        request = json.loads(sys.stdin.buffer.read(65537))
        engine = Checkpoints(sys.argv[1])
        action = request.get("action")
        if action == "list":
            result = {"proposals": engine.proposals()}
        elif action in ("approve", "dismiss"):
            result = getattr(engine, action)(request.get("id"), request.get("revision"))
        else:
            raise ProposalError("unsupported_checkpoint_action", 400)
        print(json.dumps({"ok": True, "result": result}))
    except ProposalError as error:
        print(json.dumps({"ok": False, "error": error.code, "status": error.status}))
    except Exception:
        # Never leak Git output, paths or secret contents through an exception.
        print(json.dumps({"ok": False, "error": "checkpoint_operation_failed", "status": 500}))


if __name__ == "__main__":
    main()

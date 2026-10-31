"""SQLite-backed Workspace Maintainer bridge for Hermes agent tools and post-mutation advisory feedback.

Shares the exact SQLite schema (/opt/data/maintainer/maintainer.sqlite) and deterministic
issue_id / contract_fingerprint semantics with the Workspace UI server so user Ignore/Restore
decisions and agent feedback stay synchronized across Web UI, Chat, and Telegram.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import yaml

try:
    from jsonschema import Draft202012Validator
except Exception:  # pragma: no cover
    Draft202012Validator = None  # type: ignore[assignment]


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\Z", re.DOTALL)


def _inline_warnings(content: str) -> list[str]:
    helper = Path(os.environ.get("OPENLIA_POLICY_HELPER", "/opt/data/skills/workspace-template-customization/scripts/workspace_registry.py"))
    candidates = [helper.with_name("openui_validation.py"), Path(__file__).resolve().parents[2] / "system-skills/workspace-template-customization/scripts/openui_validation.py"]
    for path in candidates:
        if not path.is_file() or path.is_symlink():
            continue
        spec = importlib.util.spec_from_file_location("openlia_inline_openui", path)
        if spec and spec.loader:
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module.validate_inline_openui(content)
    return []


def _openui_file_warnings(content: str) -> list[str]:
    repo_root = Path(__file__).resolve().parents[3]
    cli_candidates = [
        Path(os.environ.get("OPENLIA_OPENUI_AUTHORING_CLI", "").strip())
        if os.environ.get("OPENLIA_OPENUI_AUTHORING_CLI", "").strip()
        else None,
        Path("/usr/local/lib/openlia/openui-authoring.js"),
        repo_root / "packages" / "workspace-ui" / "dist" / "openui-authoring.js",
        repo_root / "packages" / "workspace-ui" / "scripts" / "openui-authoring.ts",
    ]
    bun_bin = shutil.which("bun")
    cli_path = next((p for p in cli_candidates if p is not None and p.is_file()), None)
    if cli_path is not None and bun_bin:
        try:
            proc = subprocess.run(
                [bun_bin, str(cli_path)],
                input=json.dumps({"action": "validate", "content": content, "format": "openui"}),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=10,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                parsed = json.loads(proc.stdout)
                if parsed.get("status") == "ok":
                    if parsed.get("valid") is True:
                        return []
                    diags: list[str] = []
                    for block in parsed.get("blocks", []):
                        for diag in block.get("diagnostics", []):
                            code = diag.get("code") or "openui_error"
                            msg = diag.get("message") or "OpenUI schema error"
                            hint = diag.get("hint")
                            diags.append(f"{code}: {msg} ({hint})" if hint else f"{code}: {msg}")
                    if diags:
                        return diags
        except Exception:
            pass

    helper = Path(os.environ.get("OPENLIA_POLICY_HELPER", "/opt/data/skills/workspace-template-customization/scripts/workspace_registry.py"))
    candidates = [helper.with_name("openui_validation.py"), Path(__file__).resolve().parents[2] / "system-skills/workspace-template-customization/scripts/openui_validation.py"]
    for path in candidates:
        if not path.is_file() or path.is_symlink():
            continue
        spec = importlib.util.spec_from_file_location("openlia_inline_openui", path)
        if spec and spec.loader:
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if hasattr(module, "validate_openui_source"):
                return module.validate_openui_source(content)
    return []


def sha256_hex(value: str | bytes) -> str:
    data = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


def file_revision(data: bytes) -> str:
    return f"sha256:{sha256_hex(data)}"


def compute_workspace_id(workspace_root: Path) -> str:
    resolved = str(workspace_root.expanduser().resolve())
    return f"ws_{sha256_hex(resolved)[:12]}"


def _js_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def compute_contract_fingerprint(
    *,
    rule_code: str,
    subject: str,
    template_schema_ref: str | None = None,
    template_sections: list[str] | None = None,
    schema_property_rule: Any = None,
    manifest_target: str | None = None,
) -> str:
    if rule_code.startswith("WM-FM-"):
        return sha256_hex(
            f"frontmatter:{rule_code}:{template_schema_ref if template_schema_ref is not None else 'none'}"
        )[:16]
    if rule_code == "WM-TEMPLATE-SECTION-MISSING":
        return sha256_hex(f"template-section:{subject.strip().lower()}")[:16]
    if rule_code.startswith("WM-TEMPLATE-"):
        normalized = [s.strip().lower() for s in (template_sections or []) if s.strip()]
        return sha256_hex(
            f"template:{rule_code}:{template_schema_ref or ''}:{_js_json(normalized)}"
        )[:16]
    if rule_code.startswith("WM-SCHEMA-"):
        return sha256_hex(
            f"schema:{rule_code}:{subject}:{_js_json(schema_property_rule)}"
        )[:16]
    if rule_code.startswith("WM-MANIFEST-") or rule_code.startswith("WM-OPENUI-"):
        return sha256_hex(
            f"project:{rule_code}:{subject}:{manifest_target or ''}"
        )[:16]
    return sha256_hex(f"rule:{rule_code}:{subject}")[:16]


def compute_issue_id(
    *,
    workspace_id: str,
    relative_path: str,
    rule_code: str,
    subject: str,
    contract_fingerprint: str,
) -> str:
    normalized_path = relative_path.replace("\\", "/").strip("/")
    payload = _js_json(
        [
            workspace_id,
            normalized_path,
            rule_code,
            subject,
            contract_fingerprint,
        ]
    )
    return f"wm_{sha256_hex(payload)[:32]}"


def _extract_headings(body: str) -> tuple[bool, list[str]]:
    has_h1 = False
    h2s: list[str] = []
    in_fence = False
    for raw_line in body.splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING_RE.match(stripped)
        if not m:
            continue
        hashes, title = m.group(1), m.group(2).strip()
        if len(hashes) == 1:
            has_h1 = True
        elif len(hashes) == 2 and title:
            h2s.append(title)
    return has_h1, h2s


def _parse_frontmatter(text: str) -> tuple[bool, dict[str, Any] | None, str, str | None]:
    if not text.startswith("---\n") and not text.startswith("---\r\n"):
        return False, None, text, None
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return True, None, text, "Frontmatter block is missing a closing '---' delimiter."
    raw_yaml, body = m.group(1), m.group(2)
    try:
        parsed = yaml.safe_load(raw_yaml)
    except Exception as exc:
        return True, None, body, f"Malformed YAML frontmatter: {exc}"
    if parsed is None:
        return True, {}, body, None
    if not isinstance(parsed, dict):
        return True, None, body, "Frontmatter must be a YAML key-value mapping."
    normalized = json.loads(json.dumps(parsed, default=str))
    return True, normalized, body, None


def _find_local_template(folder: Path) -> Path | None:
    try:
        candidates = sorted(
            p
            for p in folder.iterdir()
            if p.is_file()
            and not p.is_symlink()
            and p.name.lower().endswith("-template.md")
        )
    except OSError:
        return None
    return candidates[0] if candidates else None


class MaintainerBridge:
    """SQLite-backed Workspace Maintainer store and validator."""

    def __init__(
        self,
        workspace_root: Path,
        maintainer_root: Path | None = None,
    ) -> None:
        self.workspace_root = workspace_root.expanduser().resolve()
        self.workspace_id = compute_workspace_id(self.workspace_root)
        if maintainer_root is not None:
            self.maintainer_root = maintainer_root.expanduser().resolve()
        elif os.environ.get("OPENLIA_MAINTAINER_ROOT"):
            self.maintainer_root = Path(os.environ["OPENLIA_MAINTAINER_ROOT"]).expanduser().resolve()
        else:
            self.maintainer_root = (self.workspace_root.parent / "maintainer").resolve()
        self.db_path = self.maintainer_root / "maintainer.sqlite"
        self._ensure_schema()

    @contextlib.contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        self.maintainer_root.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), timeout=5.0)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode = WAL;")
            conn.execute("PRAGMA busy_timeout = 5000;")
            conn.execute("PRAGMA foreign_keys = ON;")
            with conn:
                yield conn
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS findings (
                  issue_id TEXT PRIMARY KEY,
                  workspace_id TEXT NOT NULL,
                  relative_path TEXT NOT NULL,
                  rule_code TEXT NOT NULL,
                  severity TEXT NOT NULL,
                  category TEXT NOT NULL,
                  subject TEXT NOT NULL,
                  message TEXT NOT NULL,
                  explanation TEXT NOT NULL,
                  contract_path TEXT,
                  contract_fingerprint TEXT NOT NULL,
                  fix_strategy TEXT NOT NULL,
                  present INTEGER NOT NULL DEFAULT 1,
                  first_seen_at TEXT NOT NULL,
                  last_seen_at TEXT NOT NULL,
                  resolved_at TEXT,
                  last_checked_revision TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_findings_path ON findings(workspace_id, relative_path);
                CREATE INDEX IF NOT EXISTS idx_findings_present ON findings(workspace_id, present);

                CREATE TABLE IF NOT EXISTS ignore_decisions (
                  issue_id TEXT PRIMARY KEY,
                  workspace_id TEXT NOT NULL,
                  relative_path TEXT NOT NULL,
                  rule_code TEXT NOT NULL,
                  subject TEXT NOT NULL,
                  contract_fingerprint TEXT NOT NULL,
                  active INTEGER NOT NULL DEFAULT 1,
                  actor TEXT NOT NULL,
                  reason TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  restored_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_ignore_decisions_path ON ignore_decisions(workspace_id, relative_path);

                CREATE TABLE IF NOT EXISTS fix_attempts (
                  id TEXT PRIMARY KEY,
                  issue_id TEXT NOT NULL,
                  relative_path TEXT NOT NULL,
                  actor TEXT NOT NULL,
                  before_revision TEXT NOT NULL,
                  after_revision TEXT,
                  status TEXT NOT NULL,
                  summary TEXT,
                  created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_fix_attempts_issue ON fix_attempts(issue_id);

                CREATE TABLE IF NOT EXISTS scan_state (
                  workspace_id TEXT PRIMARY KEY,
                  last_scan_at TEXT NOT NULL,
                  coverage_status TEXT NOT NULL,
                  files_scanned INTEGER NOT NULL,
                  files_skipped INTEGER NOT NULL,
                  scan_errors_json TEXT NOT NULL
                );
                """
            )

    def _make_candidate(
        self,
        *,
        relative_path: str,
        rule_code: str,
        severity: str,
        subject: str,
        message: str,
        explanation: str,
        contract_fingerprint: str,
        fix_strategy: str,
        checked_revision: str,
        category: str = "contract",
        contract_path: str | None = None,
    ) -> dict[str, Any]:
        issue_id = compute_issue_id(
            workspace_id=self.workspace_id,
            relative_path=relative_path,
            rule_code=rule_code,
            subject=subject,
            contract_fingerprint=contract_fingerprint,
        )
        return {
            "issue_id": issue_id,
            "workspace_id": self.workspace_id,
            "relative_path": relative_path,
            "rule_code": rule_code,
            "severity": severity,
            "category": category,
            "subject": subject,
            "message": message,
            "explanation": explanation,
            "contract_path": contract_path,
            "contract_fingerprint": contract_fingerprint,
            "fix_strategy": fix_strategy,
            "checked_revision": checked_revision,
        }

    def evaluate_file(
        self, relative_path: str, content: str, checked_revision: str
    ) -> list[dict[str, Any]]:
        rel = relative_path.replace("\\", "/").strip("/")
        abs_path = (self.workspace_root / rel).resolve(strict=False)
        lower = rel.lower()
        candidates: list[dict[str, Any]] = []

        if lower.endswith(".schema.json"):
            try:
                parsed = json.loads(content)
                if not isinstance(parsed, dict):
                    raise ValueError("Schema root must be a JSON object")
                if Draft202012Validator is not None:
                    Draft202012Validator.check_schema(parsed)
            except Exception as exc:
                fp = compute_contract_fingerprint(
                    rule_code="WM-CONTRACT-INVALID", subject="$schema"
                )
                candidates.append(
                    self._make_candidate(
                        relative_path=rel,
                        rule_code="WM-CONTRACT-INVALID",
                        severity="error",
                        subject="$schema",
                        message=f"Invalid JSON Schema in {rel}: {exc}",
                        explanation="Fix the JSON syntax or JSON Schema Draft 2020-12 structure.",
                        contract_path=rel,
                        contract_fingerprint=fp,
                        fix_strategy="agent",
                        checked_revision=checked_revision,
                    )
                )
            return candidates

        if lower.endswith(".openui"):
            for message in _openui_file_warnings(content):
                candidates.append(self._make_candidate(
                    relative_path=rel, rule_code="openui_syntax_error",
                    severity="warning", subject=message, message=message,
                    explanation="Fix the OpenUI syntax; use the Workspace UI preview for full component schema diagnostics.",
                    contract_fingerprint=compute_contract_fingerprint(rule_code="openui_syntax_error", subject=message),
                    fix_strategy="agent", checked_revision=checked_revision,
                ))
            return candidates

        if lower.endswith(".md"):
            for message in _inline_warnings(content):
                candidates.append(self._make_candidate(
                    relative_path=rel, rule_code="openui_syntax_error",
                    severity="warning", subject=message, message=message,
                    explanation="Fix the inline OpenUI syntax; use the Workspace UI preview for full component schema diagnostics.",
                    contract_fingerprint=compute_contract_fingerprint(rule_code="openui_syntax_error", subject=message),
                    fix_strategy="agent", checked_revision=checked_revision,
                ))

        if not lower.endswith(".md") or lower.endswith("/readme.md") or lower == "readme.md":
            return candidates

        is_template = lower.endswith("-template.md")
        has_fm, fm, body, fm_err = _parse_frontmatter(content)
        if fm_err:
            fp = compute_contract_fingerprint(
                rule_code="WM-FM-PARSE", subject="frontmatter"
            )
            candidates.append(
                self._make_candidate(
                    relative_path=rel,
                    rule_code="WM-FM-PARSE",
                    severity="error",
                    subject="frontmatter",
                    message=fm_err,
                    explanation="Ensure YAML frontmatter starts and ends with '---' and contains valid YAML key-value pairs.",
                    contract_fingerprint=fp,
                    fix_strategy="agent",
                    checked_revision=checked_revision,
                )
            )
            return candidates

        if is_template:
            return candidates

        # Check local template in same folder
        template_abs = _find_local_template(abs_path.parent)
        template_rel: str | None = None
        template_fm: dict[str, Any] | None = None
        template_sections: list[str] = []
        template_has_h1 = False
        template_schema_ref: str | None = None

        if template_abs and template_abs.is_file():
            try:
                template_rel = template_abs.relative_to(self.workspace_root).as_posix()
                t_text = template_abs.read_text(encoding="utf-8")
                t_has_fm, t_fm, t_body, t_err = _parse_frontmatter(t_text)
                if not t_err:
                    template_fm = t_fm if t_has_fm else None
                    if isinstance(template_fm, dict) and isinstance(template_fm.get("$schema"), str):
                        template_schema_ref = template_fm["$schema"]
                    template_has_h1, template_sections = _extract_headings(t_body)
            except OSError:
                template_rel = None

        if template_rel:
            if template_fm is not None and not has_fm:
                fp = compute_contract_fingerprint(
                    rule_code="WM-FM-MISSING",
                    subject="frontmatter",
                    template_schema_ref=template_schema_ref,
                )
                candidates.append(
                    self._make_candidate(
                        relative_path=rel,
                        rule_code="WM-FM-MISSING",
                        severity="warning",
                        subject="frontmatter",
                        message=f"Missing YAML frontmatter required by template {template_rel}",
                        explanation=f"Add a YAML frontmatter block matching {template_rel}.",
                        contract_path=template_rel,
                        contract_fingerprint=fp,
                        fix_strategy="deterministic",
                        checked_revision=checked_revision,
                    )
                )

            rec_has_h1, rec_h2s = _extract_headings(body)
            if template_has_h1 and not rec_has_h1:
                fp = compute_contract_fingerprint(
                    rule_code="WM-TEMPLATE-TITLE",
                    subject="h1",
                    template_schema_ref=template_schema_ref,
                    template_sections=template_sections,
                )
                candidates.append(
                    self._make_candidate(
                        relative_path=rel,
                        rule_code="WM-TEMPLATE-TITLE",
                        severity="warning",
                        subject="h1",
                        message="Missing top-level '# Title' heading expected by template",
                        explanation=f"Add a top-level '# Title' heading to match {template_rel}.",
                        contract_path=template_rel,
                        contract_fingerprint=fp,
                        fix_strategy="deterministic",
                        checked_revision=checked_revision,
                    )
                )

            rec_h2_lower = {h.strip().lower() for h in rec_h2s}
            for expected_sec in template_sections:
                if expected_sec.strip().lower() not in rec_h2_lower:
                    fp = compute_contract_fingerprint(
                        rule_code="WM-TEMPLATE-SECTION-MISSING",
                        subject=expected_sec,
                    )
                    candidates.append(
                        self._make_candidate(
                            relative_path=rel,
                            rule_code="WM-TEMPLATE-SECTION-MISSING",
                            severity="warning",
                            subject=expected_sec,
                            message=f"Missing template section '## {expected_sec}'",
                            explanation=f"Template {template_rel} defines section '## {expected_sec}'.",
                            contract_path=template_rel,
                            contract_fingerprint=fp,
                            fix_strategy="deterministic",
                            checked_revision=checked_revision,
                        )
                    )

        # Schema validation if frontmatter or template specifies $schema
        schema_ref = (
            fm.get("$schema")
            if isinstance(fm, dict) and isinstance(fm.get("$schema"), str)
            else template_schema_ref
        )
        if isinstance(schema_ref, str) and schema_ref.strip() and isinstance(fm, dict):
            schema_base = abs_path.parent if fm.get("$schema") else (template_abs.parent if template_abs else abs_path.parent)
            schema_abs = (schema_base / schema_ref).resolve(strict=False)
            try:
                schema_rel = schema_abs.relative_to(self.workspace_root).as_posix()
            except ValueError:
                schema_rel = None
            if schema_rel and schema_abs.is_file() and not schema_abs.is_symlink():
                try:
                    schema_obj = json.loads(schema_abs.read_text(encoding="utf-8"))
                    if isinstance(schema_obj, dict) and Draft202012Validator is not None:
                        validator = Draft202012Validator(schema_obj)
                        for err in validator.iter_errors(fm):
                            if err.validator == "required":
                                m = re.search(r"'([^']+)' is a required property", err.message)
                                prop = m.group(1) if m else "frontmatter"
                                rule_code = "WM-SCHEMA-REQUIRED"
                                prop_rule = (schema_obj.get("properties") or {}).get(prop)
                            else:
                                path_parts = [str(p) for p in err.absolute_path]
                                prop = ".".join(path_parts) if path_parts else "frontmatter"
                                rule_code = "WM-SCHEMA-PROPERTY"
                                prop_rule = (schema_obj.get("properties") or {}).get(prop)
                            fp = compute_contract_fingerprint(
                                rule_code=rule_code,
                                subject=prop,
                                schema_property_rule=prop_rule,
                            )
                            candidates.append(
                                self._make_candidate(
                                    relative_path=rel,
                                    rule_code=rule_code,
                                    severity="warning",
                                    subject=prop,
                                    message=f"frontmatter.{prop}: {err.message}" if prop != "frontmatter" else f"frontmatter: {err.message}",
                                    explanation=f"Frontmatter field '{prop}' violates schema {schema_rel}.",
                                    contract_path=schema_rel,
                                    contract_fingerprint=fp,
                                    fix_strategy="deterministic" if rule_code == "WM-SCHEMA-REQUIRED" else "agent",
                                    checked_revision=checked_revision,
                                )
                            )
                except Exception:
                    pass

        return candidates

    def reconcile_file(
        self,
        relative_path: str,
        checked_revision: str,
        candidates: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        rel = relative_path.replace("\\", "/").strip("/")
        now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
        active_ids = {c["issue_id"] for c in candidates}

        with self._connect() as conn:
            for c in candidates:
                conn.execute(
                    """
                    INSERT INTO findings (
                      issue_id, workspace_id, relative_path, rule_code, severity, category,
                      subject, message, explanation, contract_path, contract_fingerprint,
                      fix_strategy, present, first_seen_at, last_seen_at, resolved_at, last_checked_revision
                    ) VALUES (
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?
                    )
                    ON CONFLICT(issue_id) DO UPDATE SET
                      severity = excluded.severity,
                      category = excluded.category,
                      message = excluded.message,
                      explanation = excluded.explanation,
                      contract_path = excluded.contract_path,
                      fix_strategy = excluded.fix_strategy,
                      present = 1,
                      last_seen_at = excluded.last_seen_at,
                      resolved_at = NULL,
                      last_checked_revision = excluded.last_checked_revision
                    """,
                    (
                        c["issue_id"],
                        self.workspace_id,
                        rel,
                        c["rule_code"],
                        c["severity"],
                        c["category"],
                        c["subject"],
                        c["message"],
                        c["explanation"],
                        c.get("contract_path"),
                        c["contract_fingerprint"],
                        c["fix_strategy"],
                        now_iso,
                        now_iso,
                        checked_revision,
                    ),
                )

            existing = conn.execute(
                "SELECT issue_id FROM findings WHERE workspace_id = ? AND relative_path = ? AND present = 1",
                (self.workspace_id, rel),
            ).fetchall()
            for row in existing:
                if row["issue_id"] not in active_ids:
                    conn.execute(
                        """
                        UPDATE findings
                        SET present = 0, resolved_at = ?, last_checked_revision = ?
                        WHERE issue_id = ?
                        """,
                        (now_iso, checked_revision, row["issue_id"]),
                    )

        return self.list_findings(relative_path=rel)

    def validate_and_reconcile_paths(self, relative_paths: list[str]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        seen: set[str] = set()
        for raw in relative_paths:
            rel = raw.replace("\\", "/").strip("/")
            if not rel or rel in seen:
                continue
            seen.add(rel)
            abs_path = (self.workspace_root / rel).resolve(strict=False)
            if not abs_path.is_file() or abs_path.is_symlink():
                now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
                with self._connect() as conn:
                    conn.execute(
                        "UPDATE findings SET present = 0, resolved_at = ? WHERE workspace_id = ? AND relative_path = ? AND present = 1",
                        (now_iso, self.workspace_id, rel),
                    )
                continue
            try:
                raw_bytes = abs_path.read_bytes()
                rev = file_revision(raw_bytes)
                text = raw_bytes.decode("utf-8")
            except Exception:
                continue
            candidates = self.evaluate_file(rel, text, rev)
            # Revision-race guard
            try:
                after_bytes = abs_path.read_bytes()
                if file_revision(after_bytes) != rev:
                    continue
            except Exception:
                continue
            results.extend(self.reconcile_file(rel, rev, candidates))
        return results

    def list_findings(
        self,
        *,
        relative_path: str | None = None,
        state: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses = ["f.workspace_id = ?"]
        params: list[Any] = [self.workspace_id]
        if relative_path is not None:
            clauses.append("f.relative_path = ?")
            params.append(relative_path.replace("\\", "/").strip("/"))

        sql = f"""
            SELECT
              f.*,
              ig.active AS ignore_active,
              ig.actor AS ignore_actor,
              ig.reason AS ignore_reason,
              ig.updated_at AS ignore_updated_at,
              ig.restored_at AS ignore_restored_at
            FROM findings f
            LEFT JOIN ignore_decisions ig
              ON ig.issue_id = f.issue_id
             AND ig.contract_fingerprint = f.contract_fingerprint
            WHERE {' AND '.join(clauses)}
            ORDER BY f.present DESC, f.last_seen_at DESC, f.relative_path ASC
        """
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()

        records: list[dict[str, Any]] = []
        for r in rows:
            present = bool(r["present"])
            ignored = bool(r["ignore_active"] == 1)
            computed_state = "resolved" if not present else ("ignored" if ignored else "open")
            if state and computed_state != state:
                continue
            rec: dict[str, Any] = {
                "issue_id": r["issue_id"],
                "workspace_id": r["workspace_id"],
                "relative_path": r["relative_path"],
                "rule_code": r["rule_code"],
                "severity": r["severity"],
                "category": r["category"],
                "subject": r["subject"],
                "message": r["message"],
                "explanation": r["explanation"],
                "contract_path": r["contract_path"],
                "contract_fingerprint": r["contract_fingerprint"],
                "fix_strategy": r["fix_strategy"],
                "state": computed_state,
                "present": present,
                "first_seen_at": r["first_seen_at"],
                "last_seen_at": r["last_seen_at"],
                "resolved_at": r["resolved_at"],
                "last_checked_revision": r["last_checked_revision"],
            }
            if r["ignore_updated_at"]:
                rec["ignored_at"] = r["ignore_updated_at"]
            if r["ignore_actor"]:
                rec["ignored_by"] = r["ignore_actor"]
            if r["ignore_reason"]:
                rec["ignore_reason"] = r["ignore_reason"]
            records.append(rec)
        return records

    def format_post_mutation_feedback(self, relative_paths: list[str]) -> str | None:
        """Validate mutated files and return concise non-blocking advisory text for open warnings."""
        findings = self.validate_and_reconcile_paths(relative_paths)
        open_findings = [
            f for f in findings if f.get("state") == "open" and f.get("category") == "contract"
        ]
        if not open_findings:
            return None
        count = len(open_findings)
        noun = "structural warning" if count == 1 else "structural warnings"
        parts: list[str] = []
        for f in open_findings[:5]:
            parts.append(
                f"{f['relative_path']}: {f['message']} "
                f"[issue_id={f['issue_id']}, rule={f['rule_code']}, rev={f['last_checked_revision']}]"
            )
        more = f" (+{count - 5} more)" if count > 5 else ""
        return (
            f"Saved successfully. {count} {noun}: "
            + "; ".join(parts)
            + more
            + ". You may correct it within the user's request or continue without fixing."
        )

    def triage_issue(
        self,
        *,
        issue_id: str,
        action: str,
        actor: str = "agent",
        reason: str | None = None,
    ) -> dict[str, Any]:
        action_clean = action.strip().lower()
        now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM findings WHERE issue_id = ?", (issue_id,)
            ).fetchone()
            if row is None:
                return {"ok": False, "error": "finding_not_found", "issue_id": issue_id}

            if action_clean == "ignore":
                conn.execute(
                    """
                    INSERT INTO ignore_decisions (
                      issue_id, workspace_id, relative_path, rule_code, subject,
                      contract_fingerprint, active, actor, reason, created_at, updated_at, restored_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)
                    ON CONFLICT(issue_id) DO UPDATE SET
                      contract_fingerprint = excluded.contract_fingerprint,
                      active = 1,
                      actor = excluded.actor,
                      reason = excluded.reason,
                      updated_at = excluded.updated_at,
                      restored_at = NULL
                    """,
                    (
                        issue_id,
                        row["workspace_id"],
                        row["relative_path"],
                        row["rule_code"],
                        row["subject"],
                        row["contract_fingerprint"],
                        actor,
                        reason,
                        now_iso,
                        now_iso,
                    ),
                )
            elif action_clean == "restore":
                conn.execute(
                    """
                    UPDATE ignore_decisions
                    SET active = 0, updated_at = ?, restored_at = ?
                    WHERE issue_id = ?
                    """,
                    (now_iso, now_iso, issue_id),
                )
            else:
                return {"ok": False, "error": f"unsupported action: {action}"}

        updated = [f for f in self.list_findings(relative_path=row["relative_path"]) if f["issue_id"] == issue_id]
        return {
            "ok": True,
            "action": action_clean,
            "issue_id": issue_id,
            "finding": updated[0] if updated else None,
        }

    def run_audit(self) -> dict[str, Any]:
        files_scanned = 0
        files_skipped = 0
        scan_errors: list[str] = []
        now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
        rel_paths: list[str] = []

        for root, dirs, files in os.walk(self.workspace_root):
            dirs[:] = sorted(
                d
                for d in dirs
                if not d.startswith(".")
                and d not in {"node_modules", "__pycache__", ".venv", ".pytest_cache"}
            )
            for name in sorted(files):
                if name.startswith("."):
                    continue
                abs_file = Path(root) / name
                if abs_file.is_symlink():
                    files_skipped += 1
                    continue
                try:
                    rel = abs_file.relative_to(self.workspace_root).as_posix()
                except ValueError:
                    continue
                lower = name.lower()
                if (
                    lower.endswith(".md")
                    or lower.endswith(".schema.json")
                    or lower.endswith(".openui")
                ):
                    rel_paths.append(rel)
                    files_scanned += 1

        self.validate_and_reconcile_paths(rel_paths)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scan_state (
                  workspace_id, last_scan_at, coverage_status, files_scanned, files_skipped, scan_errors_json
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(workspace_id) DO UPDATE SET
                  last_scan_at = excluded.last_scan_at,
                  coverage_status = excluded.coverage_status,
                  files_scanned = excluded.files_scanned,
                  files_skipped = excluded.files_skipped,
                  scan_errors_json = excluded.scan_errors_json
                """,
                (
                    self.workspace_id,
                    now_iso,
                    "partial" if scan_errors else "complete",
                    files_scanned,
                    files_skipped,
                    json.dumps(scan_errors),
                ),
            )
        return self.status()

    def status(
        self,
        *,
        relative_path: str | None = None,
        state: str | None = None,
    ) -> dict[str, Any]:
        all_findings = self.list_findings(relative_path=relative_path, state=state)
        open_findings = [f for f in all_findings if f["state"] == "open" and f["category"] == "contract"]
        ignored_findings = [f for f in all_findings if f["state"] == "ignored"]
        resolved_findings = [f for f in all_findings if f["state"] == "resolved"]
        return {
            "schema": 1,
            "workspace_id": self.workspace_id,
            "counts": {
                "open": len(open_findings),
                "ignored": len(ignored_findings),
                "resolved": len(resolved_findings),
            },
            "open_findings": open_findings,
            "ignored_findings": ignored_findings,
            "resolved_findings": resolved_findings,
        }

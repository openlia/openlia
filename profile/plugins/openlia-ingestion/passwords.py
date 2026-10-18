"""Small, deliberately narrow document-password profile store inside the Ingestion Vault."""

from __future__ import annotations

import json
import os
import re
import tempfile
import tomllib
from contextlib import contextmanager
from pathlib import Path


PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
FORBIDDEN_LABEL = re.compile(r"(?i)(oauth|api[ _-]?key|token|private[ _-]?key|session|cookie|service[ _-]?credential)")


class PasswordProfileError(ValueError):
    pass


def _resolve_vault_root(root: Path) -> Path:
    resolved = root.expanduser().resolve()
    # If a caller passes the workspace root, redirect storage to the ingestion vault root
    # so zero files are ever written into the workspace repository.
    env_ingestion = os.environ.get("OPENLIA_INGESTION_ROOT")
    if env_ingestion:
        return Path(env_ingestion).expanduser().resolve()
    env_workspace = os.environ.get("OPENLIA_WORKSPACE_ROOT")
    if env_workspace and resolved == Path(env_workspace).expanduser().resolve():
        hermes_home = os.environ.get("HERMES_HOME")
        if hermes_home:
            return Path(hermes_home).expanduser().resolve() / "ingestion"
        return resolved.parent / "ingestion"
    return resolved


def levenshtein_distance(a: str, b: str) -> int:
    s1 = (a or "").lower()
    s2 = (b or "").lower()
    if s1 == s2:
        return 0
    if not s1:
        return len(s2)
    if not s2:
        return len(s1)
    prev = list(range(len(s2) + 1))
    curr = [0] * (len(s2) + 1)
    for i, c1 in enumerate(s1):
        curr[0] = i + 1
        for j, c2 in enumerate(s2):
            cost = 0 if c1 == c2 else 1
            curr[j + 1] = min(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost)
        prev = list(curr)
    return prev[len(s2)]


def string_similarity(a: str, b: str) -> float:
    s1 = (a or "").lower().strip()
    s2 = (b or "").lower().strip()
    if not s1 and not s2:
        return 1.0
    if not s1 or not s2:
        return 0.0
    if s1 == s2:
        return 1.0
    max_len = max(len(s1), len(s2))
    dist = levenshtein_distance(s1, s2)
    return max(0.0, 1.0 - dist / max_len)


def extract_keywords(text: str) -> list[str]:
    if not text:
        return []
    stripped = re.sub(r"\.[a-z0-9]{1,8}$", "", text, flags=re.IGNORECASE)
    raw_tokens = [t for t in re.split(r"[^a-z0-9]+", stripped.lower()) if len(t) >= 2]
    words = [t for t in raw_tokens if not re.fullmatch(r"\d{4,8}", t)]
    return words if words else raw_tokens


def matches_glob(pattern: str, text: str) -> bool:
    if not pattern or not text:
        return False
    escaped = re.sub(r"[.+^${}()|[\]\\]", r"\\\g<0>", pattern.lower())
    regex_str = "^" + escaped.replace("*", ".*").replace("?", ".") + "$"
    try:
        return bool(re.match(regex_str, text.lower(), flags=re.IGNORECASE))
    except re.error:
        return False


def suggest_password_profiles(
    query: dict,
    profiles: list[dict],
) -> list[dict]:
    if not profiles:
        return []
    filename = str(query.get("filename") or "").strip()
    title = str(query.get("title") or "").strip()
    correspondent = str(query.get("correspondent") or "").strip()
    message = str(query.get("message") or "").strip()

    query_combined = " ".join(part for part in (filename, title, correspondent, message) if part)
    query_tokens = extract_keywords(query_combined)

    results: list[dict] = []
    for profile in profiles:
        score = 0
        reasons: list[str] = []
        patterns = profile.get("patterns") or []
        target_name = filename or title
        if patterns and target_name:
            for pat in patterns:
                if matches_glob(str(pat), filename) or (title and matches_glob(str(pat), title)):
                    score += 50
                    reasons.append(f'Pattern match: "{pat}"')
                    break

        profile_tokens = extract_keywords(str(profile.get("label") or "")) + extract_keywords(
            str(profile.get("profile_id") or "")
        )
        best_similarity = 0.0
        matched_token_pair = ""

        for q_token in query_tokens:
            for p_token in profile_tokens:
                if q_token == p_token:
                    best_similarity = 1.0
                    matched_token_pair = f'Exact word match "{q_token}"'
                    break
                if q_token in p_token or p_token in q_token:
                    sub_sim = 0.85
                    if sub_sim > best_similarity:
                        best_similarity = sub_sim
                        matched_token_pair = f'Partial match "{q_token}" ~ "{p_token}"'
                sim = string_similarity(q_token, p_token)
                if sim > best_similarity and sim >= 0.7:
                    best_similarity = sim
                    matched_token_pair = f'Similar word "{q_token}" ~ "{p_token}" ({round(sim * 100)}%)'
            if best_similarity == 1.0:
                break

        if best_similarity > 0:
            score += round(best_similarity * 40)
            reasons.append(matched_token_pair)

        stem = re.sub(r"\.[^.]+$", "", filename) if filename else ""
        label_str = str(profile.get("label") or "")
        full_sim = max(
            string_similarity(stem, label_str) if stem else 0.0,
            string_similarity(title, label_str) if title else 0.0,
            string_similarity(correspondent, label_str) if correspondent else 0.0,
        )
        if full_sim >= 0.7 and not any(r.startswith("Full name") for r in reasons):
            label_score = round(full_sim * 20)
            score = max(score, label_score + 20)
            reasons.append(f"Full name similarity ({round(full_sim * 100)}%)")

        desc_text = f"{profile.get('description') or ''} {profile.get('hint') or ''}".strip()
        if desc_text:
            desc_tokens = extract_keywords(desc_text)
            common_desc = [
                t for t in query_tokens if t in desc_tokens and t not in profile_tokens
            ]
            if common_desc:
                score += min(20, len(common_desc) * 10)
                joined = '", "'.join(common_desc[:2])
                reasons.append(f'Context match in description: "{joined}"')

        final_score = min(100, max(0, score))
        if final_score > 0:
            item = {
                "profile_id": profile["profile_id"],
                "label": profile["label"],
                "score": final_score,
                "match_reasons": reasons,
                "profile": profile,
            }
            if profile.get("description"):
                item["description"] = profile["description"]
            if profile.get("hint"):
                item["hint"] = profile["hint"]
            if profile.get("patterns"):
                item["patterns"] = profile["patterns"]
            results.append(item)

    results.sort(key=lambda x: (-x["score"], str(x["profile"].get("label") or "")))
    return results


class PasswordProfiles:
    def __init__(self, root: Path):
        self.vault_root = _resolve_vault_root(root)
        self.vault_root.mkdir(parents=True, exist_ok=True)
        self.path = self.vault_root / "document-passwords.toml"
        self.lock_path = self.vault_root / "document-passwords.lock"
        self._migrate_legacy(root)

    def _migrate_legacy(self, candidate_root: Path) -> None:
        if self.path.exists():
            return
        legacy_candidates = [
            candidate_root.expanduser().resolve() / "sources" / "document-passwords.toml",
        ]
        env_workspace = os.environ.get("OPENLIA_WORKSPACE_ROOT")
        if env_workspace:
            legacy_candidates.append(Path(env_workspace).expanduser().resolve() / "sources" / "document-passwords.toml")
        for legacy in legacy_candidates:
            if legacy.exists() and legacy != self.path:
                try:
                    self._atomic_write(legacy.read_bytes())
                    break
                except OSError:
                    pass

    def _read(self) -> dict:
        if not self.path.exists():
            return {"version": 1, "profiles": {}}
        try:
            data = tomllib.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
            raise PasswordProfileError(f"password profile file is invalid: {exc}") from exc
        profiles = data.get("profiles", {})
        if not isinstance(profiles, dict):
            raise PasswordProfileError("password profiles must be a TOML table")
        return {"version": 1, "profiles": profiles}

    def save(
        self,
        profile_id: str,
        label: str,
        password: str | None = None,
        description: str | None = None,
        hint: str | None = None,
        patterns: list[str] | None = None,
    ) -> dict:
        if not isinstance(profile_id, str) or not PROFILE_RE.fullmatch(profile_id):
            raise PasswordProfileError("profile_id must be a safe identifier")
        if not isinstance(label, str) or not label.strip() or FORBIDDEN_LABEL.search(label):
            raise PasswordProfileError("profile label is empty or names a service credential")
        with self._locked():
            data = self._read()
            profiles = data["profiles"]
            existing = profiles.get(profile_id)
            effective_password = password
            if not effective_password:
                if existing and isinstance(existing.get("password"), str) and existing["password"]:
                    effective_password = existing["password"]
                else:
                    raise PasswordProfileError("document password must not be empty")
            entry: dict = {"label": label.strip(), "password": effective_password}
            if description is not None:
                if isinstance(description, str) and description.strip():
                    entry["description"] = description.strip()
            elif existing and existing.get("description"):
                entry["description"] = existing["description"]

            if hint is not None:
                if isinstance(hint, str) and hint.strip():
                    entry["hint"] = hint.strip()
            elif existing and existing.get("hint"):
                entry["hint"] = existing["hint"]

            if patterns is not None:
                if isinstance(patterns, (list, tuple)):
                    cleaned_patterns = [p.strip() for p in patterns if isinstance(p, str) and p.strip()]
                    if cleaned_patterns:
                        entry["patterns"] = cleaned_patterns
            elif existing and existing.get("patterns"):
                entry["patterns"] = existing["patterns"]

            profiles[profile_id] = entry
            lines = ["version = 1", ""]
            for key in sorted(profiles):
                profile = profiles[key]
                lines.append(f"[profiles.{key}]")
                lines.append(f"label = {json.dumps(profile['label'], ensure_ascii=True)}")
                lines.append(f"password = {json.dumps(profile['password'], ensure_ascii=True)}")
                if profile.get("description"):
                    lines.append(f"description = {json.dumps(profile['description'], ensure_ascii=True)}")
                if profile.get("hint"):
                    lines.append(f"hint = {json.dumps(profile['hint'], ensure_ascii=True)}")
                if profile.get("patterns"):
                    lines.append(f"patterns = {json.dumps(profile['patterns'], ensure_ascii=True)}")
                lines.append("")
            self._atomic_write("\n".join(lines).encode("utf-8"))
        res = {"profile_id": profile_id, "label": label.strip(), "updated": True}
        if entry.get("description"):
            res["description"] = entry["description"]
        if entry.get("hint"):
            res["hint"] = entry["hint"]
        if entry.get("patterns"):
            res["patterns"] = entry["patterns"]
        return res

    def delete(self, profile_id: str) -> bool:
        if not isinstance(profile_id, str) or not PROFILE_RE.fullmatch(profile_id):
            raise PasswordProfileError("invalid password profile")
        with self._locked():
            data = self._read()
            profiles = data["profiles"]
            if profile_id not in profiles:
                return False
            del profiles[profile_id]
            lines = ["version = 1", ""]
            for key in sorted(profiles):
                profile = profiles[key]
                lines.append(f"[profiles.{key}]")
                lines.append(f"label = {json.dumps(profile['label'], ensure_ascii=True)}")
                lines.append(f"password = {json.dumps(profile['password'], ensure_ascii=True)}")
                if profile.get("description"):
                    lines.append(f"description = {json.dumps(profile['description'], ensure_ascii=True)}")
                if profile.get("hint"):
                    lines.append(f"hint = {json.dumps(profile['hint'], ensure_ascii=True)}")
                if profile.get("patterns"):
                    lines.append(f"patterns = {json.dumps(profile['patterns'], ensure_ascii=True)}")
                lines.append("")
            self._atomic_write("\n".join(lines).encode("utf-8"))
        return True

    def list(self) -> list[dict]:
        with self._locked():
            data = self._read()
        result = []
        for profile_id, profile in sorted(data["profiles"].items()):
            if isinstance(profile, dict) and isinstance(profile.get("label"), str):
                item = {"profile_id": profile_id, "label": profile["label"]}
                if profile.get("description"):
                    item["description"] = profile["description"]
                if profile.get("hint"):
                    item["hint"] = profile["hint"]
                if profile.get("patterns"):
                    item["patterns"] = profile["patterns"]
                result.append(item)
        return result

    def suggest(
        self,
        *,
        filename: str | None = None,
        title: str | None = None,
        correspondent: str | None = None,
        message: str | None = None,
    ) -> list[dict]:
        profiles = self.list()
        return suggest_password_profiles(
            {
                "filename": filename or "",
                "title": title or "",
                "correspondent": correspondent or "",
                "message": message or "",
            },
            profiles,
        )

    def resolve(self, profile_id: str) -> str:
        if not isinstance(profile_id, str) or not PROFILE_RE.fullmatch(profile_id):
            raise PasswordProfileError("invalid password profile")
        with self._locked():
            profile = self._read()["profiles"].get(profile_id)
        if not isinstance(profile, dict) or not isinstance(profile.get("password"), str):
            raise PasswordProfileError("password profile was not found")
        return profile["password"]

    def _atomic_write(self, data: bytes) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".document-passwords.", dir=self.path.parent)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            os.chmod(self.path, 0o600)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @contextmanager
    def _locked(self):
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+b") as lock:
            os.chmod(self.lock_path, 0o600)
            try:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            except (ImportError, OSError):
                pass
            try:
                yield
            finally:
                try:
                    import fcntl
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
                except (ImportError, OSError):
                    pass

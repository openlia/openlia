#!/usr/bin/env python3
"""Build the checksum-pinned upstream Remind CLI, never a distro Remind package.

Only Python's standard library, a C compiler, make, libc and libm are required.
The installed tree includes exact corresponding source, license and build script.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


def load_pin(manifest: Path) -> dict:
    pin = json.loads(manifest.read_text())["remind"]
    version = pin.get("version", "")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Remind version must be an exact release")
    if pin.get("source_url") != f"https://dianne.skoll.ca/projects/remind/download/remind-{version}.tar.gz":
        raise ValueError("Remind must use its versioned upstream HTTPS source URL")
    if not re.fullmatch(r"[0-9a-f]{64}", pin.get("source_sha256", "")):
        raise ValueError("Remind source SHA-256 is required")
    return pin


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def extract_source(archive: Path, destination: Path, pin: dict) -> Path:
    if digest(archive) != pin["source_sha256"]:
        raise ValueError("Remind source SHA-256 mismatch; nothing was extracted or executed")
    expected = f"remind-{pin['version']}"
    aliases = []
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != expected:
                raise ValueError(f"unsafe source archive path: {member.name}")
            target = destination.joinpath(*path.parts)
            if member.issym() and member.name == f"{expected}/include/holidays/uk" and member.linkname == "gb":
                # Materialize the one upstream holiday alias as ordinary data;
                # no archive-provided symlink can redirect subsequent extraction.
                aliases.append(target)
                continue
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                if source is None:
                    raise ValueError("missing archive file contents")
                with source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode & 0o755)
            else:
                raise ValueError(f"unsupported archive link/special file: {member.name}")
    for alias in aliases:
        source = alias.with_name("gb")
        if source.is_dir():
            shutil.copytree(source, alias)
        else:
            shutil.copyfile(source, alias)
    return destination / expected


def verify_binary(binary: Path, version: str) -> dict:
    observed = subprocess.check_output([str(binary), "--version"], text=True, timeout=10).strip()
    if observed != version:
        raise ValueError(f"Remind version mismatch: expected {version}, got {observed!r}")
    with tempfile.TemporaryDirectory(prefix="remind-pin-check-") as temp:
        root = Path(temp)
        root.joinpath("calendar.rem").write_text('REM 2026-10-28 AT 02:00 DURATION 90 NOQUEUE TAG openlia-pin-check INFO "Timezone: Asia/Ho_Chi_Minh" INFO "Description: pinned roundtrip" MSG pinned-remind-test\n')
        result = subprocess.run([str(binary), "-r", "-q", "-o", "-b2", "-ppp1", "calendar.rem", "2026-10-01"], cwd=root, env={**os.environ, "TZ": "UTC", "HOME": temp, "LANG": "C.UTF-8"}, capture_output=True, text=True, timeout=10, check=True)
        if result.stderr.strip():
            raise ValueError("Remind smoke test reported native diagnostics")
        entries = [entry for month in json.loads(result.stdout) for entry in month["entries"]]
        if not any(e.get("body") == "pinned-remind-test" and e.get("noqueue") and e.get("duration") == 90 and e.get("info", {}).get("timezone") == "Asia/Ho_Chi_Minh" for e in entries):
            raise ValueError("Remind JSON/NOQUEUE/metadata round-trip smoke test failed")
    return {"version": observed, "binary_sha256": digest(binary), "json_noqueue_smoke": "passed"}


def install(manifest: Path, prefix: Path, archive: Path | None = None, jobs: int = 2) -> dict:
    pin = load_pin(manifest)
    prefix = Path(os.path.abspath(prefix))
    if prefix in (Path("/"), Path("/usr"), Path("/usr/local")) or any(c.isspace() for c in str(prefix)):
        raise ValueError("choose a dedicated versioned installation prefix without whitespace")
    if prefix.exists() or prefix.is_symlink():
        info_path = prefix / "share/openlia/sources/remind/build-info.json"
        if prefix.is_symlink() or not info_path.is_file():
            raise ValueError("existing installation prefix is not managed; refusing to overwrite it")
        info = json.loads(info_path.read_text())
        source_archive = prefix / "share/openlia/sources/remind" / f"remind-{pin['version']}.tar.gz"
        if info.get("pin") != pin or info.get("binary_sha256") != digest(prefix / "bin/remind") or digest(source_archive) != pin["source_sha256"]:
            raise ValueError("existing Remind installation is different or corrupt; use a fresh prefix")
        if not (prefix / "share/licenses/remind/COPYRIGHT").is_file():
            raise ValueError("existing Remind installation is missing its license bundle")
        return {**verify_binary(prefix / "bin/remind", pin["version"]), "prefix": str(prefix), "source_sha256": pin["source_sha256"]}
    prefix.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".remind-build-", dir=prefix.parent) as temp:
        work = Path(temp)
        source_archive = work / "source.tar.gz"
        if archive:
            shutil.copyfile(archive, source_archive)
        else:
            with urllib.request.urlopen(pin["source_url"], timeout=60) as response, source_archive.open("wb") as output:
                shutil.copyfileobj(response, output)
        source = extract_source(source_archive, work, pin)
        # Do not auto-link a platform-specific optional Readline dependency.
        overrides = {"ac_cv_lib_readline_readline": "no", "ac_cv_func_readline": "no", "ac_cv_header_readline_readline_h": "no", "ac_cv_header_readline_history_h": "no"}
        env = {**os.environ, **overrides}
        subprocess.run(["./configure", f"--prefix={prefix}"], cwd=source, env=env, check=True)
        subprocess.run(["make", "-C", "src", f"-j{jobs}", "remind"], cwd=source, env=env, check=True)
        verified = verify_binary(source / "src/remind", pin["version"])
        stage = work / "install"
        (stage / "bin").mkdir(parents=True)
        shutil.copyfile(source / "src/remind", stage / "bin/remind")
        (stage / "bin/remind").chmod(0o755)
        shutil.copytree(source / "include", stage / "share/remind")
        licenses = stage / "share/licenses/remind"
        licenses.mkdir(parents=True)
        shutil.copyfile(source / "COPYRIGHT", licenses / "COPYRIGHT")
        corresponding = stage / "share/openlia/sources/remind"
        corresponding.mkdir(parents=True)
        shutil.copyfile(source_archive, corresponding / f"remind-{pin['version']}.tar.gz")
        shutil.copyfile(Path(__file__), corresponding / "install-remind.py")
        (corresponding / "release-manifest.json").write_text(json.dumps({"remind": pin}, indent=2) + "\n")
        info = {**verified, "pin": pin, "platform": platform.system(), "architecture": platform.machine(), "compiler_environment": {key: env[key] for key in ("CC", "CFLAGS", "CPPFLAGS", "LDFLAGS", "LIBS") if key in env}, "configure_overrides": overrides, "configure": ["./configure", f"--prefix={prefix}"], "build": ["make", "-C", "src", f"-j{jobs}", "remind"]}
        (corresponding / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")
        # Reserve exclusively; POSIX rename could otherwise replace an empty
        # directory created by somebody else while the build was running.
        prefix.mkdir(mode=0o755)
        for entry in stage.iterdir():
            entry.rename(prefix / entry.name)
    return {**verified, "prefix": str(prefix), "source_sha256": pin["source_sha256"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path(__file__).resolve().parents[1] / "release/manifest.json")
    parser.add_argument("--prefix", type=Path, required=True)
    parser.add_argument("--archive", type=Path, help="optional offline source archive, still checksum-verified")
    parser.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    print(json.dumps(install(args.manifest, args.prefix, args.archive, args.jobs), indent=2))


if __name__ == "__main__":
    main()

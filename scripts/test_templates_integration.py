#!/usr/bin/env python3
"""Test the runtime and a templates checkout together without touching user data."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "packages/workspace-ui"


def checkout_identity(root: Path) -> dict:
    def git(*args: str) -> bytes:
        return subprocess.check_output(["git", "-C", str(root), *args], env=child_environment())

    digest = hashlib.sha256()
    paths = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split(b"\0")
    for raw in sorted(set(paths) - {b""}):
        path = root / os.fsdecode(raw)
        digest.update(raw + b"\0")
        if path.is_symlink():
            digest.update(b"link\0" + os.fsencode(os.readlink(path)))
        elif path.is_file():
            digest.update(b"file\0" + path.read_bytes())
        else:
            digest.update(b"missing\0")
        digest.update(b"\0")
    return {
        "revision": git("rev-parse", "HEAD").decode().strip(),
        "dirty": bool(git("status", "--porcelain", "--untracked-files=normal").strip()),
        "working_tree_sha256": digest.hexdigest(),
    }


def child_environment() -> dict[str, str]:
    # Never accidentally point tests at a developer's configured deployment.
    excluded = ("OPENLIA_", "HERMES_", "LOCHO_", "VITE_", "WORKSPACE_UI_", "GIT_", "AWS_", "AZURE_", "GOOGLE_", "OPENAI_", "ANTHROPIC_")
    return {
        key: value for key, value in os.environ.items()
        if not key.startswith(excluded)
        and not any(word in key for word in ("TOKEN", "SECRET", "API_KEY", "PASSWORD", "CREDENTIAL"))
        and key not in ("SSH_AUTH_SOCK", "SSH_AGENT_PID")
    }


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--templates-root", required=True, type=Path)
    parser.add_argument("--skip-browser", action="store_true", help="explicitly run contract checks only, not UI acceptance")
    parser.add_argument("--docker", action="store_true", help="also verify sync/recreate against an isolated Docker bind-mount consumer")
    parser.add_argument("--remind-binary", type=Path, help="native Remind binary used only by the isolated test server")
    parser.add_argument("--report", type=Path, default=ROOT / ".artifacts/templates-integration/report.json")
    args = parser.parse_args(argv)
    templates = args.templates_root.resolve()
    report = {"schema": 1, "mode": "contract-only" if args.skip_browser else "full", "status": "failed", "checks": [], "browser_acceptance": "not-run"}
    environment = child_environment()

    def run(label: str, command: list[str], *, cwd: Path = ROOT, env: dict | None = None) -> None:
        print(f"\n[{label}]", flush=True)
        subprocess.run(command, cwd=cwd, env=env or environment, check=True)
        report["checks"].append(label)

    try:
        report["runtime"] = checkout_identity(ROOT)
        report["templates"] = checkout_identity(templates)
        manifest = json.loads((ROOT / "release/manifest.json").read_text())
        report["release_catalog_pin"] = manifest["templates"]
        for tool in ("git", "go", "bun"):
            if not shutil.which(tool):
                raise RuntimeError(f"Missing {tool}; install integration prerequisites first")
        remind = str(args.remind_binary.resolve()) if args.remind_binary else shutil.which("remind")
        if not args.skip_browser and not remind:
            raise RuntimeError("Native Remind is required for Calendar acceptance. Install remind, pass --remind-binary PATH, or explicitly use --skip-browser for contract-only checks.")
        if remind:
            installer = runpy.run_path(str(ROOT / "docker/install-remind.py"))
            binary = Path(remind).resolve()
            verified = installer["verify_binary"](binary, manifest["remind"]["version"])
            report["remind"] = {**verified, "binary": str(binary), "source_pin": manifest["remind"], "corresponding_source_verified": False}
            source = binary.parent.parent / "share/openlia/sources/remind" / f"remind-{verified['version']}.tar.gz"
            if source.is_file():
                if installer["digest"](source) != manifest["remind"]["source_sha256"]:
                    raise RuntimeError("Installed Remind corresponding source does not match the release pin")
                report["remind"]["corresponding_source_verified"] = True
        with tempfile.TemporaryDirectory(prefix="openlia-templates-integration-") as temp:
            scratch = Path(temp)
            snapshot = scratch / "templates"
            # Even old catalog validators run against a copy, never the author's checkout.
            shutil.copytree(templates, snapshot, ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc", ".DS_Store"), symlinks=True)
            if checkout_identity(templates) != report["templates"]:
                raise RuntimeError("Templates changed while creating the test snapshot; rerun on stable working trees")
            for path in snapshot.rglob("*"):
                if path.is_symlink():
                    raise RuntimeError(f"Catalog symlinks are not supported: {path.relative_to(snapshot)}")
            run("catalog validation", [sys.executable, str(snapshot / "scripts/validate_catalog.py"), "--no-self-test"])
            catalog = runpy.run_path(str(snapshot / "scripts/validate_catalog.py"))
            if json.loads((snapshot / "catalog.json").read_text()) != catalog["build_catalog"]():
                raise RuntimeError("catalog.json is stale; regenerate deliberately and review the diff")
            go_report = scratch / "go-catalog-checks.json"
            go_env = {**environment, "OPENLIA_INTEGRATION_TEMPLATES_ROOT": str(snapshot), "OPENLIA_INTEGRATION_GO_REPORT": str(go_report)}
            if args.docker:
                go_env["OPENLIA_INTEGRATION_DOCKER"] = "true"
            run("real Go catalog sync/install/profile/package/import and regressions", ["go", "test", "./operator", "-run", "TestCompatibility|TestRuntimeMeetsMinimum|TestParseOpenLiaRequirement|TestTemplates|TestRealTemplatesCatalogIntegration", "-count=1"], env=go_env)
            report["go_catalog"] = json.loads(go_report.read_text())
            if remind:
                run("native Calendar server regression tests", ["bun", "test", "src/server/calendar.test.ts"], cwd=UI, env={**environment, "OPENLIA_REMIND_BINARY": remind})
            report["docker_bind_mounts"] = "passed with isolated pinned Alpine container" if args.docker else "not-run (opt in with --docker)"
            sandbox = scratch / "installed"
            run("real catalog installation and inline Markdown OpenUI diagnostics", ["bun", "scripts/check-templates.ts", str(snapshot), str(sandbox)], cwd=UI)
            report["catalog"] = json.loads((sandbox / "catalog-checks.json").read_text())
            calendar = sandbox / "install-calendar/workspace"
            run("installed Calendar workspace validation", [sys.executable, str(ROOT / "profile/system-skills/workspace-template-customization/scripts/validate_workspace.py"), "--workspace-root", str(calendar)])
            if args.skip_browser:
                report["browser_acceptance"] = "skipped explicitly; not UI acceptance evidence"
            else:
                run("production Workspace UI build", ["bun", "run", "build"], cwd=UI)
                browser_env = {
                    **environment,
                    "OPENLIA_INTEGRATION_WORKSPACE": str(calendar),
                    "OPENLIA_INTEGRATION_STATE": str(scratch / "browser-state"),
                    "OPENLIA_REMIND_BINARY": remind,
                    "OPENLIA_WORKSPACE_UI_PORT": str(free_port()),
                    "WORKSPACE_UI_E2E_MODE": "real",
                }
                run("Calendar desktop/mobile real-backend acceptance", ["bunx", "--no-install", "playwright", "test", "--config", "playwright.templates.config.ts"], cwd=UI, env=browser_env)
                report["browser_acceptance"] = "passed desktop and mobile with native Remind and actual catalog composition"
        if checkout_identity(ROOT) != report["runtime"] or checkout_identity(templates) != report["templates"]:
            raise RuntimeError("Sources changed during integration; rerun on stable working trees")
        report["status"] = "passed"
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        report["error"] = str(exc)
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
        print(f"\nIntegration report: {args.report}")
        if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(summary, "a", encoding="utf-8") as output:
                output.write("## Runtime/templates integration\n\n")
                for name in ("runtime", "templates"):
                    identity = report.get(name, {})
                    output.write(f"- {name}: `{identity.get('revision', 'unknown')}`; dirty: `{identity.get('dirty', 'unknown')}`\n")
                output.write(f"- Result: **{report['status']}**\n- Browser: {report['browser_acceptance']}\n")


if __name__ == "__main__":
    raise SystemExit(main())

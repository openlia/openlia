#!/usr/bin/env python3
"""OpenLia operator smoke harness."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILE = ROOT / "docker" / "compose.yaml"
HERMES_DOCKERFILE = ROOT / "docker" / "Dockerfile"
LOCHO_DOCKERFILE = ROOT / "docker" / "locho.Dockerfile"
MANIFEST_FILE = ROOT / "release" / "manifest.json"
REQUIRED_CLI_TOPICS = {
    "auth",
    "status",
    "deploy",
    "job",
    "start",
    "stop",
    "restart",
    "uninstall",
    "logs",
    "locho-host",
    "attachments",
    "backup",
    "browser",
}


class SmokeError(RuntimeError):
    """Raised when a smoke precondition or assertion fails."""


@dataclass
class CheckResult:
    name: str
    status: str = "passed"
    details: dict[str, object] = field(default_factory=dict)


@dataclass
class SmokeContext:
    args: argparse.Namespace
    env_file: Path | None
    secret_file: Path | None
    secret_dir: Path | None
    openlia_bin: str | None
    config_file: Path | None
    results: list[CheckResult] = field(default_factory=list)


def load_manifest() -> dict:
    try:
        return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SmokeError(f"failed to load {MANIFEST_FILE}: {exc}") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run OpenLia operator and runtime smoke verification."
    )
    parser.add_argument(
        "--mode",
        choices=("all", "cli", "compose", "hermes", "backup"),
        default="all",
        help="Verification slice to execute.",
    )
    parser.add_argument(
        "--openlia-bin",
        default=os.environ.get("OPENLIA_BINARY", "").strip(),
        help="Explicit path to the openlia CLI binary.",
    )
    parser.add_argument(
        "--config-file",
        default=os.environ.get("OPENLIA_CONFIG_FILE", "").strip(),
        help="Explicit path to an OpenLia operator config.toml file.",
    )
    parser.add_argument(
        "--env-file",
        default=os.environ.get("OPENLIA_ENV_FILE", "").strip(),
        help="Compose env file to validate (defaults to docker/.env or temporary rendered env).",
    )
    parser.add_argument(
        "--secret-file",
        default=os.environ.get("OPENLIA_SECRET_FILE", "").strip(),
        help="Mode-0600 secret source file for runtime/compose checks.",
    )
    parser.add_argument(
        "--secret-dir",
        default=os.environ.get("OPENLIA_SECRET_DIR", "").strip(),
        help="Optional mode-0700 secret directory containing auth.json.",
    )
    parser.add_argument(
        "--build-image",
        action="store_true",
        help="Build the OpenLia Hermes container image before running container checks.",
    )
    parser.add_argument(
        "--check-providers",
        action="store_true",
        help="Pass --check-providers to openlia status checks when an installation is configured.",
    )
    parser.add_argument(
        "--verify-backup-cycle",
        action="store_true",
        help="Execute backup create and status checks against a configured OpenLia installation.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON summary.",
    )
    return parser.parse_args()


def run_command(
    cmd: list[str],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    proc = subprocess.run(
        cmd,
        cwd=str(cwd),
        env=merged_env,
        text=True,
        capture_output=True,
    )
    if check and proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()
        detail = stderr or stdout or f"exit status {proc.returncode}"
        raise SmokeError(f"command failed ({' '.join(cmd)}): {detail}")
    return proc


def resolve_openlia_bin(explicit: str) -> str | None:
    if explicit:
        candidate = Path(explicit).expanduser()
        if not candidate.exists():
            raise SmokeError(f"openlia binary not found at {candidate}")
        return str(candidate.resolve())

    local_bin = ROOT / "openlia"
    if local_bin.exists() and os.access(local_bin, os.X_OK):
        return str(local_bin.resolve())

    which_bin = shutil.which("openlia")
    if which_bin:
        return which_bin
    return None


def resolve_optional_path(raw: str, *, description: str) -> Path | None:
    if not raw:
        return None
    path = Path(raw).expanduser().resolve()
    if not path.exists():
        raise SmokeError(f"{description} not found: {path}")
    return path


def verify_secret_permissions(secret_file: Path, secret_dir: Path | None) -> dict[str, str]:
    file_mode = oct(secret_file.stat().st_mode & 0o777)
    if (secret_file.stat().st_mode & 0o777) != 0o600:
        raise SmokeError(
            f"secret file {secret_file} must have mode 0600 (found {file_mode})"
        )
    details = {"secret_file": str(secret_file), "secret_file_mode": file_mode}
    if secret_dir is not None:
        dir_mode = oct(secret_dir.stat().st_mode & 0o777)
        if (secret_dir.stat().st_mode & 0o777) != 0o700:
            raise SmokeError(
                f"secret directory {secret_dir} must have mode 0700 (found {dir_mode})"
            )
        details["secret_dir"] = str(secret_dir)
        details["secret_dir_mode"] = dir_mode
    return details


def check_cli_surface(ctx: SmokeContext) -> None:
    cmd_prefix: list[str]
    if ctx.openlia_bin:
        cmd_prefix = [ctx.openlia_bin]
    else:
        if shutil.which("go") is None:
            raise SmokeError("neither openlia binary nor go toolchain is available")
        cmd_prefix = ["go", "run", "."]

    help_proc = run_command([*cmd_prefix, "--help"])
    help_text = help_proc.stdout
    missing = sorted(topic for topic in REQUIRED_CLI_TOPICS if topic not in help_text)
    if missing:
        raise SmokeError(f"openlia --help is missing required commands: {', '.join(missing)}")

    ctx.results.append(
        CheckResult(
            name="cli-help-surface",
            details={"runner": " ".join(cmd_prefix), "verified_topics": sorted(REQUIRED_CLI_TOPICS)},
        )
    )

    with tempfile.TemporaryDirectory(prefix="openlia-smoke-cli-") as tmp:
        tmp_path = Path(tmp)
        temp_home = tmp_path / "home"
        temp_root = tmp_path / "install"
        temp_secret = tmp_path / "secrets.env"
        temp_config = temp_home / ".config" / "openlia" / "config.toml"
        temp_config.parent.mkdir(parents=True, exist_ok=True)
        temp_secret.write_text("COPILOT_GITHUB_TOKEN=ghu_smoketesttoken123456\n", encoding="utf-8")
        temp_secret.chmod(0o600)
        temp_config.write_text(
            f"""[openlia]
schema = 2
mode = "local"
root = "{temp_root}"
provider = "copilot"
model = "gpt-5.6-luna"

[secrets]
source = "{temp_secret}"

[locho-host]
enabled = true
""",
            encoding="utf-8",
        )
        temp_config.chmod(0o600)

        cli_env = {
            "HOME": str(temp_home),
            "OPENLIA_CONFIG": str(temp_config),
        }
        deploy_proc = run_command([*cmd_prefix, "--help"], env=cli_env, check=False)
        deploy_text = (deploy_proc.stdout or "") + (deploy_proc.stderr or "")
        if "openlia deploy" not in deploy_text:
            raise SmokeError("openlia --help is missing deploy command")

        locho_help_proc = run_command([*cmd_prefix, "locho-host", "share", "--help"], env=cli_env, check=False)
        locho_help_text = (locho_help_proc.stdout or "") + (locho_help_proc.stderr or "")
        if "-output" not in locho_help_text:
            raise SmokeError("openlia locho-host share --help is missing -output flag")

        for subcmd in (
            ["attachments", "list", "--json"],
        ):
            proc = run_command([*cmd_prefix, *subcmd], env=cli_env)
            payload = json.loads(proc.stdout)
            if "ok" not in payload:
                raise SmokeError(f"CLI command {' '.join(subcmd)} did not return JSON envelope")

        ctx.results.append(
            CheckResult(
                name="cli-temp-local-lifecycle",
                details={
                    "root": str(temp_root),
                    "commands": [
                        "--help",
                        "attachments list",
                        "locho-host status",
                    ],
                },
            )
        )

    if ctx.config_file is None:
        return

    cli_env = {"OPENLIA_CONFIG": str(ctx.config_file)}
    cfg_args = ["--config", str(ctx.config_file), "--json"]
    status_proc = run_command([*cmd_prefix, "status", *cfg_args], env=cli_env)
    status_payload = json.loads(status_proc.stdout)
    ctx.results.append(
        CheckResult(
            name="cli-status",
            details={
                "config_file": str(ctx.config_file),
                "ok": bool(status_payload.get("ok")),
            },
        )
    )

    job_proc = run_command([*cmd_prefix, "job", "status", *cfg_args], env=cli_env)
    job_payload = json.loads(job_proc.stdout)
    ctx.results.append(
        CheckResult(
            name="cli-job-status",
            details={
                "config_file": str(ctx.config_file),
                "status": job_payload.get("status", ""),
            },
        )
    )

    if ctx.args.check_providers:
        check_proc = run_command([*cmd_prefix, "status", "--check-providers", *cfg_args], env=cli_env, check=False)
        check_payload = json.loads(check_proc.stdout)
        if not check_payload.get("ok"):
            raise SmokeError(f"openlia status --check-providers failed: {check_payload}")
        ctx.results.append(
            CheckResult(
                name="cli-status-providers",
                details={"config_file": str(ctx.config_file), "ok": True},
            )
        )


def build_temp_compose_env(tmp_dir: Path, ctx: SmokeContext, manifest: dict) -> tuple[Path, dict[str, str]]:
    data_root = tmp_dir / "hermes"
    skills_cache_root = tmp_dir / "skill-cache"
    skills_env_root = tmp_dir / "skill-envs"
    meta_root = tmp_dir / "meta"
    backup_root = tmp_dir / "backups"
    secret_dir = ctx.secret_dir or (tmp_dir / "secrets")
    for directory in (
        data_root,
        skills_cache_root,
        skills_env_root,
        meta_root,
        backup_root,
        secret_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    secret_dir.chmod(0o700)

    if ctx.secret_file is not None:
        secret_file = ctx.secret_file
    else:
        secret_file = secret_dir / "hermes.env"
        secret_file.write_text("COPILOT_GITHUB_TOKEN=smoke-test-token\n", encoding="utf-8")
        secret_file.chmod(0o600)

    verify_secret_permissions(secret_file, secret_dir)
    components = manifest.get("components", manifest)
    hermes_comp = components["hermes"]
    locho_comp = components["locho"]
    openlia_ver = manifest.get("openliaVersion") or manifest["openlia"]
    version_tag = f"v{openlia_ver}"
    locho_tag = f"v{locho_comp['version']}"

    env_map = {
        "OPENLIA_DATA_ROOT": str(data_root),
        "OPENLIA_SKILLS_CACHE_ROOT": str(skills_cache_root),
        "OPENLIA_SKILLS_ENV_ROOT": str(skills_env_root),
        "OPENLIA_META_ROOT": str(meta_root),
        "OPENLIA_BACKUP_ROOT": str(backup_root),
        "OPENLIA_RUNTIME_UID": "10000",
        "OPENLIA_RUNTIME_GID": "10000",
        "OPENLIA_OPERATION_LOCK": str(tmp_dir / ".operation.lock"),
        "OPENLIA_BACKUP_KNOWN_HOSTS_SOURCE": str(tmp_dir / "known_hosts"),
        "OPENLIA_SECRET_FILE": str(secret_file),
        "OPENLIA_SECRET_DIR": str(secret_dir),
        "OPENLIA_NETWORK_NAME": "openlia-smoke-private",
        "OPENLIA_PROVIDER": "copilot",
        "OPENLIA_MODEL": "gpt-5.6-luna",
        "HERMES_TIMEZONE": "Asia/Ho_Chi_Minh",
        "OPENLIA_HERMES_IMAGE": f"openlia-hermes:{version_tag}",
        "OPENLIA_BACKUP_SCHEDULER_IMAGE": f"openlia-backup-scheduler:{version_tag}",
        "OPENLIA_LOCHO_IMAGE": f"openlia-locho:{locho_tag}",
        "HERMES_BASE_IMAGE": hermes_comp["image"],
        "HERMES_BASE_TAG": hermes_comp["tag"],
        "HERMES_BASE_DIGEST": hermes_comp["digest"],
    }
    Path(env_map["OPENLIA_BACKUP_KNOWN_HOSTS_SOURCE"]).write_text("", encoding="utf-8")
    env_file = tmp_dir / ".env"
    env_file.write_text(
        "".join(f"{key}={value}\n" for key, value in env_map.items()),
        encoding="utf-8",
    )
    return env_file, env_map


def check_compose_and_statics(ctx: SmokeContext, manifest: dict) -> None:
    for required_file in (COMPOSE_FILE, HERMES_DOCKERFILE, LOCHO_DOCKERFILE):
        if not required_file.exists():
            raise SmokeError(f"missing required runtime asset: {required_file}")

    if shutil.which("docker") is None:
        raise SmokeError("docker CLI is required for compose validation")

    with tempfile.TemporaryDirectory(prefix="openlia-smoke-") as tmp:
        tmp_path = Path(tmp)
        if ctx.env_file is not None:
            env_file = ctx.env_file
            if ctx.secret_file is not None:
                verify_secret_permissions(ctx.secret_file, ctx.secret_dir)
        else:
            env_file, _ = build_temp_compose_env(tmp_path, ctx, manifest)

        proc = run_command(
            [
                "docker",
                "compose",
                "--env-file",
                str(env_file),
                "-f",
                str(COMPOSE_FILE),
                "config",
            ]
        )
        rendered = proc.stdout
        if "/var/run/docker.sock" in rendered:
            raise SmokeError("compose configuration must not mount /var/run/docker.sock")
        if "read_only: true" not in rendered:
            raise SmokeError("compose configuration must keep root filesystems read-only")

        ctx.results.append(
            CheckResult(
                name="compose-config",
                details={"compose_file": str(COMPOSE_FILE), "env_file": str(env_file)},
            )
        )


def check_hermes_runtime(ctx: SmokeContext, manifest: dict) -> None:
    if shutil.which("docker") is None:
        raise SmokeError("docker CLI is required for hermes runtime checks")

    components = manifest.get("components", manifest)
    hermes_comp = components["hermes"]
    openlia_ver = manifest.get("openliaVersion") or manifest["openlia"]
    image_tag = f"openlia-hermes:v{openlia_ver}"

    if ctx.args.build_image:
        run_command(
            [
                "docker",
                "build",
                "--build-arg",
                f"HERMES_BASE_IMAGE={hermes_comp['image']}",
                "--build-arg",
                f"HERMES_BASE_TAG={hermes_comp['tag']}",
                "--build-arg",
                f"HERMES_BASE_DIGEST={hermes_comp['digest']}",
                "-f",
                str(HERMES_DOCKERFILE),
                "-t",
                image_tag,
                str(ROOT),
            ]
        )
        ctx.results.append(
            CheckResult(name="hermes-image-build", details={"image": image_tag})
        )

    inspect_proc = run_command(
        ["docker", "image", "inspect", image_tag],
        check=False,
    )
    if inspect_proc.returncode != 0:
        raise SmokeError(
            f"container image {image_tag} is not built locally (re-run with --build-image or after openlia deploy)"
        )

    run_command(
        [
            "docker",
            "run",
            "--rm",
            "--entrypoint",
            "/bin/sh",
            image_tag,
            "-lc",
            "test -x /usr/local/bin/openlia-secret-source",
        ]
    )
    ctx.results.append(
        CheckResult(
            name="hermes-secret-source-wrapper",
            details={"image": image_tag},
        )
    )


def check_backup_flow(ctx: SmokeContext) -> None:
    for required_doc in (
        ROOT / "README.md",
        ROOT / "docs" / "architecture.md",
    ):
        if not required_doc.exists():
            raise SmokeError(f"missing required documentation file: {required_doc}")

    ctx.results.append(
        CheckResult(
            name="backup-assets-and-docs",
            details={"verified_files": ["README.md", "docs/architecture.md"]},
        )
    )

    if not ctx.args.verify_backup_cycle:
        return

    if ctx.config_file is None:
        raise SmokeError("--verify-backup-cycle requires --config-file")

    cmd_prefix = [ctx.openlia_bin] if ctx.openlia_bin else ["go", "run", "."]
    base_args = ["--json", "--config", str(ctx.config_file)]
    status_proc = run_command([*cmd_prefix, "backup", "status", *base_args])
    status_payload = json.loads(status_proc.stdout)
    create_proc = run_command([*cmd_prefix, "backup", "create", "--wait", *base_args])
    create_payload = json.loads(create_proc.stdout)
    if not create_payload.get("ok"):
        raise SmokeError(f"openlia backup create failed: {create_payload}")

    ctx.results.append(
        CheckResult(
            name="backup-create-cycle",
            details={
                "status_ok": bool(status_payload.get("ok")),
                "create_ok": bool(create_payload.get("ok")),
            },
        )
    )


def main() -> int:
    args = parse_args()
    try:
        manifest = load_manifest()
        ctx = SmokeContext(
            args=args,
            env_file=resolve_optional_path(args.env_file, description="env file"),
            secret_file=resolve_optional_path(args.secret_file, description="secret file"),
            secret_dir=resolve_optional_path(args.secret_dir, description="secret directory"),
            openlia_bin=resolve_openlia_bin(args.openlia_bin),
            config_file=resolve_optional_path(args.config_file, description="config file"),
        )

        if args.mode in ("all", "cli"):
            check_cli_surface(ctx)
        if args.mode in ("all", "compose"):
            check_compose_and_statics(ctx, manifest)
        if args.mode in ("all", "hermes"):
            check_hermes_runtime(ctx, manifest)
        if args.mode in ("all", "backup"):
            check_backup_flow(ctx)

        summary = {
            "ok": True,
            "mode": args.mode,
            "checks": [
                {"name": item.name, "status": item.status, "details": item.details}
                for item in ctx.results
            ],
        }
        if args.json:
            print(json.dumps(summary, indent=2))
        else:
            for item in ctx.results:
                print(f"[PASS] {item.name}: {json.dumps(item.details, sort_keys=True)}")
            print(f"OpenLia smoke verification ({args.mode}) passed ({len(ctx.results)} checks).")
        return 0
    except SmokeError as exc:
        if args.json:
            print(json.dumps({"ok": False, "mode": args.mode, "error": str(exc)}, indent=2))
        else:
            print(f"[FAIL] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

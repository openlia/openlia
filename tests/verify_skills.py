#!/usr/bin/env python3
"""Run deterministic offline self-tests for bundled OpenLia skills."""

from __future__ import annotations

import argparse
import glob
import os
import subprocess
import sys
import time

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYSTEM_SKILLS_DIR = os.path.join(REPO_DIR, "profile", "system-skills")
SKILLS_DIR = os.path.join(REPO_DIR, "profile", "skills")
FEATURES_DIR = os.path.join(REPO_DIR, "features")


def run_command(cmd: list[str], timeout: float = 120.0) -> tuple[int, str, str, float]:
    """Execute command with timing and captured output."""
    started = time.time()
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr, time.time() - started
    except subprocess.TimeoutExpired:
        return 124, "", f"Timed out after {timeout}s", time.time() - started
    except Exception as error:
        return 1, "", str(error), time.time() - started


def run_offline_tests(selected_skill: str = "") -> bool:
    """Run deterministic offline self-tests across bundled skill scripts."""
    print("\n" + "=" * 65)
    print("  RUNNING OFFLINE SKILL SELF-TESTS")
    print("=" * 65)

    sys_pattern = os.path.join(
        SYSTEM_SKILLS_DIR, selected_skill or "*", "scripts", "validate_workspace.py"
    )
    pattern = os.path.join(SKILLS_DIR, selected_skill or "*", "scripts", "*.py")
    feat_pattern = os.path.join(
        FEATURES_DIR, "*", "skills", selected_skill or "*", "scripts", "*.py"
    )
    scripts = sorted(glob.glob(sys_pattern) + glob.glob(pattern) + glob.glob(feat_pattern))
    if not scripts:
        print(f"No skill scripts found matching pattern: {pattern}")
        return True

    all_passed = True
    results = []
    for script in scripts:
        skill_name = os.path.basename(os.path.dirname(os.path.dirname(script)))
        script_name = os.path.basename(script)
        code, stdout, stderr, duration = run_command(
            [sys.executable, script, "--self-test"], timeout=15
        )
        passed = code == 0
        all_passed = all_passed and passed
        results.append(
            (skill_name, script_name, passed, duration, stderr.strip() or stdout.strip())
        )

    print(f"{'Skill':<34} {'Script':<26} {'Status':<10} {'Duration':<10}")
    print("-" * 82)
    for skill, script, passed, duration, _ in results:
        status = "PASS" if passed else "FAIL"
        print(f"{skill:<34} {script:<26} {status:<10} {duration:.2f}s")
    for skill, script, passed, _, details in results:
        if not passed:
            print(f"\n[FAIL DETAILED TRACE] {skill} -> {script}:")
            print(details)
    print("=" * 65 + "\n")
    return all_passed


def check_environment_dependencies() -> bool:
    """Check dependencies used by bundled helper self-tests."""
    try:
        import yaml  # noqa: F401
    except ImportError:
        print("PyYAML is required; run `make venv` first.", file=sys.stderr)
        return False
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenLia bundled skill tests")
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Run deterministic offline skill self-tests",
    )
    parser.add_argument("--skill", type=str, default="", help="Test one skill")
    args = parser.parse_args()

    if not check_environment_dependencies():
        sys.exit(1)
    sys.exit(0 if run_offline_tests(args.skill) else 1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Verify the native binary and corresponding-source bundle inside a built image."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
pin = json.loads((ROOT / "release/manifest.json").read_text())["remind"]
script = r'''
import json,os,pathlib,runpy
prefix=pathlib.Path('/usr/local/lib/openlia/remind/current').resolve()
source=prefix/'share/openlia/sources/remind'
expected=json.loads(os.environ['EXPECTED_REMIND_PIN'])
assert json.loads((source/'release-manifest.json').read_text())['remind']==expected
assert (prefix/'share/licenses/remind/COPYRIGHT').is_file()
installer=runpy.run_path(str(source/'install-remind.py'))
print(json.dumps(installer['install'](source/'release-manifest.json',prefix),indent=2))
'''
if len(sys.argv) != 2:
    raise SystemExit("usage: python tests/check_remind_image.py IMAGE")
subprocess.run(["docker", "run", "--rm", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m", "--network", "none", "--env", "EXPECTED_REMIND_PIN=" + json.dumps(pin), "--entrypoint", "python3", sys.argv[1], "-c", script], check=True)

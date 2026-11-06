#!/bin/sh
set -eu

packages="ffmpeg poppler-utils"

# Snapshot downloads can occasionally return transient gateway errors. Keep
# the install reproducible while allowing APT to retry those fetches.
apt-get \
	-o Acquire::Check-Valid-Until=false \
	-o Acquire::Retries=3 \
	-o Acquire::http::Timeout=30 \
	-o Acquire::https::Timeout=30 \
	update
# Package names come only from the capability map above.
# shellcheck disable=SC2086
DEBIAN_FRONTEND=noninteractive apt-get \
	-o Acquire::Retries=3 \
	-o Acquire::http::Timeout=30 \
	-o Acquire::https::Timeout=30 \
	install -y --no-install-recommends $packages
rm -rf /var/lib/apt/lists/*

uv pip install --python /opt/hermes/.venv/bin/python --no-cache --require-hashes --no-deps \
	--requirement /usr/local/share/openlia/yt-dlp-requirements.txt

ffmpeg -version >/dev/null
ffprobe -version >/dev/null
pdftotext -v >/dev/null 2>&1
pdfinfo -v >/dev/null 2>&1
pdftoppm -v >/dev/null 2>&1
yt-dlp --version >/dev/null

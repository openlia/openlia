# Third-Party Notices

OpenLia source code is distributed under the [MIT License](LICENSE). OpenLia
also builds or uses software from other projects. Those projects remain subject
to their own licenses and notices. This file is an inventory of the
third-party artifacts referenced directly by this repository; it is not a
replacement for the license files shipped by those projects or images.

## Directly Referenced Artifacts

| Component | Version or pin | License | Source or notice |
| --- | --- | --- | --- |
| Hermes Agent | `nousresearch/hermes-agent:v0.22.5` at `sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d` | MIT | [Upstream repository](https://github.com/NousResearch/hermes-agent) |
| Locho | `v1.3.0`; architecture-specific SHA-256 values are recorded in [`release/manifest.json`](release/manifest.json) | MIT | [Upstream repository](https://github.com/trchopan/locho) and [release downloads](https://github.com/trchopan/locho/releases/tag/v1.3.0) |
| Bun | `1.2.22`; architecture-specific SHA-256 values are recorded in [`docker/Dockerfile`](docker/Dockerfile) | MIT, with additional bundled component licenses | [Upstream licensing information](https://github.com/oven-sh/bun/blob/main/LICENSE.md) |
| uv | `0.8.14`; architecture-specific SHA-256 values are recorded in [`docker/Dockerfile`](docker/Dockerfile) | MIT and Apache-2.0 | [MIT License](https://github.com/astral-sh/uv/blob/0.8.14/LICENSE-MIT) and [Apache License 2.0](https://github.com/astral-sh/uv/blob/0.8.14/LICENSE-APACHE) |
| PyYAML | `6.0.2` | MIT | [Upstream license](https://github.com/yaml/pyyaml/blob/6.0.2/LICENSE) |
| yt-dlp | `2026.8.19`; universal wheel SHA-256 is recorded in [`docker/yt-dlp-requirements.txt`](docker/yt-dlp-requirements.txt) | Unlicense | [Upstream repository](https://github.com/yt-dlp/yt-dlp) |
| Remind | `06.03.06`; exact source URL and SHA-256 are recorded in [`release/manifest.json`](release/manifest.json) | GPL-2.0-only | [Upstream](https://dianne.skoll.ca/projects/remind/); exact corresponding source and license accompany the installed binary |
| age | `filippo.io/age v1.3.2` | BSD-3-Clause | [Upstream repository](https://github.com/FiloSottile/age) |
| AWS SDK for Go v2 | `v1.47.1` and modules in [`go.mod`](go.mod) | Apache-2.0 | [Upstream repository](https://github.com/aws/aws-sdk-go-v2) |
| robfig/cron | `v3.0.1` | MIT | [Upstream repository](https://github.com/robfig/cron) |
| BurntSushi/toml | `v1.6.0` | MIT | [Upstream repository](https://github.com/BurntSushi/toml) |
| `golang.org/x/crypto`, `x/sys`, `x/term` | Versions in [`go.mod`](go.mod) | BSD-3-Clause | [golang.org/x repositories](https://go.googlesource.com/) |

Go module pins and transitive dependencies are declared in
[`go.mod`](go.mod) and [`go.sum`](go.sum). The Python dependencies above are
declared in
[`profile/system-skills/workspace-template-customization/requirements.txt`](profile/system-skills/workspace-template-customization/requirements.txt)
and are also used by the development requirements file.

## Container Base Images and Packages

The derived images use these pinned base images:

- Hermes image base: `nousresearch/hermes-agent:v0.22.5` at the digest
  listed above.
- Locho image base: `debian:13.4-slim` at
  `sha256:109e2c65005bf160609e4ba6acf7783752f8502ad218e298253428690b9eaa4b`.

The Dockerfiles install distribution packages including `ca-certificates`,
`curl`, `ffmpeg`, `git`, `hledger`, Poppler utilities, `tzdata`, `unzip`, and
`xz-utils`, plus the pinned `yt-dlp` runtime and Python document-processing
libraries. These packages and
their transitive dependencies have package-specific licenses and copyright
notices. The image build resolves Debian packages from the dated
`20260801T000000Z` snapshot configured in `docker/compose.yaml`, making package
resolution reproducible for that snapshot. For a built image, inspect the
package metadata and files under
`/usr/share/doc/*/copyright` and consult the distribution's license
information.

## Bundled and Transitive Notices

### Remind corresponding source

OpenLia-built Workspace UI and Hermes images include the unmodified, checksum-
verified Remind source archive alongside the binary. Under
`/usr/local/lib/openlia/remind/06.03.06/`:

- `share/licenses/remind/COPYRIGHT` contains the upstream GPLv2 notice/license.
- `share/openlia/sources/remind/remind-06.03.06.tar.gz` is the exact corresponding
  source, including upstream build scripts and data.
- The same directory contains `install-remind.py`, `release-manifest.json`, and
  `build-info.json` with the pin, build commands, platform, and binary checksum.
- Image build recipes are included in `/usr/local/share/openlia/build-recipes/`.

The CLI is compiled without optional Readline and without modifying upstream C
source. Holiday data is included; the upstream UK-to-GB alias is materialized as
identical regular data. Compiler/build packages remain in the builder stage, not
added to the final image by this installation. When redistributing these images
or extracting/redistributing their Remind binary, retain and provide the complete
corresponding-source bundle and notices to recipients; do not replace it with
only an upstream URL. Remind remains a separate GPLv2 program, not MIT-licensed
OpenLia source.

- Bun statically links or embeds additional libraries and polyfills with
  licenses including LGPL, BSD, Apache, MIT, zlib, and other licenses. Refer to
  Bun's upstream licensing information for the complete component inventory.
- Hermes Agent and Locho may include their own dependencies and notices inside
  their respective images or release archives. OpenLia does not replace those
  notices.
- The final image also contains dependencies supplied by the upstream Hermes
  image and the Debian base image. A complete notice set for a particular image
  must be generated from that image, including its package database and
  upstream-provided notice files.

When redistributing an OpenLia-built image, binary, or release archive, retain
the applicable upstream license texts and attribution notices from every
included artifact. Verify the current pins in the Dockerfiles and release
manifest before making a redistribution.

## Host Tools and External Services

Docker Engine, Docker Compose, Go, Python, Bash, SSH, GitHub, and configured
OpenAI-compatible providers are prerequisites or external services. They are
not bundled by this repository and remain subject to their own terms and
licenses. Optional Locho capabilities are also supplied and licensed by their
respective service or software providers.

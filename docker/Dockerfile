# syntax=docker/dockerfile:1.7

# Keep the upstream release tag visible while requiring an immutable digest.
ARG HERMES_BASE_IMAGE=nousresearch/hermes-agent
ARG HERMES_BASE_TAG=v0.22.4
ARG HERMES_BASE_DIGEST=sha256:7a69201726bc64db2072a1371557137c23312d29705cda2b8ea2a0214a50a4cf
FROM ${HERMES_BASE_IMAGE}:${HERMES_BASE_TAG}@${HERMES_BASE_DIGEST}

ARG TARGETARCH
ARG BUN_VERSION=1.2.22
ARG BUN_X86_64_SHA256=4c446af1a01d7b40e1e11baebc352f9b2bfd12887e51b97dd3b59879cee2743a
ARG BUN_AARCH64_SHA256=a97c687fb5e54de4e2fb0869a7ac9a2d9c3af75ac182e2b68138c1dd8f98131b
ARG UV_VERSION=0.8.14
ARG UV_X86_64_SHA256=954add045f29f93191523175e4aea066996840e86c1b6339dee25f48b15b5ddb
ARG UV_AARCH64_SHA256=69616218470b2ad053617efb9e7027b1518ea38918d933c2791e113d99cec507
ARG DEBIAN_SNAPSHOT=20260505T000000Z

USER root

# The upstream image owns the entrypoint and s6 tree. Only add immutable
# command-line runtimes, timezone data, and the OpenLia secret helper here.
RUN sed -i \
        -e "s|URIs: http://deb.debian.org/debian$|URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}|" \
        -e "s|URIs: http://deb.debian.org/debian-security$|URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}|" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl git hledger python3-yaml remind tzdata unzip xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && hledger --version \
    && set -eu; \
    case "${TARGETARCH:-amd64}" in \
        amd64) \
            bun_arch='x64'; \
            bun_sha="${BUN_X86_64_SHA256}"; \
            uv_target='x86_64-unknown-linux-gnu'; \
            uv_sha="${UV_X86_64_SHA256}"; \
            ;; \
        arm64) \
            bun_arch='aarch64'; \
            bun_sha="${BUN_AARCH64_SHA256}"; \
            uv_target='aarch64-unknown-linux-gnu'; \
            uv_sha="${UV_AARCH64_SHA256}"; \
            ;; \
        *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    bun_archive="/tmp/bun-linux-${bun_arch}.zip"; \
    uv_archive="/tmp/uv-${uv_target}.tar.gz"; \
    curl --fail --silent --show-error --location --retry 3 \
        --output "${bun_archive}" \
        "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip"; \
    printf '%s  %s\n' "${bun_sha}" "${bun_archive}" | sha256sum -c -; \
    mkdir -p /tmp/bun; \
    unzip -q "${bun_archive}" -d /tmp/bun; \
    install -m 0755 "/tmp/bun/bun-linux-${bun_arch}/bun" /usr/local/bin/bun; \
    ln -sf /usr/local/bin/bun /usr/local/bin/bunx; \
    curl --fail --silent --show-error --location --retry 3 \
        --output "${uv_archive}" \
        "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_target}.tar.gz"; \
    printf '%s  %s\n' "${uv_sha}" "${uv_archive}" | sha256sum -c -; \
    mkdir -p /tmp/uv; \
    tar -xzf "${uv_archive}" -C /tmp/uv; \
    install -m 0755 "/tmp/uv/uv-${uv_target}/uv" /usr/local/bin/uv; \
    install -m 0755 "/tmp/uv/uv-${uv_target}/uvx" /usr/local/bin/uvx; \
    rm -rf /tmp/bun /tmp/uv "${bun_archive}" "${uv_archive}"

COPY profile/system-skills/workspace-template-customization/requirements.txt /tmp/workspace-template-req.txt
RUN uv pip install --python /opt/hermes/.venv/bin/python --no-cache \
	--requirement /tmp/workspace-template-req.txt \
	&& uv pip install --python /opt/hermes/.venv/bin/python --no-cache pip-audit==2.9.0 \
	&& rm -f /tmp/workspace-template-req.txt

COPY --chmod=0755 docker/secret-source.sh /usr/local/bin/openlia-secret-source
COPY docker/openlia_link_rewriter.py /opt/hermes/.venv/lib/python3.13/site-packages/openlia_link_rewriter.py
COPY docker/openlia_usage.py /opt/hermes/.venv/lib/python3.13/site-packages/openlia_usage.py
COPY profile/plugins/openlia-usage /opt/hermes/plugins/openlia-usage
COPY docker/openlia_link_rewriter.pth /opt/hermes/.venv/lib/python3.13/site-packages/openlia_link_rewriter.pth
# OpenLia's policy plugin is bundled with the image and enabled by profile/config.yaml.
COPY profile/plugins/openlia-policy /opt/hermes/plugins/openlia-policy

ARG OPENLIA_PROJECT_NAME="openlia"
COPY docker/yt-dlp-requirements.txt /usr/local/share/openlia/yt-dlp-requirements.txt
COPY --chmod=0755 docker/install-tools.sh /usr/local/bin/openlia-install-tools
COPY profile/plugins/openlia-ingestion/requirements.txt /tmp/openlia-ingestion-requirements.txt
RUN /usr/local/bin/openlia-install-tools \
    && uv pip install --python /opt/hermes/.venv/bin/python --no-cache \
        --requirement /tmp/openlia-ingestion-requirements.txt \
    && rm -f /tmp/openlia-ingestion-requirements.txt
COPY profile/plugins/openlia-ingestion /opt/hermes/plugins/openlia-ingestion
# Release archives protect source files with mode 0600; supervised Hermes runs
# as an unprivileged user and must be able to read the bundled plugins.
RUN chmod -R a+rX /opt/hermes/plugins/openlia-policy /opt/hermes/plugins/openlia-ingestion /opt/hermes/plugins/openlia-usage \
    && chmod a+r /opt/hermes/.venv/lib/python3.13/site-packages/openlia_usage.py
LABEL org.openlia.project="${OPENLIA_PROJECT_NAME}" org.openlia.ingestion="required" org.openlia.debian-snapshot="${DEBIAN_SNAPSHOT}"

# Keep the upstream default USER and ENTRYPOINT unchanged. s6 must start as
# root so the upstream volume setup can drop supervised processes to hermes.
ENV HERMES_TIMEZONE="Asia/Ho_Chi_Minh"
ENV TZ="Asia/Ho_Chi_Minh"
ENV PATH="/usr/local/bin:/opt/hermes/bin:/opt/hermes/.venv/bin:/opt/data/.local/bin:${PATH}"

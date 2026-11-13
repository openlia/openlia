# syntax=docker/dockerfile:1.7

ARG HERMES_IMAGE=nousresearch/hermes-agent
ARG HERMES_TAG=v2026.9.14
ARG HERMES_DIGEST=sha256:99641e57ec762c59e54cb44aa6746b7fc68c18b3c5ddb088af54234c613d9294
ARG BUN_VERSION=1.2.22
ARG BUN_LINUX_X64_SHA256=4c446af1a01d7b40e1e11baebc352f9b2bfd12887e51b97dd3b59879cee2743a
ARG BUN_LINUX_ARM64_SHA256=a97c687fb5e54de4e2fb0869a7ac9a2d9c3af75ac182e2b68138c1dd8f98131b

FROM ${HERMES_IMAGE}:${HERMES_TAG}@${HERMES_DIGEST}

ARG TARGETARCH
ARG BUN_VERSION
ARG BUN_LINUX_X64_SHA256
ARG BUN_LINUX_ARM64_SHA256
ARG UV_VERSION=0.8.14
ARG UV_ARM64_SHA256=69616218470b2ad053617efb9e7027b1518ea38918d933c2791e113d99cec507
ARG UV_AMD64_SHA256=954add045f29f93191523175e4aea066996840e86c1b6339dee25f48b15b5ddb
ARG DEBIAN_SNAPSHOT=20260801T000000Z

USER root

# The upstream image owns the entrypoint and s6 tree. Only add immutable
# command-line runtimes, timezone data, and the OpenLia secret helper here.
RUN sed -i \
        -e "s|URIs: http://deb.debian.org/debian$|URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}|" \
        -e "s|URIs: http://deb.debian.org/debian-security$|URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}|" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get \
        -o Acquire::Check-Valid-Until=false \
        -o Acquire::Retries=3 \
        -o Acquire::Queue-Mode=host \
        -o Acquire::http::Timeout=30 \
        -o Acquire::http::Pipeline-Depth=0 \
        -o Acquire::https::Timeout=30 \
        -o Acquire::https::Pipeline-Depth=0 \
        update \
    && DEBIAN_FRONTEND=noninteractive apt-get \
        -o Acquire::Retries=3 \
        -o Acquire::Queue-Mode=host \
        -o Acquire::http::Timeout=30 \
        -o Acquire::http::Pipeline-Depth=0 \
        -o Acquire::https::Timeout=30 \
        -o Acquire::https::Pipeline-Depth=0 \
        install -y --no-install-recommends ca-certificates curl git python3-yaml tzdata unzip xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && set -eu; \
    case "${TARGETARCH:-amd64}" in \
        amd64) \
            bun_arch='x64'; \
            bun_sha="${BUN_LINUX_X64_SHA256}"; \
            uv_target='x86_64-unknown-linux-gnu'; \
            uv_sha="${UV_AMD64_SHA256}"; \
            ;; \
        arm64) \
            bun_arch='aarch64'; \
            bun_sha="${BUN_LINUX_ARM64_SHA256}"; \
            uv_target='aarch64-unknown-linux-gnu'; \
            uv_sha="${UV_ARM64_SHA256}"; \
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

COPY --chmod=0755 docker/secret-source.sh /usr/local/bin/openlia-secret-source

# Keep the upstream default USER and ENTRYPOINT unchanged. s6 must start as
# root so the upstream volume setup can drop supervised processes to hermes.
ENV HERMES_HOME=/opt/data \
    OPENLIA_DATA_ROOT=/opt/data \
    OPENLIA_WORKSPACE_ROOT=/opt/data/workspace \
    HERMES_TIMEZONE="Asia/Ho_Chi_Minh" \
    TZ="Asia/Ho_Chi_Minh" \
    PATH="/usr/local/bin:/opt/hermes/bin:/opt/hermes/.venv/bin:${PATH}"

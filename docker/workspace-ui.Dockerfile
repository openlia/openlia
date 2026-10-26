# syntax=docker/dockerfile:1.7

ARG WORKSPACE_UI_BASE_IMAGE=debian
ARG WORKSPACE_UI_BASE_TAG=13.4-slim
ARG WORKSPACE_UI_BASE_DIGEST=sha256:109e2c65005bf160609e4ba6acf7783752f8502ad218e298253428690b9eaa4b
FROM ${WORKSPACE_UI_BASE_IMAGE}:${WORKSPACE_UI_BASE_TAG}@${WORKSPACE_UI_BASE_DIGEST}

ARG TARGETARCH
ARG BUN_VERSION=1.2.22
ARG BUN_X86_64_SHA256=4c446af1a01d7b40e1e11baebc352f9b2bfd12887e51b97dd3b59879cee2743a
ARG BUN_AARCH64_SHA256=a97c687fb5e54de4e2fb0869a7ac9a2d9c3af75ac182e2b68138c1dd8f98131b

USER root
RUN apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=3 update \
    && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates curl git python3 unzip \
    && rm -rf /var/lib/apt/lists/* \
    && set -eu; \
    case "${TARGETARCH:-amd64}" in \
        amd64) bun_arch='x64'; bun_sha="${BUN_X86_64_SHA256}" ;; \
        arm64) bun_arch='aarch64'; bun_sha="${BUN_AARCH64_SHA256}" ;; \
        *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    archive="/tmp/bun-linux-${bun_arch}.zip"; \
    curl --fail --silent --show-error --location --retry 3 --output "${archive}" "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip"; \
    printf '%s  %s\n' "${bun_sha}" "${archive}" | sha256sum -c -; \
    unzip -q "${archive}" -d /tmp/bun; \
    install -m 0755 "/tmp/bun/bun-linux-${bun_arch}/bun" /usr/local/bin/bun; \
    rm -rf /tmp/bun "${archive}"; \
    groupadd --gid 10000 openlia \
    && useradd --system --uid 10000 --gid 10000 --home-dir /nonexistent --shell /usr/sbin/nologin openlia

COPY packages/workspace-ui/dist/ /opt/openlia/workspace-ui/
COPY profile/plugins/openlia-workspace-git/git_proposals.py /opt/openlia/git_proposals.py
ARG OPENLIA_RELEASE_SHA256
RUN if [ -n "${OPENLIA_RELEASE_SHA256:-}" ]; then printf '%s\n' "${OPENLIA_RELEASE_SHA256}" > /opt/openlia/release.sha256; fi \
    && find /opt/openlia/workspace-ui -type d -exec chmod 0755 {} + \
    && find /opt/openlia -type f -exec chmod 0644 {} + \
    && chmod 0755 /opt/openlia /opt/openlia/workspace-ui

COPY --chmod=0755 operator/linux-amd64/openlia-operator /usr/local/lib/openlia/openlia-operator-amd64
COPY --chmod=0755 operator/linux-arm64/openlia-operator /usr/local/lib/openlia/openlia-operator-arm64
RUN printf '#!/bin/sh\ncase "$(uname -m)" in\n  x86_64|amd64) exec /usr/local/lib/openlia/openlia-operator-amd64 "$@" ;;\n  aarch64|arm64) exec /usr/local/lib/openlia/openlia-operator-arm64 "$@" ;;\n  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;\nesac\n' > /usr/local/bin/openlia-operator \
    && chmod 0755 /usr/local/bin/openlia-operator \
    && ln -s /usr/local/bin/openlia-operator /usr/local/bin/openlia

USER openlia

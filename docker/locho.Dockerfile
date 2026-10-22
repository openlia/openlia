# syntax=docker/dockerfile:1.7

ARG LOCHO_BASE_IMAGE=debian
ARG LOCHO_BASE_TAG=13.4-slim
ARG LOCHO_BASE_DIGEST=sha256:109e2c65005bf160609e4ba6acf7783752f8502ad218e298253428690b9eaa4b
FROM ${LOCHO_BASE_IMAGE}:${LOCHO_BASE_TAG}@${LOCHO_BASE_DIGEST}

ARG TARGETARCH
ARG LOCHO_VERSION=1.3.0-beta.2
ARG LOCHO_X86_64_SHA256=5efec3f6d1e6ac86017f86bb3dd6f60bb9234cbab223bc9028ee63161ad550a0
ARG LOCHO_AARCH64_SHA256=235fb616581636f9f34c47c707fa8af620748d86e1cd86afc49fcbfae14b4267

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl passwd xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && set -eu; \
    case "${TARGETARCH:-amd64}" in \
        amd64) locho_target='x86_64-unknown-linux-gnu'; locho_sha="${LOCHO_X86_64_SHA256}" ;; \
        arm64) locho_target='aarch64-unknown-linux-gnu'; locho_sha="${LOCHO_AARCH64_SHA256}" ;; \
        *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    archive="/tmp/locho-${locho_target}.tar.xz"; \
    curl --fail --silent --show-error --location --retry 3 \
        --output "${archive}" \
        "https://github.com/trchopan/locho/releases/download/v${LOCHO_VERSION}/locho-${locho_target}.tar.xz"; \
    printf '%s  %s\n' "${locho_sha}" "${archive}" | sha256sum -c -; \
    mkdir -p /tmp/locho; \
    tar -xJf "${archive}" -C /tmp/locho; \
    install -m 0755 "/tmp/locho/locho-${locho_target}/locho" /usr/local/bin/locho; \
    rm -rf /tmp/locho "${archive}"; \
    groupadd --gid 10000 locho \
    && useradd --system --uid 10000 --gid 10000 --home-dir /nonexistent --shell /usr/sbin/nologin locho

USER locho
ENTRYPOINT ["locho"]

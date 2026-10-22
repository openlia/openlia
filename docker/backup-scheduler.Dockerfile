# syntax=docker/dockerfile:1.7

ARG BACKUP_SCHEDULER_BASE_IMAGE=debian
ARG BACKUP_SCHEDULER_BASE_TAG=13.4-slim
ARG BACKUP_SCHEDULER_BASE_DIGEST=sha256:109e2c65005bf160609e4ba6acf7783752f8502ad218e298253428690b9eaa4b
ARG DEBIAN_SNAPSHOT=20260801T000000Z
FROM ${BACKUP_SCHEDULER_BASE_IMAGE}:${BACKUP_SCHEDULER_BASE_TAG}@${BACKUP_SCHEDULER_BASE_DIGEST}

ARG DEBIAN_SNAPSHOT
RUN sed -i \
        -e "s|URIs: http://deb.debian.org/debian$|URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}|" \
        -e "s|URIs: http://deb.debian.org/debian-security$|URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}|" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends ca-certificates cron openssh-client rsync tzdata util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /root/.aws /etc/openlia

COPY --chmod=0755 operator/linux-amd64/openlia-operator /usr/local/lib/openlia/openlia-operator-amd64
COPY --chmod=0755 operator/linux-arm64/openlia-operator /usr/local/lib/openlia/openlia-operator-arm64
COPY --chmod=0755 docker/backup-scheduler-entrypoint.sh /usr/local/bin/openlia-backup-scheduler
COPY --chmod=0755 docker/backup-scheduler-tick.sh /usr/local/bin/openlia-backup-tick
COPY docker/backup-scheduler-cron /etc/cron.d/openlia-backup

ENV OPENLIA_OPERATOR_CONFIG_FILE=/etc/openlia/backup-schedule-config.json
ENV TZ=Asia/Ho_Chi_Minh

ENTRYPOINT ["/usr/local/bin/openlia-backup-scheduler"]

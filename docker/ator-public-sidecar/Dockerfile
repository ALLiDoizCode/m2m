# syntax=docker/dockerfile:1.7
# Public-ATOR sidecar image for standalone-mode peer-to-peer E2E.
#
# Runs a minimal `anon` client attached to the PUBLIC Anyone network, opens a
# SOCKS5 port for the adjacent connector container to use, and hosts a hidden
# service that forwards to the connector's BTP port. After the HS descriptor
# publishes, the hostname is copied to `/shared/${NICKNAME}-hostname.txt` so
# the test harness can wire peer URLs in the other connector's config.
#
# Build:
#   docker build -t ator-public-sidecar:v0.4.10.0-beta docker/ator-public-sidecar/
#
# Runtime env:
#   NICKNAME        required, used as hostname filename stem under /shared
#   TARGET_HOST     required, docker-network hostname of the adjacent connector
#   TARGET_PORT     required, adjacent connector's BTP port
FROM debian:bookworm-slim

ARG TARGETARCH
ARG ANON_VERSION=0.4.10.0-beta
ARG DEB_REVISION=1.d12.bookworm+1
ARG ANON_RELEASE_BASE=https://github.com/anyone-protocol/ator-protocol/releases/download/v${ANON_VERSION}

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        netcat-openbsd \
    ; \
    rm -rf /var/lib/apt/lists/*

# Checksums for the .deb — pinned in this directory and kept in sync with
# docker/ator/checksums.txt so the sidecar uses the same anon binary hash.
COPY checksums.txt /tmp/checksums.txt
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) DEB_FILE="anon_${ANON_VERSION}-${DEB_REVISION}_amd64.deb" ;; \
        arm64) DEB_FILE="anon_${ANON_VERSION}-${DEB_REVISION}_arm64.deb" ;; \
        *)     echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    URL_FILE="$(echo "${DEB_FILE}" | sed 's/+/%2B/g')"; \
    curl -fsSL -o "/tmp/${DEB_FILE}" "${ANON_RELEASE_BASE}/${URL_FILE}"; \
    cd /tmp; \
    grep "  ${DEB_FILE}\$" /tmp/checksums.txt > /tmp/checksum.active; \
    sha256sum -c /tmp/checksum.active; \
    apt-get update; \
    echo 'anon anon/terms boolean true' | debconf-set-selections; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "/tmp/${DEB_FILE}"; \
    rm -f "/tmp/${DEB_FILE}" /tmp/checksums.txt /tmp/checksum.active; \
    apt-get purge -y --auto-remove curl; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    anon --version | grep -q "${ANON_VERSION}"

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Non-root user, matches the testnet image's UID 1000 so shared-volume
# permissions align if both are ever mounted together.
RUN set -eux; \
    groupadd --system --gid 1000 anon; \
    useradd  --system --uid 1000 --gid anon --home-dir /var/lib/anon --shell /usr/sbin/nologin anon; \
    mkdir -p /var/lib/anon /shared /etc/anon; \
    chown -R anon:anon /var/lib/anon /shared /etc/anon

VOLUME ["/var/lib/anon"]
USER anon
EXPOSE 9050

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

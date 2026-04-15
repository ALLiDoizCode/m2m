# syntax=docker/dockerfile:1.7
# ATOR testnet image — pinned anon v0.4.10.0-beta installed from upstream .deb
#
# Build (amd64):  docker build --platform linux/amd64 -t ator-testnet:v0.4.10.0-beta docker/ator/
# Build (arm64):  docker build --platform linux/arm64 -t ator-testnet:v0.4.10.0-beta docker/ator/
#
# Apple Silicon note: both amd64 and arm64 .deb packages are published upstream.
# If upstream ever drops arm64, pass --platform linux/amd64 (Rosetta emulation).
FROM debian:bookworm-slim

ARG TARGETARCH
ARG ANON_VERSION=0.4.10.0-beta
ARG DEB_REVISION=1.d12.bookworm+1
# Pinned upstream release base: https://github.com/anyone-protocol/ator-protocol/releases/download/v0.4.10.0-beta/
ARG ANON_RELEASE_BASE=https://github.com/anyone-protocol/ator-protocol/releases/download/v${ANON_VERSION}

# Runtime deps only. Build tools (curl) are purged after install to keep image <200MB.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gettext-base \
        netcat-openbsd \
    ; \
    rm -rf /var/lib/apt/lists/*

COPY checksums.txt /tmp/checksums.txt

# Download the correct .deb for TARGETARCH and verify against checksums.txt.
# sha256sum -c fails the build on mismatch (no silent pass).
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) DEB_FILE="anon_${ANON_VERSION}-${DEB_REVISION}_amd64.deb" ;; \
        arm64) DEB_FILE="anon_${ANON_VERSION}-${DEB_REVISION}_arm64.deb" ;; \
        *)     echo "ERROR: unsupported TARGETARCH=${TARGETARCH} — see docker/ator/checksums.txt" >&2; exit 1 ;; \
    esac; \
    # URL-encode the '+' in the filename path component
    URL_FILE="$(echo "${DEB_FILE}" | sed 's/+/%2B/g')"; \
    echo "Fetching ${ANON_RELEASE_BASE}/${URL_FILE}"; \
    curl -fsSL -o "/tmp/${DEB_FILE}" "${ANON_RELEASE_BASE}/${URL_FILE}"; \
    cd /tmp; \
    # grep only the line matching our filename so sha256sum -c works regardless of
    # whether the other arch's line is present. Fails build on mismatch.
    grep "  ${DEB_FILE}\$" /tmp/checksums.txt > /tmp/checksum.active; \
    sha256sum -c /tmp/checksum.active; \
    apt-get update; \
    apt-get install -y --no-install-recommends "/tmp/${DEB_FILE}"; \
    rm -f "/tmp/${DEB_FILE}" /tmp/checksums.txt /tmp/checksum.active; \
    # Purge curl (no longer needed at runtime); keep ca-certificates, gettext-base, netcat
    apt-get purge -y --auto-remove curl; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    # Smoke: verify anon is installed and version string matches
    anon --version | grep -q "${ANON_VERSION}"

# Role templates & entrypoint
RUN mkdir -p /etc/anon /var/lib/anon
COPY torrc.dirauth /etc/anon/torrc.dirauth.tmpl
COPY torrc.relay   /etc/anon/torrc.relay.tmpl
COPY torrc.hs      /etc/anon/torrc.hs.tmpl
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Drop privileges — create a dedicated unprivileged user for the anon process.
# Addresses Semgrep dockerfile.security.missing-user-entrypoint (CWE-269 / OWASP A04).
# The data directory and config directory are chowned so the entrypoint (which
# runs `envsubst` into /etc/anon and writes state under /var/lib/anon) can operate
# without root. The anon binary does NOT need root for our ports: ORPort 9001,
# DirPort 9030, ControlPort 9051, SOCKSPort 9050 are all non-privileged (>=1024).
RUN set -eux; \
    groupadd --system --gid 1000 anon; \
    useradd  --system --uid 1000 --gid anon --home-dir /var/lib/anon --shell /usr/sbin/nologin anon; \
    chown -R anon:anon /etc/anon /var/lib/anon

# State volume — named-volume friendly; identity keys and descriptors live here
VOLUME ["/var/lib/anon"]

USER anon

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

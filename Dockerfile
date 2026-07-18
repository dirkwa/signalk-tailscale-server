# signalk-tailscale-server — Container Image
#
# Headless Tailscale engine. Launched and managed by the signalk-tailscale
# plugin via signalk-container's ensureRunning(). The plugin sets DATA_DIR
# (config.json + tailscale-state/), SIGNALK_DATA_PATH, SIGNALK_VERSION, and
# HOST_HOSTNAME. Persisted state (node key, prefs, serve config) lives under
# DATA_DIR so identity rides in SignalK backups.
#
# No UI. The user-facing UI lives in the plugin's webapp (mounted by SignalK at
# /signalk-tailscale/) and reaches us via the plugin's reverse-proxy at
# /plugins/signalk-tailscale/api/.
#
# Base: node:24-trixie-slim (Debian 13 + Node 24, official upstream) — same
# family as signalk-backup-server. Trixie ships the upstream Node binary the
# project test-builds against, avoiding the Wolfi/undici arm64 SIGILL.
#
# The node process is PID-tini's child and the tailscaled supervisor; it spawns
# `tailscaled --tun=userspace-networking` at boot. No CapAdd / /dev/net/tun /
# sysctls are required (userspace/netstack), which is exactly why this works
# under signalk-container's restricted runtime.

ARG VERSION=0.1.0

# =============================================================================
# Stage 1: Build backend (TypeScript → ESM)
# =============================================================================
FROM node:26-trixie-slim AS backend-builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm exec tsc

# =============================================================================
# Stage 2: Production image
# =============================================================================
FROM node:26-trixie-slim

# tini — PID-1 signal handling (clean SIGTERM → drain tailscaled).
# ca-certificates — TLS for the Tailscale control plane + serve certs.
# wget — used only to fetch the Tailscale tarball below; purged afterward.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*

# Tailscale static binaries, pinned per-arch (recipe validated in Phase 0).
# A newly-disclosed CVE in the Go binary is the signal to bump TS_VERSION.
ARG TS_VERSION=1.98.9
ARG TARGETARCH
ARG TS_SHA256_AMD64=11be30ad301d48f84ff52fec34f8a2f78eb3e3dee1be4e9624d19fccc8df5540
ARG TS_SHA256_ARM64=fa554ee808d7d07ee8e3ebbc0215ea087157e2a0abbf408e6e18ea7532554db6
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) TS_SHA="$TS_SHA256_AMD64" ;; \
      arm64) TS_SHA="$TS_SHA256_ARM64" ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    wget -q "https://pkgs.tailscale.com/stable/tailscale_${TS_VERSION}_${TARGETARCH}.tgz" -O /tmp/ts.tgz; \
    echo "${TS_SHA}  /tmp/ts.tgz" | sha256sum -c -; \
    tar xzf /tmp/ts.tgz --strip-components=1 -C /usr/local/bin/ \
        "tailscale_${TS_VERSION}_${TARGETARCH}/tailscale" \
        "tailscale_${TS_VERSION}_${TARGETARCH}/tailscaled"; \
    chmod +x /usr/local/bin/tailscale /usr/local/bin/tailscaled; \
    rm /tmp/ts.tgz; \
    tailscale --version

# Purge the download-only tool now that the binaries are in place.
RUN apt-get purge -y --auto-remove wget \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prod deps with npm, then strip npm itself: the runtime only runs
# `node dist/server.js`, never a package manager. npm bundles its own
# tar/undici copies that Trivy flags though never invoked here.
COPY package*.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm /usr/local/bin/npx

COPY --from=backend-builder /app/dist ./dist

# /data exists as a fallback HOME, but at runtime the supervisor points HOME at
# DATA_DIR (the writable bind mount) so tailscaled's cache never hits a
# read-only path under --userns=keep-id (see supervisor.ts).
RUN mkdir -p /data

ENV NODE_ENV=production \
    HOME=/data \
    PORT=3020 \
    DATA_DIR=/data \
    SIGNALK_DATA_PATH=/signalk-data \
    LOG_LEVEL=info

EXPOSE 3020

# Liveness of the shim (which also reports tailscaled supervisor state). Uses
# http.get (no global fetch) to keep the runtime command surface fetch-free.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "const r=require('http').get('http://127.0.0.1:3020/api/health',res=>{res.resume();process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(5000,()=>{r.destroy();process.exit(1)})"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]

ARG VERSION
LABEL org.opencontainers.image.title="signalk-tailscale-server" \
      org.opencontainers.image.description="Headless userspace-Tailscale engine for the signalk-tailscale plugin" \
      org.opencontainers.image.source="https://github.com/dirkwa/signalk-tailscale-server" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"

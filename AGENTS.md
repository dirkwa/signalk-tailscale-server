# AGENTS.md

Orientation for AI coding agents. Human-facing usage lives in
[README.md](README.md); this is what an agent needs before non-trivial changes.

## What this is

A headless HTTP shim that supervises a userspace-mode `tailscaled` and drives it
via the `tailscale` CLI, packaged as a multi-stage `node:24-trixie-slim`
container (`ghcr.io/dirkwa/signalk-tailscale-server`). It is launched and managed
by the [signalk-tailscale](https://github.com/dirkwa/signalk-tailscale) plugin
via signalk-container's `ensureRunning()`. Same architecture as
signalk-backup + signalk-backup-server; this repo is the reference for that
pattern applied to Tailscale.

**The one hard constraint:** signalk-container grants no `CapAdd`, no device
passthrough (`/dev/net/tun`), no sysctls, no privileged. Therefore Tailscale
runs in **userspace-networking mode everywhere** (`--tun=userspace-networking`,
gVisor netstack). Inbound traffic reaches SignalK only via `tailscale serve`,
never kernel forwarding. Do not add TUN/cap/sysctl assumptions.

## File layout

- [src/server.ts](src/server.ts) — Express entrypoint. Mounts route prefixes
  (`/api/health|status|login|logout|config|serve|routes|events`) plus the
  OpenAPI surface (`/api/docs` Swagger UI + `/api/openapi.json`), loopback CORS,
  boots the supervisor + reconcile loop. Binds `0.0.0.0` (IPv4 explicit — pasta
  only bridges IPv4; host exposure is limited by signalk-container's publishing).
- [src/config/index.ts](src/config/index.ts) — typebox-validated env config.
  `DATA_DIR` (config.json + tailscale-state/), socket/binary paths, HOST_HOSTNAME.
- [src/tailscale/](src/tailscale/) — the domain layer:
  - `cli.ts` — the ONE seam to tailscaled (execFile `tailscale --socket=…`).
    Replace with a LocalAPI client here if ever needed; nothing else shells out.
  - `supervisor.ts` — spawns/backoff-restarts `tailscaled`; drains on SIGTERM,
    **never logs out**. Sets `HOME=DATA_DIR` for the child (writable-cache fix).
  - `login.ts` — async `tailscale up` kick; AuthURL via status is primary,
    stdout scrape is fallback; re-kick heuristic for wedged logins.
  - `reconciler.ts` — desired→actual each tick: kick login when NoState/
    NeedsLogin, apply prefs via `set` when Running. Serve is a Phase-3 seam
    (`applyServe`), injected by reconcile-runner.
  - `statusMapper.ts` — pure flatten of `status --json` (+serve) → StatusSnapshot.
- [src/services/](src/services/) — `config-store.ts` (persist desired config +
  runtime serve target/error), `status-service.ts` (assemble the snapshot),
  `reconcile-runner.ts` (adaptive-cadence timer + serve-applier injection),
  `logger.ts`.
- [src/api/](src/api/) — one router per concern, all using the openapi-registry
  `createApiRouter` wrapper (captures OpenAPI metadata + TypeBox validation).

## Workflow

- **Changes go through a pull request** — branch off latest `main`, push, open a
  PR. Do not push directly to `main` (CI + CodeRabbit run on the PR).

## Conventions (shared with signalk-backup-server)

- Response envelope everywhere: `{ success, data?, error?, timestamp }`.
- No global `fetch` in runtime code — use `utils/http-client.ts` (eslint enforced).
- `build:all` = lint + tsc + vitest. Prettier: single quotes, semis, width 100.
- Tests mock the `tailscale` CLI (`child_process`), so no daemon is needed.
- Bump `TS_VERSION` in the Dockerfile **with** its per-arch sha256 together.

## Reconcile / login lifecycle (the core loop)

`reconcile-runner` ticks the reconciler on an adaptive cadence (fast 2s while
not-Running, slow 15s once Running; a config POST calls `triggerNow()`). Each
tick reads `tailscale status --json` and branches on `BackendState`:

- **NoState / NeedsLogin** → auto-kick `tailscale up` (async; it blocks until
  auth). NOT `Stopped` — that's a deliberate post-logout state; re-kicking would
  fight the user. Logout is the only path that removes the node.
- **Running** → apply hostname / accept-routes / advertise-routes via
  `tailscale set` (only when they differ), then `applyServe` (probe candidates →
  dual `serve --https=443` + `--http=80` → verify → record lastError; reset
  Funnel if ever seen — SignalK must never be public).

State survives restart/recreate via `--statedir` under DATA_DIR (rides in SK
backups). `stop()` drains tailscaled but **never** logs out.

## REST contract (port 3020, `{success,data,error,timestamp}` envelope)

`GET /api/health` (supervisor state; HEALTHCHECK + plugin ready-poll) ·
`GET /api/status` (flattened StatusSnapshot) · `GET|POST /api/config` (desired
state; persisted, triggers reconcile — config flows here, NOT env, to avoid
signalk-container drift-recreate churn) · `POST /api/login` (202) ·
`POST /api/logout` (danger zone: serve reset + logout) · `GET|POST /api/serve` ·
`GET|POST /api/routes` · `GET /api/events` (SSE snapshots) ·
`GET /api/docs` + `/api/openapi.json`.

## Build, run, release

- `npm run build:all` — lint + tsc + vitest (63 tests, all mock the CLI).
- `npm run dev` — `tsx watch`; needs a local `tailscale`/`tailscaled` on PATH to
  fully exercise, otherwise the reconciler just logs "daemon starting".
- Container: `podman build -t sk-ts .` then run like signalk-container does —
  `podman run --userns=keep-id -e DATA_DIR=… -v <host>:/signalk-data:Z -p
  127.0.0.1:3020:3020 …`. The image HEALTHCHECK is honoured only under Docker
  (OCI/podman ignores it — harmless; the plugin polls /api/health itself).
- Release: push a `vX.Y.Z` tag → `publish.yml` builds the amd64+arm64 manifest
  and pushes `ghcr.io/dirkwa/signalk-tailscale-server:X.Y.Z` (+ `:latest` for
  stable) and cuts a GitHub Release. Keep the tag == `package.json` version.

## Gotchas verified on real hardware (rootless podman/pasta)

- `--userns=keep-id` + `HOME=/data` → tailscaled `mkdir /data/.cache: permission
  denied` (only the bind-mounted DATA_DIR is writable). Fixed by pointing the
  child's `HOME` at `DATA_DIR` in supervisor/login spawns.
- AuthURL appears in `tailscale status --json` ~3s after `up`; the login-kick is
  async because `up` blocks until auth completes (tailscale#3950).
- `tailscale serve` requires a logged-in Running node (refuses while NeedsLogin),
  so R2 (dual serve) / R3 (serve-persist-across-recreate) are doc-verified until
  a live-tailnet E2E — everything up to NeedsLogin+AuthURL is validated live.
- `host.containers.internal` (and `host.docker.internal`, which podman also
  aliases) reach the host SignalK from a pasta bridge container — the basis for
  the plugin's serve-target candidate ordering.

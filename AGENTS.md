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
  (`/api/health|status|login|logout|config|events`), loopback-only CORS, boots
  the supervisor + reconcile loop, Swagger at `/api/docs`. Binds `0.0.0.0`
  (IPv4 explicit — pasta only bridges IPv4).
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

## Conventions (shared with signalk-backup-server)

- Response envelope everywhere: `{ success, data?, error?, timestamp }`.
- No global `fetch` in runtime code — use `utils/http-client.ts` (eslint enforced).
- `build:all` = lint + tsc + vitest. Prettier: single quotes, semis, width 100.
- Tests mock the `tailscale` CLI (`child_process`), so no daemon is needed.
- Bump `TS_VERSION` in the Dockerfile **with** its per-arch sha256 together.

## Gotchas verified on real hardware (rootless podman/pasta)

- `--userns=keep-id` + `HOME=/data` → tailscaled `mkdir /data/.cache: permission
  denied` (only the bind-mounted DATA_DIR is writable). Fixed by pointing the
  child's `HOME` at `DATA_DIR` in supervisor/login spawns.
- AuthURL appears in `tailscale status --json` ~3s after `up`; the login-kick is
  async because `up` blocks until auth completes (tailscale#3950).
- `tailscale serve` requires a logged-in Running node (refuses while NeedsLogin).

# signalk-tailscale-server

Headless [Tailscale](https://tailscale.com) engine for the
[signalk-tailscale](https://github.com/dirkwa/signalk-tailscale) SignalK plugin.

This image runs `tailscaled` in **userspace-networking mode** (gVisor netstack —
no `/dev/net/tun`, no `CapAdd`, no sysctls, so it works under
[signalk-container](https://github.com/dirkwa/signalk-container)'s restricted
runtime) and exposes a small loopback REST shim the plugin drives. The plugin
owns all UI; this process has none.

The data path to SignalK is `tailscale serve` (dual `--https=443` + `--http=80`
listeners), configured by the reconciler once the node is logged in.

## What it does

- Supervises `tailscaled --tun=userspace-networking` with a persistent statedir
  (node key + prefs + serve config) under `DATA_DIR`, so identity survives
  restarts/recreates and rides in SignalK backups.
- Auto-kicks interactive login when the node has no state; the AuthURL is read
  from `tailscale status --json` (and scraped from `tailscale up` as a fallback)
  and surfaced to the plugin via `GET /api/status` / SSE.
- Applies desired config (hostname, subnet routes, accept-routes, and — from
  Phase 3 — serve) pushed by the plugin at `POST /api/config`. Config flows over
  REST, **not** container env, so signalk-container's env-drift detection never
  recreates the container on a settings change.
- Never logs out on shutdown — disabling the plugin drops the VPN but keeps the
  node key, so re-enabling reconnects without a new login. Logout is explicit
  (`POST /api/logout`).

## REST API (port 3020, loopback only)

| Endpoint                                 | Behavior                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                        | `{status, tailscaled: running\|starting\|stopped\|error}` — plugin ready-poll + HEALTHCHECK                       |
| `GET /api/status`                        | Flattened snapshot: backendState, authUrl, self, tailnet, peers, serve URLs + lastError, routes, health, versions |
| `POST /api/config`                       | Desired state from the plugin; persisted to `$DATA_DIR/config.json`, triggers a reconcile                         |
| `GET /api/config`                        | The persisted desired config                                                                                      |
| `POST /api/login`                        | (Re-)kick interactive login; responds 202, AuthURL arrives via status/SSE                                         |
| `POST /api/logout`                       | `serve reset` + `tailscale logout` — danger zone, explicit only                                                   |
| `GET /api/events`                        | SSE status snapshots (2s while logging in, 10s while Running)                                                     |
| `GET /api/docs`, `GET /api/openapi.json` | Swagger UI + spec                                                                                                 |

## Environment (set by the plugin)

- `PORT` (default 3020)
- `DATA_DIR` — root for `config.json` + `tailscale-state/` (the plugin points
  this at `/signalk-data/plugin-config-data/signalk-tailscale`)
- `SIGNALK_DATA_PATH` — mounted SignalK data dir
- `SIGNALK_VERSION`, `HOST_HOSTNAME` — informational / default-hostname source
- `LOG_LEVEL` (default `info`)

## Development

```bash
npm install
npm run dev        # tsx watch (needs a local tailscale/tailscaled on PATH to fully exercise)
npm run build:all  # lint + tsc + vitest
```

The unit suite mocks the `tailscale` CLI, so it runs without a real daemon.

## Image

`ghcr.io/dirkwa/signalk-tailscale-server` — multi-arch (amd64/arm64),
`node:24-trixie-slim` base, Tailscale binary pinned by `TS_VERSION` (bump the
version **and** its sha256 in the Dockerfile together). Tag-triggered publish on
`vX.Y.Z`.

## License

Apache-2.0

/**
 * Reconciler — drives actual tailscaled state toward the desired config.
 *
 * Runs on a timer (fast while logging in, slow while Running) and is idempotent:
 * every tick reads `status --json`, then:
 *   - NoState / NeedsLogin, no live login child → auto-kick login.
 *   - Running → apply hostname / accept-routes / advertised-routes via
 *     `tailscale set` (only when they differ), and (Phase 3) configure serve.
 *
 * Phase 1 lands the login-kick + set-prefs path (enough for login-and-see-
 * status). Serve configuration + target probing are Phase 3 — the seams are
 * marked below so the loop already calls into them.
 */

import * as cli from './cli.js';
import { loginManager } from './login.js';
import { config } from '../config/index.js';
import { logger } from '../services/logger.js';
import type { DesiredConfig, TailscaleStatusJson } from '../types/tailscale.js';

/** Derive the effective device hostname (explicit override or signalk-<host>). */
export function effectiveHostname(desired: DesiredConfig): string {
  if (desired.deviceHostname.trim()) return desired.deviceHostname.trim();
  const host = config.hostHostname.trim() || 'boat';
  return `signalk-${host}`;
}

export interface ReconcileDeps {
  getDesired: () => DesiredConfig;
  /** Phase 3 seam: probe candidates + configure `tailscale serve`. */
  applyServe?: (desired: DesiredConfig, status: TailscaleStatusJson) => Promise<void>;
}

/** One reconcile pass. Never throws — logs and returns so the timer keeps going. */
export async function reconcileOnce(deps: ReconcileDeps): Promise<void> {
  const desired = deps.getDesired();
  let status: TailscaleStatusJson;
  try {
    status = await cli.status();
  } catch (err) {
    // Daemon not ready yet (socket missing / starting). Nothing to do this tick.
    logger.debug({ err }, 'reconcile: status unavailable (daemon starting?)');
    return;
  }

  const state = status.BackendState ?? 'NoState';

  if (state === 'NoState' || state === 'NeedsLogin' || state === 'Stopped') {
    if (loginManager.shouldReKick(status.AuthURL ?? null)) {
      loginManager.kick(effectiveHostname(desired));
    }
    return;
  }

  if (state === 'Running') {
    await applyPrefs(desired, status);
    if (deps.applyServe) {
      try {
        await deps.applyServe(desired, status);
      } catch (err) {
        logger.error({ err }, 'reconcile: applyServe failed');
      }
    }
  }
}

/**
 * Apply hostname / accept-routes / advertised-routes via `tailscale set`, but
 * only when the observed value differs — `set` is cheap yet not free, and we
 * tick often. Advertised-routes diffing is best-effort (Self.PrimaryRoutes
 * reflects *approved* routes, not advertised, so we always push the desired
 * set when non-empty; the CLI is idempotent).
 */
async function applyPrefs(desired: DesiredConfig, status: TailscaleStatusJson): Promise<void> {
  const wantHost = effectiveHostname(desired);
  const haveHost = status.Self?.HostName ?? '';

  const flags: string[] = [];
  if (wantHost && wantHost !== haveHost) {
    flags.push(`--hostname=${wantHost}`);
  }
  // accept-routes + advertise-routes are pushed together so a single `set`
  // call carries the full route intent. We can't cheaply read current
  // accept-routes from status, so we always include it (idempotent).
  flags.push(`--accept-routes=${desired.acceptRoutes ? 'true' : 'false'}`);
  if (desired.advertiseRoutes.length > 0) {
    flags.push(`--advertise-routes=${desired.advertiseRoutes.join(',')}`);
  } else {
    flags.push('--advertise-routes=');
  }

  try {
    await cli.set(flags);
    logger.debug({ flags }, 'reconcile: applied prefs');
  } catch (err) {
    logger.error({ err, flags }, 'reconcile: tailscale set failed');
  }
}

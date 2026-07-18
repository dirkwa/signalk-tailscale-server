/**
 * Serve reconciler (Phase 3) — the data path to SignalK.
 *
 * Once the node is Running and enableServe is desired, this:
 *   1. Picks a serve target: reuse the stored one if it still probes clean,
 *      else re-probe the candidate list and store the winner.
 *   2. Configures BOTH listeners idempotently — `serve --bg --https=443 <t>`
 *      and `serve --bg --http=80 <t>` (http works out of the box; https needs
 *      the one-click "Enable HTTPS", surfaced by the webapp as a hint).
 *   3. Verifies via `serve status --json` and records lastError (a cert-not-
 *      ready state leaves https unset → the webapp shows the hint).
 *   4. SAFETY: if Funnel is ever configured, reset serve — SignalK must never
 *      be exposed to the public internet.
 *
 * When enableServe is false, serve is reset and the stored target cleared.
 *
 * The reconcile-runner injects this as the `applyServe` seam. It is called only
 * when BackendState === Running.
 */

import * as cli from './cli.js';
import { findServeTarget, probeCandidate } from './targetProbe.js';
import { configStore } from '../services/config-store.js';
import { logger } from '../services/logger.js';
import type { DesiredConfig, TailscaleStatusJson, ServeStatusJson } from '../types/tailscale.js';

/** Re-probe the stored target at most this often even when it still works. */
const REPROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastProbeAt = 0;

/** True if the serve config exposes anything via Funnel (must never happen). */
function hasFunnel(serve: ServeStatusJson): boolean {
  const af = serve.AllowFunnel;
  return Boolean(af && Object.values(af).some(Boolean));
}

/** True if BOTH the :443 https and :80 http listeners are present. */
function hasBothListeners(serve: ServeStatusJson): boolean {
  const tcp = serve.TCP ?? {};
  return Boolean(tcp['443']?.HTTPS) && Boolean(tcp['80']?.HTTP);
}

/** True if at least the http listener is present (https may lag on the cert). */
function hasHttp(serve: ServeStatusJson): boolean {
  return Boolean((serve.TCP ?? {})['80']?.HTTP);
}

async function resolveTarget(desired: DesiredConfig): Promise<string | null> {
  const stored = configStore.getServeTarget();
  const now = Date.now();

  // Reuse the stored target unless it's due for a re-probe or fails one.
  if (stored && now - lastProbeAt < REPROBE_INTERVAL_MS) {
    if (await probeCandidate(stored)) return stored;
    logger.info({ stored }, 'stored serve target no longer probes clean; re-probing');
  }

  lastProbeAt = now;
  const found = await findServeTarget(desired.serveTargetCandidates);
  configStore.setServeTarget(found);
  return found;
}

export async function applyServe(
  desired: DesiredConfig,
  _status: TailscaleStatusJson
): Promise<void> {
  // Read current serve config once up front.
  let serve: ServeStatusJson;
  try {
    serve = await cli.serveStatus();
  } catch (err) {
    logger.debug({ err }, 'applyServe: serveStatus failed');
    serve = {};
  }

  // SAFETY FIRST: Funnel must never expose SignalK publicly. If we can't reset
  // it, STOP — continuing would leave SignalK reachable from the open internet.
  if (hasFunnel(serve)) {
    logger.error('Funnel detected on serve config — resetting (SignalK must not be public)');
    try {
      await cli.serve(['reset']);
      serve = {};
    } catch (err) {
      logger.error({ err }, 'failed to reset Funnel serve config');
      configStore.setServeLastError(
        'Funnel is enabled and could not be reset; SignalK may be publicly exposed.'
      );
      return;
    }
  }

  if (!desired.enableServe) {
    // Tear down serve if anything is configured. A failed reset must NOT report
    // success or clear the target — leave lastError set so the state is visible.
    if (Object.keys(serve.TCP ?? {}).length > 0) {
      try {
        await cli.serve(['reset']);
        logger.info('serve disabled by config — reset');
      } catch (err) {
        logger.error({ err }, 'failed to reset serve on disable');
        configStore.setServeLastError('Failed to disable serve: ' + (err as Error).message);
        return;
      }
    }
    configStore.setServeTarget(null);
    configStore.setServeLastError(null);
    return;
  }

  // Capture the configured target BEFORE resolveTarget (which persists the
  // newly-probed one), so a freshly-discovered target isn't mistaken for one
  // that's already fully configured below.
  const previouslyConfiguredTarget = configStore.getServeTarget();
  const target = await resolveTarget(desired);
  if (!target) {
    configStore.setServeLastError(
      'No SignalK endpoint found among candidates. Is SignalK reachable from the container?'
    );
    return;
  }

  // Already fully configured for this target? Nothing to do.
  if (hasBothListeners(serve) && previouslyConfiguredTarget === target) {
    configStore.setServeLastError(null);
    return;
  }

  // Configure both listeners (idempotent — re-running is a no-op in tailscaled).
  try {
    await cli.serve(['--bg', '--https=443', '--yes', target]);
  } catch (err) {
    logger.error({ err, target }, 'serve --https=443 failed');
  }
  try {
    await cli.serve(['--bg', '--http=80', '--yes', target]);
  } catch (err) {
    logger.error({ err, target }, 'serve --http=80 failed');
  }

  // Verify + record lastError.
  let after: ServeStatusJson;
  try {
    after = await cli.serveStatus();
  } catch (err) {
    logger.debug({ err }, 'applyServe: post-config serveStatus failed');
    after = {};
  }

  if (hasBothListeners(after)) {
    configStore.setServeLastError(null);
  } else if (hasHttp(after)) {
    // http up, https not yet — almost always the MagicDNS HTTPS cert isn't
    // enabled. Surface the actionable hint; the http URL works meanwhile.
    configStore.setServeLastError(
      'HTTPS not available yet — enable HTTPS certificates for your tailnet at ' +
        'https://login.tailscale.com/admin/dns (the http:// URL works now).'
    );
  } else {
    configStore.setServeLastError('serve did not come up on :80 or :443 — see server logs.');
  }
}

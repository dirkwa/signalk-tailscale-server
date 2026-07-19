/**
 * Serve-target probe. The plugin sends an ordered list of candidate URLs
 * (127.0.0.1, host.containers.internal, host LAN IPs, …); we probe each with
 * `GET <candidate>/signalk` and accept the first that returns a valid SignalK
 * hello. Requiring the hello — not just any 200 — rejects false positives (a
 * different service answering on the same port, which the Phase 0 spike saw on
 * a non-SignalK port that returned HPE_INVALID_CONSTANT).
 */

import { httpFetch } from '../utils/http-client.js';
import { logger } from '../services/logger.js';

const PROBE_TIMEOUT_MS = 3_000;

/** A SignalK hello has a v1 endpoints map and identifies as a signalk server. */
function isSignalKHello(body: string): boolean {
  try {
    const j = JSON.parse(body) as {
      name?: string;
      endpoints?: { v1?: unknown };
      server?: { id?: string };
    };
    if (!j || typeof j !== 'object') return false;
    if (!j.endpoints || !j.endpoints.v1) return false;
    // Accept either the classic name==='signalk-server' or a server.id present.
    const named = j.name === 'signalk-server' || j.name === 'signalk';
    const hasServerId = Boolean(j.server && j.server.id);
    return named || hasServerId;
  } catch {
    return false;
  }
}

/** Probe one candidate. Returns true iff it answered with a SignalK hello. */
export async function probeCandidate(candidate: string): Promise<boolean> {
  const url = candidate.replace(/\/$/, '') + '/signalk';
  try {
    const res = await httpFetch(url, {
      method: 'GET',
      timeout: PROBE_TIMEOUT_MS,
      // SignalK's HTTPS listener is typically self-signed — skip cert
      // verification for the probe (it's a host-local endpoint we proxy anyway).
      rejectUnauthorized: false,
    });
    if (!res.ok) return false;
    const body = await res.text();
    return isSignalKHello(body);
  } catch {
    return false;
  }
}

/**
 * Probe candidates in order; return the first that validates, or null if none
 * do. Logs the outcome for the reconciler's lastError reporting.
 */
export async function findServeTarget(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await probeCandidate(candidate)) {
      logger.info({ candidate }, 'serve target probe: match');
      return candidate;
    }
    logger.debug({ candidate }, 'serve target probe: no match');
  }
  logger.warn({ tried: candidates.length }, 'serve target probe: no candidate validated');
  return null;
}

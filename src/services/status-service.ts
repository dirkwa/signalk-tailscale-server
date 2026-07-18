/**
 * Assembles the flattened StatusSnapshot from live CLI reads + stored serve
 * state. This is what GET /api/status and the SSE stream return.
 */

import { createRequire } from 'module';
import * as cli from '../tailscale/cli.js';
import { mapStatus } from '../tailscale/statusMapper.js';
import { configStore } from './config-store.js';
import { supervisor } from '../tailscale/supervisor.js';
import type { StatusSnapshot } from '../types/tailscale.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
const SERVER_VERSION = (packageJson.version as string) || '0.0.1';

/** Build a full snapshot. On a not-yet-ready daemon, returns a NoState shell. */
export async function getStatusSnapshot(): Promise<StatusSnapshot> {
  const desired = configStore.get();

  let statusJson;
  try {
    statusJson = await cli.status();
  } catch {
    // Daemon still starting — synthesize a minimal NoState snapshot so callers
    // (and the webapp) can render "Starting Tailscale…" instead of erroring.
    return mapStatus({
      status: { BackendState: supervisor.getState() === 'running' ? 'NoState' : 'NoState' },
      serverVersion: SERVER_VERSION,
      advertisedRoutes: desired.advertiseRoutes,
      acceptRoutes: desired.acceptRoutes,
    });
  }

  // serve status is only meaningful once Running; skip the extra call otherwise.
  let serve = {};
  if (statusJson.BackendState === 'Running') {
    try {
      serve = await cli.serveStatus();
    } catch {
      serve = {};
    }
  }

  return mapStatus({
    status: statusJson,
    serve,
    serveTarget: configStore.getServeTarget(),
    serveLastError: configStore.getServeLastError(),
    advertisedRoutes: desired.advertiseRoutes,
    acceptRoutes: desired.acceptRoutes,
    serverVersion: SERVER_VERSION,
  });
}

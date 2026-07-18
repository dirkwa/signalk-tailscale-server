/**
 * POST /api/logout — the danger zone.
 *
 * `serve reset` (drop the data path) + `tailscale logout` (clear the node key).
 * This is an EXPLICIT user action only — nothing in the reconcile/shutdown path
 * ever calls it, because the whole point of persisting the statedir is that
 * disabling/restarting reconnects without a new login. After logout the node
 * is gone from the tailnet and the next reconcile will auto-kick a fresh login.
 */

import { type Request, type Response } from 'express';
import { createApiRouter } from './openapi-registry.js';
import * as cli from '../tailscale/cli.js';
import { loginManager } from '../tailscale/login.js';
import { configStore } from '../services/config-store.js';
import { logger } from '../services/logger.js';
import type { ApiResponse } from '../types/index.js';

const api = createApiRouter('Login');

api.post(
  '/',
  {
    summary: 'Log out (danger zone)',
    description:
      'Resets serve and clears the Tailscale node key. Explicit user action only — the node leaves the tailnet and a fresh login is required to reconnect.',
    responses: {
      200: { description: 'Logged out' },
    },
  },
  async (_req: Request, res: Response) => {
    // Kill any pending login child first so it can't race the logout.
    loginManager.killChild('logout');

    // Best-effort serve reset; a logout should still proceed if serve is absent.
    try {
      await cli.serve(['reset']);
    } catch (err) {
      logger.warn({ err }, 'serve reset during logout failed (continuing)');
    }
    configStore.setServeTarget(null);
    configStore.setServeLastError(null);

    try {
      await cli.logout();
    } catch (err) {
      logger.error({ err }, 'tailscale logout failed');
      const response: ApiResponse<never> = {
        success: false,
        error: { code: 'LOGOUT_FAILED', message: (err as Error).message },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
      return;
    }

    const response: ApiResponse<{ loggedOut: true }> = {
      success: true,
      data: { loggedOut: true },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

export const logoutRouter = api.router;

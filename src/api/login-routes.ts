/**
 * POST /api/login — (re-)kick interactive login.
 *
 * Returns 202 immediately; the AuthURL arrives via GET /api/status (or the SSE
 * stream) once tailscaled produces it. Idempotent — kicking again restarts the
 * `tailscale up` child.
 */

import { type Request, type Response } from 'express';
import { createApiRouter } from './openapi-registry.js';
import { loginManager } from '../tailscale/login.js';
import { effectiveHostname } from '../tailscale/reconciler.js';
import { configStore } from '../services/config-store.js';
import type { ApiResponse } from '../types/index.js';

const api = createApiRouter('Login');

api.post(
  '/',
  {
    summary: '(Re-)kick interactive login',
    description:
      'Spawns `tailscale up` (async; it blocks until auth). AuthURL surfaces via /api/status / SSE. Responds 202.',
    responses: {
      202: { description: 'Login kick accepted' },
    },
  },
  async (_req: Request, res: Response) => {
    const hostname = effectiveHostname(configStore.get());
    // Explicit user-initiated (re-)login → force a fresh node key.
    loginManager.kick(hostname, true);
    const response: ApiResponse<{ hostname: string }> = {
      success: true,
      data: { hostname },
      timestamp: new Date().toISOString(),
    };
    res.status(202).json(response);
  }
);

export const loginRouter = api.router;

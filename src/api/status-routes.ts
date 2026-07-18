/**
 * GET /api/status — the flattened StatusSnapshot the plugin/webapp render.
 */

import { type Request, type Response } from 'express';
import { createApiRouter } from './openapi-registry.js';
import { getStatusSnapshot } from '../services/status-service.js';
import type { ApiResponse } from '../types/index.js';
import type { StatusSnapshot } from '../types/tailscale.js';

const api = createApiRouter('Status');

api.get(
  '/',
  {
    summary: 'Tailscale status snapshot',
    description:
      'backendState, authUrl, self node, tailnet MagicDNS suffix, peer counts, serve URLs + lastError, routes, health messages, and versions.',
    responses: {
      200: { description: 'Current status snapshot' },
    },
  },
  async (_req: Request, res: Response) => {
    const snapshot = await getStatusSnapshot();
    const response: ApiResponse<StatusSnapshot> = {
      success: true,
      data: snapshot,
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

export const statusRouter = api.router;

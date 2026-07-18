/**
 * GET/POST /api/config — the desired-state contract from the plugin.
 *
 * POST persists to $DATA_DIR/config.json and triggers an immediate reconcile.
 * Config flows here (not via container env) so signalk-container's env-drift
 * detection never recreates the container on a settings change.
 */

import { type Request, type Response } from 'express';
import { createApiRouter } from './openapi-registry.js';
import { desiredConfigSchema } from '../schemas/config.js';
import { configStore } from '../services/config-store.js';
import { reconcileRunner } from '../services/reconcile-runner.js';
import type { ApiResponse } from '../types/index.js';
import type { DesiredConfig } from '../types/tailscale.js';

const api = createApiRouter('Config');

api.get(
  '/',
  {
    summary: 'Get desired config',
    description: 'The currently-persisted desired state.',
    responses: { 200: { description: 'Desired config' } },
  },
  async (_req: Request, res: Response) => {
    const response: ApiResponse<DesiredConfig> = {
      success: true,
      data: configStore.get(),
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

api.post(
  '/',
  {
    summary: 'Set desired config',
    description:
      'Persist desired state and trigger a reconcile. Body is the full DesiredConfig; missing fields fall back to schema defaults.',
    body: desiredConfigSchema,
    responses: {
      200: { description: 'Config accepted and reconcile triggered' },
      400: { description: 'Validation error' },
    },
  },
  async (req: Request, res: Response) => {
    const body = req.body as DesiredConfig;
    const updated = await configStore.update(body);
    // Fire-and-forget the reconcile so the POST returns promptly; errors are
    // logged inside the runner.
    void reconcileRunner.triggerNow();
    const response: ApiResponse<DesiredConfig> = {
      success: true,
      data: updated,
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

export const configRouter = api.router;

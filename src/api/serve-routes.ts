/**
 * GET/POST /api/serve — inspect / override the serve target.
 *
 * GET returns the current serve status + stored target + lastError.
 * POST forces a specific target (overriding the probe) and triggers a
 * reconcile, or clears the override (empty target → re-probe next tick).
 */

import { type Request, type Response } from 'express';
import { Type } from '@sinclair/typebox';
import { createApiRouter } from './openapi-registry.js';
import * as cli from '../tailscale/cli.js';
import { configStore } from '../services/config-store.js';
import { reconcileRunner } from '../services/reconcile-runner.js';
import type { ApiResponse } from '../types/index.js';

const api = createApiRouter('Serve');

const serveOverrideSchema = Type.Object(
  {
    // Empty string clears the override (documented reset); otherwise require a
    // valid http(s) URL.
    target: Type.Optional(
      Type.String({
        pattern: '^(?:|https?://[^\\s]+)$',
        description: 'Force this serve target; omit/empty to clear the override.',
      })
    ),
  },
  { $id: 'ServeOverride', additionalProperties: false }
);

api.get(
  '/',
  {
    summary: 'Inspect serve state',
    description: 'Current serve status (from tailscaled) plus stored target and lastError.',
    responses: { 200: { description: 'Serve state' } },
  },
  async (_req: Request, res: Response) => {
    let serve: unknown;
    try {
      serve = await cli.serveStatus();
    } catch {
      serve = {};
    }
    const response: ApiResponse<{
      serve: unknown;
      target: string | null;
      lastError: string | null;
    }> = {
      success: true,
      data: {
        serve,
        target: configStore.getServeTarget(),
        lastError: configStore.getServeLastError(),
      },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

api.post(
  '/',
  {
    summary: 'Override serve target',
    description: 'Force a serve target (or clear it), then reconcile.',
    body: serveOverrideSchema,
    responses: { 200: { description: 'Override applied' } },
  },
  async (req: Request, res: Response) => {
    const { target } = req.body as { target?: string };
    configStore.setServeTarget(target && target.trim() ? target.trim() : null);
    void reconcileRunner.triggerNow();
    const response: ApiResponse<{ target: string | null }> = {
      success: true,
      data: { target: configStore.getServeTarget() },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

export const serveRouter = api.router;

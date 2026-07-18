/**
 * GET/POST /api/routes — subnet-router advertised/accepted routes.
 *
 * A focused convenience over /api/config for the SettingsPanel: update just the
 * route intent and reconcile. Persisted through the same config store, so it
 * survives restarts and the reconciler applies it via `tailscale set`.
 */

import { type Request, type Response } from 'express';
import { Type } from '@sinclair/typebox';
import { createApiRouter } from './openapi-registry.js';
import { configStore } from '../services/config-store.js';
import { reconcileRunner } from '../services/reconcile-runner.js';
import type { ApiResponse } from '../types/index.js';

const api = createApiRouter('Routes');

// IPv4 octet 0–255, prefix 0–32 (matches src/schemas/config.ts).
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)';
const Cidr = Type.String({ pattern: `^${OCTET}(?:\\.${OCTET}){3}/(?:[0-9]|[12]\\d|3[0-2])$` });

const routesSchema = Type.Object(
  {
    advertiseRoutes: Type.Optional(Type.Array(Cidr)),
    acceptRoutes: Type.Optional(Type.Boolean()),
  },
  { $id: 'RoutesUpdate', additionalProperties: false }
);

api.get(
  '/',
  {
    summary: 'Get route config',
    description: 'Currently persisted advertised routes + acceptRoutes.',
    responses: { 200: { description: 'Route config' } },
  },
  async (_req: Request, res: Response) => {
    const cfg = configStore.get();
    const response: ApiResponse<{ advertiseRoutes: string[]; acceptRoutes: boolean }> = {
      success: true,
      data: { advertiseRoutes: cfg.advertiseRoutes, acceptRoutes: cfg.acceptRoutes },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

api.post(
  '/',
  {
    summary: 'Update routes',
    description: 'Set advertised routes and/or acceptRoutes, then reconcile.',
    body: routesSchema,
    responses: {
      200: { description: 'Routes updated' },
      400: { description: 'Validation error' },
    },
  },
  async (req: Request, res: Response) => {
    const body = req.body as { advertiseRoutes?: string[]; acceptRoutes?: boolean };
    const patch: { advertiseRoutes?: string[]; acceptRoutes?: boolean } = {};
    if (body.advertiseRoutes !== undefined) patch.advertiseRoutes = body.advertiseRoutes;
    if (body.acceptRoutes !== undefined) patch.acceptRoutes = body.acceptRoutes;
    let updated;
    try {
      updated = await configStore.update(patch);
    } catch (err) {
      res.status(500).json({
        success: false,
        error: { code: 'PERSIST_FAILED', message: (err as Error).message },
        timestamp: new Date().toISOString(),
      });
      return;
    }
    void reconcileRunner.triggerNow();
    const response: ApiResponse<{ advertiseRoutes: string[]; acceptRoutes: boolean }> = {
      success: true,
      data: { advertiseRoutes: updated.advertiseRoutes, acceptRoutes: updated.acceptRoutes },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

export const routesRouter = api.router;

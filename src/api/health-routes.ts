/**
 * GET /api/health — plugin ready-poll + Docker HEALTHCHECK.
 *
 * Reports the supervisor's view of tailscaled: running / starting / stopped /
 * error. The plugin polls this before marking itself ready; the container
 * HEALTHCHECK hits it too.
 */

import { type Request, type Response } from 'express';
import { createRequire } from 'module';
import { createApiRouter } from './openapi-registry.js';
import { supervisor } from '../tailscale/supervisor.js';
import type { ApiResponse } from '../types/index.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const api = createApiRouter('Health');

interface HealthCheck {
  status: 'healthy';
  tailscaled: 'running' | 'starting' | 'stopped' | 'error';
  version: string;
  uptime: number;
}

api.get(
  '/',
  {
    summary: 'Health check',
    description: 'Liveness of the shim + tailscaled supervisor state.',
    responses: {
      200: {
        description: 'Service is up',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                status: { type: 'string', examples: ['healthy'] },
                tailscaled: {
                  type: 'string',
                  examples: ['running', 'starting', 'stopped', 'error'],
                },
              },
            },
          },
        },
      },
    },
  },
  async (_req: Request, res: Response) => {
    const health: HealthCheck = {
      status: 'healthy',
      tailscaled: supervisor.getState(),
      version: packageJson.version || '0.0.1',
      uptime: process.uptime(),
    };
    const response: ApiResponse<HealthCheck> = {
      success: true,
      data: health,
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

export const healthRouter = api.router;

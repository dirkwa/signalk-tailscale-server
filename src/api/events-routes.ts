/**
 * GET /api/events — SSE stream of status snapshots.
 *
 * Cadence adapts to backend state: 2s while logging in / starting (the AuthURL
 * and state flips matter most then), 10s once Running. Keep-alive comment every
 * 25s so intermediaries don't drop an idle connection. Raw text/event-stream to
 * match the signalk-backup-server SSE convention.
 */

import { type Request, type Response } from 'express';
import { createApiRouter } from './openapi-registry.js';
import { getStatusSnapshot } from '../services/status-service.js';

const api = createApiRouter('Events');

const FAST_MS = 2_000;
const SLOW_MS = 10_000;
const KEEPALIVE_MS = 25_000;

api.get(
  '/',
  {
    summary: 'Stream status snapshots via SSE',
    description:
      'Server-Sent Events. Emits the full status snapshot every 2s while NeedsLogin/Starting, every 10s while Running. Stays open until the client disconnects.',
    responses: {
      200: {
        description: 'SSE stream of status snapshots',
        content: { 'text/event-stream': {} },
      },
    },
  },
  async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let closed = false;
    let tickTimer: NodeJS.Timeout | null = null;

    const keepalive = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n');
    }, KEEPALIVE_MS);

    const nextDelay = async (): Promise<number> => {
      try {
        const snapshot = await getStatusSnapshot();
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        return snapshot.backendState === 'Running' ? SLOW_MS : FAST_MS;
      } catch {
        // Keep the stream alive; try again on the fast cadence.
        return FAST_MS;
      }
    };

    const tick = async (): Promise<void> => {
      if (closed) return;
      const delay = await nextDelay();
      if (!closed) tickTimer = setTimeout(() => void tick(), delay);
    };

    void tick();

    res.on('close', () => {
      closed = true;
      clearInterval(keepalive);
      if (tickTimer) clearTimeout(tickTimer);
    });
  }
);

export const eventsRouter = api.router;

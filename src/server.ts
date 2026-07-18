/**
 * signalk-tailscale-server — Express entry point.
 *
 * Launched and managed by the signalk-tailscale plugin via signalk-container's
 * ensureRunning(). The plugin sets DATA_DIR (config.json + tailscale-state/),
 * SIGNALK_DATA_PATH, SIGNALK_VERSION, and HOST_HOSTNAME.
 *
 * Headless: no UI here. The webapp lives in the plugin (mounted by SignalK at
 * /signalk-tailscale/) and reaches us via the plugin's reverse-proxy at
 * /plugins/signalk-tailscale/api/.
 *
 * On boot: load persisted config → spawn tailscaled (userspace) → start the
 * reconcile loop (which auto-kicks login when NoState/NeedsLogin). On SIGTERM:
 * stop the loop and drain tailscaled — but NEVER logout (node key must survive).
 */

import express from 'express';
import { createServer } from 'http';
import { createRequire } from 'module';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';

import { config } from './config/index.js';
import { logger } from './services/logger.js';

import { healthRouter } from './api/health-routes.js';
import { statusRouter } from './api/status-routes.js';
import { loginRouter } from './api/login-routes.js';
import { logoutRouter } from './api/logout-routes.js';
import { configRouter } from './api/config-routes.js';
import { eventsRouter } from './api/events-routes.js';

import { supervisor } from './tailscale/supervisor.js';
import { configStore } from './services/config-store.js';
import { reconcileRunner } from './services/reconcile-runner.js';

import { setRoutePrefixByTag, generateOpenApiDocument } from './api/openapi-registry.js';

const require = createRequire(import.meta.url);
const pinoHttp = require('pino-http') as (opts?: {
  logger?: unknown;
  autoLogging?: boolean | { ignore?: (req: { url?: string }) => boolean };
}) => (req: unknown, res: unknown, next?: () => void) => void;

const app = express();

// Loopback-only CORS. The plugin reaches us via host loopback / the shared user
// network after signalk-container publishes the port; nothing else should talk
// to this process directly.
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/api/health',
    },
  })
);

app.use('/api/health', healthRouter);
app.use('/api/status', statusRouter);
app.use('/api/login', loginRouter);
app.use('/api/logout', logoutRouter);
app.use('/api/config', configRouter);
app.use('/api/events', eventsRouter);

setRoutePrefixByTag('Health', '/api/health');
setRoutePrefixByTag('Status', '/api/status');
setRoutePrefixByTag('Login', '/api/login');
setRoutePrefixByTag('Config', '/api/config');
setRoutePrefixByTag('Events', '/api/events');

const openApiDocument = generateOpenApiDocument();
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));
app.get('/api/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});

const server = createServer(app);

// Bind IPv4 explicitly: default `::` (IPv6) breaks rootless-podman+pasta
// healthchecks (pasta only bridges IPv4; ::1 hangs).
server.listen(config.port, '0.0.0.0', async () => {
  logger.info(
    {
      port: config.port,
      dataDir: config.dataDir,
      stateDir: config.tailscaleStateDir,
      signalkVersion: config.signalkVersion,
      hostHostname: config.hostHostname,
    },
    'signalk-tailscale-server listening (headless)'
  );

  try {
    await configStore.load();
  } catch (err) {
    logger.error({ err }, 'Failed to load desired config');
  }

  try {
    await supervisor.start();
  } catch (err) {
    logger.error({ err }, 'Failed to start tailscaled supervisor');
  }

  // The reconcile loop auto-kicks login when NoState/NeedsLogin, applies prefs
  // when Running. Offline-first: it never blocks startup and tolerates a
  // not-yet-ready daemon.
  reconcileRunner.start();
});

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down...');
  reconcileRunner.stop();

  // Drain tailscaled (SIGTERM → SIGKILL grace), then close HTTP. No logout.
  void supervisor.stop().finally(() => {
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown');
      process.exit(1);
    }, 12_000);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, server };

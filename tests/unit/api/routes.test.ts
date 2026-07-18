import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Keep the reconcile-runner inert (config POST triggers it) and the supervisor
// from spawning tailscaled when the health route imports it.
vi.mock('../../../src/services/reconcile-runner.js', () => ({
  reconcileRunner: { triggerNow: vi.fn(async () => undefined) },
}));
vi.mock('../../../src/tailscale/supervisor.js', () => ({
  supervisor: { getState: () => 'running' },
}));
// status-service reaches the CLI; stub it to a fixed snapshot.
vi.mock('../../../src/services/status-service.js', () => ({
  getStatusSnapshot: vi.fn(async () => ({
    backendState: 'NeedsLogin',
    authUrl: 'https://login.tailscale.com/a/abc',
    self: { hostName: null, dnsName: null, ipv4: null, ipv6: null, online: false },
    tailnet: { magicDNSSuffix: null, magicDNSEnabled: false },
    peerCount: 0,
    peersOnline: 0,
    serve: { enabled: false, target: null, httpsUrl: null, httpUrl: null, lastError: null },
    routes: { advertised: [], accepted: false },
    health: [],
    versions: { tailscale: '1.98.9', server: '0.1.0' },
  })),
}));

let dir: string;

async function buildApp() {
  vi.resetModules();
  const { healthRouter } = await import('../../../src/api/health-routes.js');
  const { statusRouter } = await import('../../../src/api/status-routes.js');
  const { configRouter } = await import('../../../src/api/config-routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRouter);
  app.use('/api/status', statusRouter);
  app.use('/api/config', configRouter);
  return app;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ts-api-'));
  vi.stubEnv('DATA_DIR', dir);
  // re-apply the mocks after resetModules inside buildApp
  vi.doMock('../../../src/services/reconcile-runner.js', () => ({
    reconcileRunner: { triggerNow: vi.fn(async () => undefined) },
  }));
  vi.doMock('../../../src/tailscale/supervisor.js', () => ({
    supervisor: { getState: () => 'running' },
  }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('returns the envelope with tailscaled state', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('healthy');
    expect(res.body.data.tailscaled).toBe('running');
    expect(typeof res.body.timestamp).toBe('string');
  });
});

describe('GET /api/status', () => {
  it('returns the flattened snapshot with the AuthURL', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.data.backendState).toBe('NeedsLogin');
    expect(res.body.data.authUrl).toBe('https://login.tailscale.com/a/abc');
  });
});

describe('POST /api/config', () => {
  it('accepts a valid desired config and echoes it back', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/config')
      .send({
        deviceHostname: 'boaty',
        enableServe: true,
        serveTargetCandidates: ['http://127.0.0.1:3000'],
        advertiseRoutes: ['192.168.0.0/24'],
        acceptRoutes: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.deviceHostname).toBe('boaty');
  });

  it('applies defaults for a minimal body', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/config').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.enableServe).toBe(true);
    expect(res.body.data.acceptRoutes).toBe(false);
    expect(res.body.data.serveTargetCandidates).toEqual([]);
  });

  it('rejects a bad candidate URL with 400', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/config')
      .send({ serveTargetCandidates: ['not-a-url'] });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a bad CIDR with 400', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/config').send({ advertiseRoutes: ['garbage'] });
    expect(res.status).toBe(400);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// config-store reads DATA_DIR via config/index at import time, so we set a temp
// DATA_DIR and import fresh in each test via vi.resetModules().
let dir: string;

async function freshStore() {
  vi.resetModules();
  const mod = await import('../../../src/services/config-store.js');
  return mod;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ts-cfg-'));
  vi.stubEnv('DATA_DIR', dir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('configStore', () => {
  it('returns defaults when no config.json exists', async () => {
    const { configStore, DEFAULT_DESIRED } = await freshStore();
    const loaded = await configStore.load();
    expect(loaded).toEqual(DEFAULT_DESIRED);
    expect(loaded.enableServe).toBe(true);
    expect(loaded.acceptRoutes).toBe(false);
  });

  it('persists an update atomically and re-reads it', async () => {
    const { configStore } = await freshStore();
    await configStore.load();
    await configStore.update({ deviceHostname: 'boaty', advertiseRoutes: ['192.168.0.0/24'] });

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(onDisk.deviceHostname).toBe('boaty');
    expect(onDisk.advertiseRoutes).toEqual(['192.168.0.0/24']);

    // A fresh store instance should load the persisted values.
    const { configStore: store2 } = await freshStore();
    const loaded = await store2.load();
    expect(loaded.deviceHostname).toBe('boaty');
    expect(loaded.enableServe).toBe(true); // default preserved through merge
  });

  it('merges persisted partial config over defaults', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), JSON.stringify({ acceptRoutes: true }), 'utf8');
    const { configStore } = await freshStore();
    const loaded = await configStore.load();
    expect(loaded.acceptRoutes).toBe(true);
    expect(loaded.enableServe).toBe(true); // filled from DEFAULT_DESIRED
  });

  it('tracks runtime-only serve target + lastError without persisting them', async () => {
    const { configStore } = await freshStore();
    await configStore.load();
    configStore.setServeTarget('http://host.containers.internal:3000');
    configStore.setServeLastError('cert not ready');
    expect(configStore.getServeTarget()).toBe('http://host.containers.internal:3000');
    expect(configStore.getServeLastError()).toBe('cert not ready');

    // Not written to config.json.
    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8').catch(() => '{}'));
    expect(onDisk.serveTarget).toBeUndefined();
    expect(onDisk.serveLastError).toBeUndefined();
  });
});

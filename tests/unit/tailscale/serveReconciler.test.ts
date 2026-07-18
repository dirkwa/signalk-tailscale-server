import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/tailscale/cli.js', () => ({
  serveStatus: vi.fn(),
  serve: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));
vi.mock('../../../src/tailscale/targetProbe.js', () => ({
  findServeTarget: vi.fn(),
  probeCandidate: vi.fn(),
}));

import * as cli from '../../../src/tailscale/cli.js';
import { findServeTarget, probeCandidate } from '../../../src/tailscale/targetProbe.js';
import { applyServe } from '../../../src/tailscale/serveReconciler.js';
import { configStore } from '../../../src/services/config-store.js';
import { STATUS_RUNNING } from '../../fixtures/status.js';
import type { DesiredConfig, ServeStatusJson } from '../../../src/types/tailscale.js';

const desired = (over: Partial<DesiredConfig> = {}): DesiredConfig => ({
  deviceHostname: '',
  enableServe: true,
  serveTargetCandidates: ['http://127.0.0.1:3000', 'http://host.containers.internal:3000'],
  advertiseRoutes: [],
  acceptRoutes: false,
  ...over,
});

const BOTH: ServeStatusJson = { TCP: { '443': { HTTPS: true }, '80': { HTTP: true } } };
const HTTP_ONLY: ServeStatusJson = { TCP: { '80': { HTTP: true } } };
const NONE: ServeStatusJson = {};
const FUNNEL: ServeStatusJson = { TCP: { '443': { HTTPS: true } }, AllowFunnel: { '443': true } };

beforeEach(() => {
  vi.clearAllMocks();
  configStore.setServeTarget(null);
  configStore.setServeLastError(null);
});

describe('applyServe — disable', () => {
  it('resets serve and clears target when enableServe=false and serve is configured', async () => {
    vi.mocked(cli.serveStatus).mockResolvedValue(BOTH);
    await applyServe(desired({ enableServe: false }), STATUS_RUNNING);
    expect(cli.serve).toHaveBeenCalledWith(['reset']);
    expect(configStore.getServeTarget()).toBeNull();
    expect(configStore.getServeLastError()).toBeNull();
  });

  it('does nothing when enableServe=false and serve is already empty', async () => {
    vi.mocked(cli.serveStatus).mockResolvedValue(NONE);
    await applyServe(desired({ enableServe: false }), STATUS_RUNNING);
    expect(cli.serve).not.toHaveBeenCalled();
  });
});

describe('applyServe — Funnel safety', () => {
  it('resets serve if Funnel is ever detected', async () => {
    vi.mocked(cli.serveStatus).mockResolvedValue(FUNNEL);
    vi.mocked(findServeTarget).mockResolvedValue('http://127.0.0.1:3000');
    // post-config verify returns both listeners
    vi.mocked(cli.serveStatus).mockResolvedValueOnce(FUNNEL).mockResolvedValueOnce(BOTH);
    await applyServe(desired(), STATUS_RUNNING);
    expect(cli.serve).toHaveBeenCalledWith(['reset']);
  });
});

describe('applyServe — configure', () => {
  it('probes and configures BOTH listeners for the found target', async () => {
    vi.mocked(cli.serveStatus).mockResolvedValueOnce(NONE).mockResolvedValueOnce(BOTH);
    vi.mocked(findServeTarget).mockResolvedValue('http://host.containers.internal:3000');
    await applyServe(desired(), STATUS_RUNNING);

    const calls = vi.mocked(cli.serve).mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual([
      '--bg',
      '--https=443',
      '--yes',
      'http://host.containers.internal:3000',
    ]);
    expect(calls).toContainEqual([
      '--bg',
      '--http=80',
      '--yes',
      'http://host.containers.internal:3000',
    ]);
    expect(configStore.getServeTarget()).toBe('http://host.containers.internal:3000');
    expect(configStore.getServeLastError()).toBeNull();
  });

  it('records the HTTPS-pending hint when only http comes up', async () => {
    vi.mocked(cli.serveStatus).mockResolvedValueOnce(NONE).mockResolvedValueOnce(HTTP_ONLY);
    vi.mocked(findServeTarget).mockResolvedValue('http://127.0.0.1:3000');
    await applyServe(desired(), STATUS_RUNNING);
    expect(configStore.getServeLastError()).toContain('HTTPS not available yet');
    expect(configStore.getServeLastError()).toContain('login.tailscale.com/admin/dns');
  });

  it('records a lastError when no candidate validates', async () => {
    vi.mocked(cli.serveStatus).mockResolvedValue(NONE);
    vi.mocked(findServeTarget).mockResolvedValue(null);
    await applyServe(desired(), STATUS_RUNNING);
    expect(configStore.getServeLastError()).toContain('No SignalK endpoint found');
    expect(cli.serve).not.toHaveBeenCalled();
  });

  it('is a no-op when both listeners already match the stored target', async () => {
    configStore.setServeTarget('http://127.0.0.1:3000');
    // Whether resolveTarget reuses the stored target (probe) or re-probes the
    // candidate list (findServeTarget), it lands on the same 127.0.0.1 target.
    vi.mocked(probeCandidate).mockResolvedValue(true);
    vi.mocked(findServeTarget).mockResolvedValue('http://127.0.0.1:3000');
    vi.mocked(cli.serveStatus).mockResolvedValue(BOTH);
    await applyServe(desired(), STATUS_RUNNING);
    // No reconfigure or reset calls (both listeners already present, no funnel).
    expect(cli.serve).not.toHaveBeenCalled();
    expect(configStore.getServeLastError()).toBeNull();
  });
});

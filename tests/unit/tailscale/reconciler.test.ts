import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the CLI + login manager before importing the reconciler.
vi.mock('../../../src/tailscale/cli.js', () => ({
  status: vi.fn(),
  set: vi.fn(async () => undefined),
}));
vi.mock('../../../src/tailscale/login.js', () => ({
  loginManager: {
    shouldReKick: vi.fn(),
    kick: vi.fn(),
    needsReset: vi.fn(() => false),
  },
}));

import * as cli from '../../../src/tailscale/cli.js';
import { loginManager } from '../../../src/tailscale/login.js';
import { reconcileOnce, effectiveHostname } from '../../../src/tailscale/reconciler.js';
import { config } from '../../../src/config/index.js';
import {
  STATUS_NEEDS_LOGIN,
  STATUS_NO_STATE,
  STATUS_RUNNING,
} from '../../fixtures/status.js';
import { DEFAULT_DESIRED } from '../../../src/services/config-store.js';
import type { DesiredConfig } from '../../../src/types/tailscale.js';

// config is a frozen singleton read from env at first import; derive the
// expected default hostname from whatever it actually resolved to (rather than
// assuming env-stub timing), so the assertion is stub-order-independent.
const EXPECTED_DEFAULT_HOST = `signalk-${config.hostHostname.trim() || 'boat'}`;

const desired = (over: Partial<DesiredConfig> = {}): DesiredConfig => ({
  ...DEFAULT_DESIRED,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('effectiveHostname', () => {
  it('uses explicit deviceHostname when set', () => {
    expect(effectiveHostname(desired({ deviceHostname: 'my-boat' }))).toBe('my-boat');
  });

  it('derives signalk-<HOST_HOSTNAME> when deviceHostname is empty', () => {
    expect(effectiveHostname(desired())).toBe(EXPECTED_DEFAULT_HOST);
  });
});

describe('reconcileOnce — login kick', () => {
  it('kicks login when NeedsLogin and shouldReKick=true', async () => {
    vi.mocked(cli.status).mockResolvedValue(STATUS_NEEDS_LOGIN);
    vi.mocked(loginManager.shouldReKick).mockReturnValue(true);

    await reconcileOnce({ getDesired: () => desired() });

    expect(loginManager.kick).toHaveBeenCalledWith(EXPECTED_DEFAULT_HOST, false);
    expect(cli.set).not.toHaveBeenCalled();
  });

  it('passes the status AuthURL into shouldReKick so a good pending login is not re-kicked', async () => {
    vi.mocked(cli.status).mockResolvedValue(STATUS_NEEDS_LOGIN);
    vi.mocked(loginManager.shouldReKick).mockReturnValue(false);

    await reconcileOnce({ getDesired: () => desired() });

    expect(loginManager.shouldReKick).toHaveBeenCalledWith(STATUS_NEEDS_LOGIN.AuthURL);
    expect(loginManager.kick).not.toHaveBeenCalled();
  });

  it('kicks from NoState too', async () => {
    vi.mocked(cli.status).mockResolvedValue(STATUS_NO_STATE);
    vi.mocked(loginManager.shouldReKick).mockReturnValue(true);
    await reconcileOnce({ getDesired: () => desired() });
    expect(loginManager.kick).toHaveBeenCalledOnce();
  });
});

describe('reconcileOnce — prefs when Running', () => {
  it('sets hostname when it differs from Self.HostName', async () => {
    vi.mocked(cli.status).mockResolvedValue(STATUS_RUNNING); // Self.HostName = signalk-boat
    await reconcileOnce({ getDesired: () => desired({ deviceHostname: 'renamed' }) });

    const flags = vi.mocked(cli.set).mock.calls[0]?.[0] ?? [];
    expect(flags).toContain('--hostname=renamed');
  });

  it('does NOT set hostname when it already matches', async () => {
    vi.mocked(cli.status).mockResolvedValue(STATUS_RUNNING);
    await reconcileOnce({ getDesired: () => desired({ deviceHostname: 'signalk-boat' }) });

    const flags = vi.mocked(cli.set).mock.calls[0]?.[0] ?? [];
    expect(flags.some((f) => f.startsWith('--hostname='))).toBe(false);
  });

  it('pushes accept-routes and clears advertise-routes when none desired', async () => {
    vi.mocked(cli.status).mockResolvedValue(STATUS_RUNNING);
    await reconcileOnce({ getDesired: () => desired({ acceptRoutes: true }) });

    const flags = vi.mocked(cli.set).mock.calls[0]?.[0] ?? [];
    expect(flags).toContain('--accept-routes=true');
    expect(flags).toContain('--advertise-routes=');
  });

  it('advertises the desired CIDRs joined by comma', async () => {
    vi.mocked(cli.status).mockResolvedValue(STATUS_RUNNING);
    await reconcileOnce({
      getDesired: () => desired({ advertiseRoutes: ['192.168.0.0/24', '10.0.0.0/8'] }),
    });

    const flags = vi.mocked(cli.set).mock.calls[0]?.[0] ?? [];
    expect(flags).toContain('--advertise-routes=192.168.0.0/24,10.0.0.0/8');
  });

  it('invokes the Phase-3 serve applier when provided', async () => {
    vi.mocked(cli.status).mockResolvedValue(STATUS_RUNNING);
    const applyServe = vi.fn(async () => undefined);
    await reconcileOnce({ getDesired: () => desired(), applyServe });
    expect(applyServe).toHaveBeenCalledOnce();
  });
});

describe('reconcileOnce — daemon not ready', () => {
  it('is a no-op when status() throws', async () => {
    vi.mocked(cli.status).mockRejectedValue(new Error('no socket'));
    await reconcileOnce({ getDesired: () => desired() });
    expect(loginManager.kick).not.toHaveBeenCalled();
    expect(cli.set).not.toHaveBeenCalled();
  });
});

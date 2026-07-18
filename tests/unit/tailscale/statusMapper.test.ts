import { describe, it, expect } from 'vitest';
import {
  mapStatus,
  normalizeHealth,
  deriveServe,
} from '../../../src/tailscale/statusMapper.js';
import {
  STATUS_NO_STATE,
  STATUS_NEEDS_LOGIN,
  STATUS_RUNNING,
  STATUS_RUNNING_HTTPS_PENDING,
} from '../../fixtures/status.js';
import type { ServeStatusJson } from '../../../src/types/tailscale.js';

const V = '0.1.0';

describe('mapStatus', () => {
  it('maps NoState to an empty shell', () => {
    const s = mapStatus({ status: STATUS_NO_STATE, serverVersion: V });
    expect(s.backendState).toBe('NoState');
    expect(s.authUrl).toBeNull();
    expect(s.self.online).toBe(false);
    expect(s.peerCount).toBe(0);
    expect(s.serve.enabled).toBe(false);
  });

  it('surfaces the AuthURL in NeedsLogin', () => {
    const s = mapStatus({ status: STATUS_NEEDS_LOGIN, serverVersion: V });
    expect(s.backendState).toBe('NeedsLogin');
    expect(s.authUrl).toBe('https://login.tailscale.com/a/f6372fb0106d9');
  });

  it('flattens a Running node (self, tailnet, peers, dnsName trimmed)', () => {
    const s = mapStatus({ status: STATUS_RUNNING, serverVersion: V });
    expect(s.backendState).toBe('Running');
    expect(s.self.hostName).toBe('signalk-boat');
    expect(s.self.dnsName).toBe('signalk-boat.tail1a2b3.ts.net'); // trailing dot stripped
    expect(s.self.ipv4).toBe('100.101.102.103');
    expect(s.self.ipv6).toBe('fd7a:115c:a1e0::1234');
    expect(s.tailnet.magicDNSSuffix).toBe('tail1a2b3.ts.net');
    expect(s.tailnet.magicDNSEnabled).toBe(true);
    expect(s.peerCount).toBe(2);
    expect(s.peersOnline).toBe(1);
    expect(s.versions.tailscale).toContain('1.98.9');
    expect(s.versions.server).toBe(V);
  });

  it('carries advertised routes + acceptRoutes from input', () => {
    const s = mapStatus({
      status: STATUS_RUNNING,
      serverVersion: V,
      advertisedRoutes: ['192.168.0.0/24'],
      acceptRoutes: true,
    });
    expect(s.routes.advertised).toEqual(['192.168.0.0/24']);
    expect(s.routes.accepted).toBe(true);
  });

  it('normalizes structured Health entries into strings', () => {
    const s = mapStatus({ status: STATUS_RUNNING_HTTPS_PENDING, serverVersion: V });
    expect(s.health).toHaveLength(1);
    expect(s.health[0]).toContain('HTTPS certificate');
    expect(s.health[0]).toContain('not yet available');
  });
});

describe('normalizeHealth', () => {
  it('handles undefined / empty', () => {
    expect(normalizeHealth(undefined)).toEqual([]);
    expect(normalizeHealth([])).toEqual([]);
  });

  it('passes through string[] health (older builds)', () => {
    expect(normalizeHealth(['some warning'])).toEqual(['some warning']);
  });

  it('joins Title + Text for structured entries', () => {
    expect(normalizeHealth([{ Title: 'A', Text: 'B' }])).toEqual(['A: B']);
  });
});

describe('deriveServe', () => {
  const self = STATUS_RUNNING.Self;

  it('reports both https + http URLs when both listeners are set', () => {
    const serve: ServeStatusJson = { TCP: { '443': { HTTPS: true }, '80': { HTTP: true } } };
    const out = deriveServe(self, serve, 'http://host.containers.internal:3000', null);
    expect(out.enabled).toBe(true);
    expect(out.httpsUrl).toBe('https://signalk-boat.tail1a2b3.ts.net');
    expect(out.httpUrl).toBe('http://signalk-boat.tail1a2b3.ts.net');
    expect(out.target).toBe('http://host.containers.internal:3000');
  });

  it('is disabled with no TCP listeners', () => {
    const out = deriveServe(self, {}, null, null);
    expect(out.enabled).toBe(false);
    expect(out.httpsUrl).toBeNull();
    expect(out.httpUrl).toBeNull();
  });

  it('passes through lastError (the cert hint source)', () => {
    const out = deriveServe(self, { TCP: { '80': { HTTP: true } } }, null, 'cert not ready');
    expect(out.lastError).toBe('cert not ready');
    expect(out.httpUrl).not.toBeNull();
    expect(out.httpsUrl).toBeNull();
  });
});

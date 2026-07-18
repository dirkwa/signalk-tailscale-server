/**
 * Recorded-shape `tailscale status --json` fixtures for the three states we
 * branch on. Shapes mirror ipnstate.Status on 1.98.x (the NeedsLogin+AuthURL
 * one matches what the Phase 0 spike produced verbatim).
 */

import type { TailscaleStatusJson } from '../../src/types/tailscale.js';

export const STATUS_NO_STATE: TailscaleStatusJson = {
  Version: '1.98.9-t4fb758c39-g200941d74',
  BackendState: 'NoState',
  AuthURL: '',
  Self: { HostName: '', Online: false },
};

export const STATUS_NEEDS_LOGIN: TailscaleStatusJson = {
  Version: '1.98.9-t4fb758c39-g200941d74',
  BackendState: 'NeedsLogin',
  AuthURL: 'https://login.tailscale.com/a/f6372fb0106d9',
  Self: { HostName: 'signalk-spike', Online: false },
};

export const STATUS_RUNNING: TailscaleStatusJson = {
  Version: '1.98.9-t4fb758c39-g200941d74',
  BackendState: 'Running',
  AuthURL: '',
  TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1234'],
  Self: {
    ID: 'nSELF',
    HostName: 'signalk-boat',
    DNSName: 'signalk-boat.tail1a2b3.ts.net.',
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1234'],
    Online: true,
    PrimaryRoutes: ['192.168.0.0/24'],
  },
  Peer: {
    nPEER1: { HostName: 'dirks-phone', Online: true, DNSName: 'dirks-phone.tail1a2b3.ts.net.' },
    nPEER2: { HostName: 'dirks-laptop', Online: false, DNSName: 'dirks-laptop.tail1a2b3.ts.net.' },
  },
  CurrentTailnet: {
    Name: 'dirk@example.com',
    MagicDNSSuffix: 'tail1a2b3.ts.net',
    MagicDNSEnabled: true,
  },
  Health: [],
};

export const STATUS_RUNNING_HTTPS_PENDING: TailscaleStatusJson = {
  ...STATUS_RUNNING,
  Health: [
    {
      Title: 'HTTPS certificate',
      Text: 'TLS cert for signalk-boat.tail1a2b3.ts.net is not yet available; enable HTTPS in the admin console.',
      Severity: 'medium',
    },
  ],
};

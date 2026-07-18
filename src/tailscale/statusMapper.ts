/**
 * Flatten raw `tailscale status --json` (+ optional serve status) into the
 * render-ready StatusSnapshot the plugin and webapp consume. Pure functions,
 * no I/O — so they're trivially testable against recorded fixtures.
 */

import type {
  TailscaleStatusJson,
  ServeStatusJson,
  StatusSnapshot,
  TailscaleNodeStatus,
  TailscaleHealthEntry,
} from '../types/tailscale.js';

function firstIpv4(ips: string[] | undefined): string | null {
  return ips?.find((ip) => !ip.includes(':')) ?? null;
}

function firstIpv6(ips: string[] | undefined): string | null {
  return ips?.find((ip) => ip.includes(':')) ?? null;
}

/** DNSName from tailscale carries a trailing dot; strip it for display. */
function trimDot(name: string | undefined | null): string | null {
  if (!name) return null;
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

/** Normalize Health entries (may be string[] on older builds, objects on newer). */
export function normalizeHealth(health: TailscaleStatusJson['Health']): string[] {
  if (!health) return [];
  return health
    .map((h) => {
      if (typeof h === 'string') return h;
      const e = h as TailscaleHealthEntry;
      return [e.Title, e.Text].filter(Boolean).join(': ') || null;
    })
    .filter((s): s is string => Boolean(s));
}

function countPeers(peer: TailscaleStatusJson['Peer']): {
  peerCount: number;
  peersOnline: number;
} {
  if (!peer) return { peerCount: 0, peersOnline: 0 };
  const nodes = Object.values(peer);
  return {
    peerCount: nodes.length,
    peersOnline: nodes.filter((n) => n.Online).length,
  };
}

/**
 * Derive serve URLs from a self node + serve status. In userspace mode we
 * always configure both :443 (https) and :80 (http); the reconciler records
 * lastError separately (passed in), since serve status alone can't tell us a
 * cert failed.
 */
export function deriveServe(
  self: TailscaleNodeStatus | undefined,
  serve: ServeStatusJson,
  target: string | null,
  lastError: string | null
): StatusSnapshot['serve'] {
  const dnsName = trimDot(self?.DNSName);
  const tcp = serve.TCP ?? {};
  const hasHttps = Boolean(tcp['443']?.HTTPS);
  const hasHttp = Boolean(tcp['80']?.HTTP);
  const enabled = hasHttps || hasHttp;

  return {
    enabled,
    target,
    httpsUrl: hasHttps && dnsName ? `https://${dnsName}` : null,
    httpUrl: hasHttp && dnsName ? `http://${dnsName}` : null,
    lastError,
  };
}

export interface MapStatusInput {
  status: TailscaleStatusJson;
  serve?: ServeStatusJson;
  serveTarget?: string | null;
  serveLastError?: string | null;
  advertisedRoutes?: string[];
  acceptRoutes?: boolean;
  serverVersion: string;
}

/** Build the flattened snapshot. */
export function mapStatus(input: MapStatusInput): StatusSnapshot {
  const { status, serve = {}, serverVersion } = input;
  const self = status.Self;
  const { peerCount, peersOnline } = countPeers(status.Peer);

  return {
    backendState: status.BackendState ?? 'NoState',
    authUrl: status.AuthURL || null,
    self: {
      hostName: self?.HostName ?? null,
      dnsName: trimDot(self?.DNSName),
      ipv4: firstIpv4(self?.TailscaleIPs ?? status.TailscaleIPs),
      ipv6: firstIpv6(self?.TailscaleIPs ?? status.TailscaleIPs),
      online: Boolean(self?.Online),
    },
    tailnet: {
      magicDNSSuffix: status.CurrentTailnet?.MagicDNSSuffix ?? null,
      magicDNSEnabled: Boolean(status.CurrentTailnet?.MagicDNSEnabled),
    },
    peerCount,
    peersOnline,
    serve: deriveServe(self, serve, input.serveTarget ?? null, input.serveLastError ?? null),
    routes: {
      advertised: input.advertisedRoutes ?? self?.PrimaryRoutes ?? [],
      accepted: Boolean(input.acceptRoutes),
    },
    health: normalizeHealth(status.Health),
    versions: {
      tailscale: status.Version ?? null,
      server: serverVersion,
    },
  };
}

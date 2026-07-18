/**
 * Types modelling the subset of Tailscale CLI JSON we consume, plus the
 * plugin↔shim desired-config contract and the flattened StatusSnapshot the
 * plugin/webapp actually render.
 *
 * The raw shapes mirror tailscale's ipnstate.Status / serve config as emitted
 * by `tailscale status --json` and `tailscale serve status --json` on 1.98.x
 * (verified in the Phase 0 spike). We only type the fields we read; unknown
 * fields are ignored.
 */

/** ipn.State values surfaced by `tailscale status --json` (BackendState). */
export type TailscaleBackendState =
  'NoState' | 'NeedsMachineAuth' | 'NeedsLogin' | 'Stopped' | 'Starting' | 'Running';

/** A peer or self node in ipnstate.Status.{Self,Peer}. */
export interface TailscaleNodeStatus {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  ExitNode?: boolean;
  PrimaryRoutes?: string[];
}

/** A single entry in ipnstate.Status.Health (v2 health warnings). */
export interface TailscaleHealthEntry {
  Title?: string;
  Text?: string;
  Severity?: string;
  WarnableCode?: string;
}

/** The subset of `tailscale status --json` (ipnstate.Status) we read. */
export interface TailscaleStatusJson {
  Version?: string;
  BackendState?: TailscaleBackendState;
  AuthURL?: string;
  TailscaleIPs?: string[];
  Self?: TailscaleNodeStatus;
  Peer?: Record<string, TailscaleNodeStatus>;
  CurrentTailnet?: {
    Name?: string;
    MagicDNSSuffix?: string;
    MagicDNSEnabled?: boolean;
  };
  /** Newer builds emit structured Health entries; older ones a string[]. */
  Health?: Array<TailscaleHealthEntry | string>;
}

/** The subset of `tailscale serve status --json` we read. Empty object = no serve. */
export interface ServeStatusJson {
  TCP?: Record<
    string,
    {
      HTTPS?: boolean;
      HTTP?: boolean;
    }
  >;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

/**
 * Desired state pushed by the plugin via POST /api/config. Persisted to
 * $DATA_DIR/config.json and fed to the reconciler. Kept out of container env
 * on purpose — env changes are drift-detected by signalk-container and would
 * recreate (churn) the container.
 */
export interface DesiredConfig {
  /** Tailscale device hostname; defaults to signalk-<HOST_HOSTNAME> when empty. */
  deviceHostname: string;
  /** Whether to run `tailscale serve` for the SignalK data path. */
  enableServe: boolean;
  /** Ordered serve-target candidates; the reconciler probes them in order. */
  serveTargetCandidates: string[];
  /** RFC1918 CIDRs to advertise as a subnet router (opt-in). */
  advertiseRoutes: string[];
  /** Whether this node accepts routes advertised by peers. */
  acceptRoutes: boolean;
}

/** Flattened, render-ready status the plugin and webapp consume. */
export interface StatusSnapshot {
  backendState: TailscaleBackendState;
  authUrl: string | null;
  self: {
    hostName: string | null;
    dnsName: string | null;
    ipv4: string | null;
    ipv6: string | null;
    online: boolean;
  };
  tailnet: {
    magicDNSSuffix: string | null;
    magicDNSEnabled: boolean;
  };
  peerCount: number;
  peersOnline: number;
  serve: {
    enabled: boolean;
    target: string | null;
    httpsUrl: string | null;
    httpUrl: string | null;
    lastError: string | null;
  };
  routes: {
    advertised: string[];
    accepted: boolean;
  };
  health: string[];
  versions: {
    tailscale: string | null;
    server: string;
  };
}

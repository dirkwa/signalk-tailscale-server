/**
 * tailscaled supervisor.
 *
 * Spawns `tailscaled --tun=userspace-networking` with the statedir + socket
 * flags validated in the Phase 0 spike, pipes its stdout/stderr line-by-line
 * into pino (so it surfaces via `podman logs` → the plugin's log stream), and
 * restarts it with exponential backoff (1s→60s) if it exits.
 *
 * userspace-networking (gVisor netstack) is mandatory: signalk-container grants
 * no CapAdd / /dev/net/tun / sysctls, so a kernel TUN is impossible. Inbound
 * traffic reaches SignalK only via `tailscale serve` (configured by the
 * reconciler), never kernel forwarding.
 *
 * On SIGTERM we drain the daemon (SIGTERM, then SIGKILL after a grace period)
 * but NEVER `tailscale logout` — the node key must survive restarts/recreates
 * so re-enabling reconnects without a new login.
 */

import { spawn, type ChildProcess } from 'child_process';
import { mkdir } from 'fs/promises';
import { config } from '../config/index.js';
import { logger } from '../services/logger.js';

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const DRAIN_GRACE_MS = 10_000;

export type SupervisorState = 'starting' | 'running' | 'stopped' | 'error';

/** How long tailscaled must stay up before we consider it stable and reset backoff. */
const STABILITY_MS = 30_000;

class TailscaledSupervisor {
  private child: ChildProcess | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private restartTimer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private starting = false;
  private shuttingDown = false;
  private state: SupervisorState = 'stopped';

  getState(): SupervisorState {
    return this.state;
  }

  /**
   * Idempotent: ensure the statedir exists (0700) and spawn tailscaled.
   * Serialized via `starting` so concurrent callers can't double-spawn while
   * the mkdir await is in flight. If the statedir can't be created, abort —
   * spawning without a writable statedir would lose the node key.
   */
  async start(): Promise<void> {
    if (this.child || this.starting || this.shuttingDown) return;
    this.starting = true;
    try {
      await mkdir(config.tailscaleStateDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.state = 'error';
      logger.error({ err, dir: config.tailscaleStateDir }, 'Failed to create tailscale statedir');
      this.starting = false;
      return;
    }
    if (this.child || this.shuttingDown) {
      this.starting = false;
      return;
    }
    this.spawn();
    this.starting = false;
  }

  private spawn(): void {
    if (this.shuttingDown) return;
    this.state = 'starting';

    // --statedir already implies --state=<statedir>/tailscaled.state, but we set
    // both explicitly so the state path is unmistakable in logs/ps. resolv.conf
    // is never touched in userspace/netstack mode; MagicDNS acceptance is
    // declined at `tailscale up`/`set` time via --accept-dns=false (login.ts),
    // which is what keeps host.containers.internal resolvable in-container.
    const args = [
      '--tun=userspace-networking',
      `--socket=${config.tailscaledSocket}`,
      `--statedir=${config.tailscaleStateDir}`,
      `--state=${config.tailscaleStateDir}/tailscaled.state`,
    ];

    logger.info({ bin: config.tailscaledBinaryPath, args }, 'Spawning tailscaled (userspace)');

    const child = spawn(config.tailscaledBinaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // tailscaled writes a log-config cache under $HOME/.cache (UserCacheDir).
      // Under --userns=keep-id the image's HOME (/data) is NOT writable — only
      // the bind-mounted DATA_DIR is (Phase 0 spike saw `mkdir /data/.cache:
      // permission denied`). Point HOME at DATA_DIR so the cache lands in the
      // writable mount regardless of uid mapping. statedir is passed explicitly
      // above, so this only affects the incidental cache/log path.
      env: { ...process.env, HOME: config.dataDir },
    });
    this.child = child;

    this.pipeLogs(child);

    child.once('spawn', () => {
      this.state = 'running';
      logger.info({ pid: child.pid }, 'tailscaled started');
      // Reset backoff only after it has STAYED up for STABILITY_MS. Resetting on
      // 'spawn' alone would defeat exponential backoff for a daemon that starts
      // then immediately crashes in a loop.
      this.clearStabilityTimer();
      this.stabilityTimer = setTimeout(() => {
        this.backoffMs = BACKOFF_MIN_MS;
        this.stabilityTimer = null;
      }, STABILITY_MS);
    });

    // exit and error share one cleanup+restart path so a spawn failure (error
    // without exit) still schedules a backoff restart instead of wedging.
    const onGone = (reason: 'exit' | 'error', detail: Record<string, unknown>): void => {
      if (this.child !== child) return; // stale handler from a replaced child
      this.child = null;
      this.clearStabilityTimer();
      if (this.shuttingDown) {
        this.state = 'stopped';
        logger.info({ reason, ...detail }, 'tailscaled gone during shutdown');
        return;
      }
      this.state = 'error';
      logger.warn(
        { reason, ...detail, backoffMs: this.backoffMs },
        'tailscaled gone; scheduling restart'
      );
      this.scheduleRestart();
    };

    child.once('exit', (code, signal) => onGone('exit', { code, signal }));
    child.once('error', (err) => onGone('error', { err }));
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  private pipeLogs(child: ChildProcess): void {
    const forward = (stream: NodeJS.ReadableStream | null, level: 'info' | 'warn') => {
      if (!stream) return;
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trimEnd();
          buf = buf.slice(nl + 1);
          if (line) logger[level]({ src: 'tailscaled' }, line);
        }
      });
    };
    forward(child.stdout, 'info');
    forward(child.stderr, 'warn');
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.shuttingDown) return;
    const delay = this.backoffMs;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      this.spawn();
    }, delay);
  }

  /**
   * Graceful shutdown: SIGTERM the daemon, escalate to SIGKILL after the drain
   * grace. Resolves when the child is gone (or immediately if none). No logout.
   */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearStabilityTimer();
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      return;
    }

    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        logger.warn('tailscaled did not exit in time; sending SIGKILL');
        child.kill('SIGKILL');
      }, DRAIN_GRACE_MS);

      child.once('exit', () => {
        clearTimeout(kill);
        this.state = 'stopped';
        resolve();
      });

      child.kill('SIGTERM');
    });
  }
}

export const supervisor = new TailscaledSupervisor();

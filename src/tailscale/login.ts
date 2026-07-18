/**
 * Interactive login kick.
 *
 * `tailscale up` blocks until login completes (tailscale/tailscale#3950), so we
 * can't await it — we spawn it detached-ish (tracked child) and read the
 * AuthURL out of `tailscale status --json` (primary; confirmed ~3s in the
 * Phase 0 spike) or scrape it from `up` stdout (fallback). The child stays
 * alive until the user authenticates or we re-kick.
 *
 * Re-kick heuristic: if we've been NeedsLogin for longer than
 * STALE_LOGIN_MS without ever surfacing a URL (or the child died), kill and
 * respawn so a wedged/expired attempt self-heals.
 */

import { spawn, type ChildProcess } from 'child_process';
import { config } from '../config/index.js';
import { logger } from '../services/logger.js';

const STALE_LOGIN_MS = 10 * 60 * 1000;

/** Matches the URL tailscale prints under "To authenticate, visit:". */
const AUTH_URL_RE = /(https:\/\/login\.tailscale\.com\/[^\s]+)/;

class LoginManager {
  private child: ChildProcess | null = null;
  private startedAt = 0;
  private scrapedUrl: string | null = null;

  /** True while a login child is alive. */
  isRunning(): boolean {
    return this.child != null;
  }

  /** AuthURL scraped from `up` stdout, if any (status --json is preferred). */
  getScrapedUrl(): string | null {
    return this.scrapedUrl;
  }

  /**
   * Kick (or re-kick) an interactive login. `--reset` clears any conflicting
   * prefs from a prior state; `--timeout=0` means `up` waits indefinitely for
   * auth (we manage lifetime ourselves). Safe to call repeatedly — an existing
   * child is killed first.
   */
  kick(hostname: string): void {
    this.killChild('re-kick');
    this.scrapedUrl = null;
    this.startedAt = Date.now();

    const args = [
      `--socket=${config.tailscaledSocket}`,
      'up',
      `--hostname=${hostname}`,
      '--accept-dns=false',
      '--reset',
      '--timeout=0',
    ];
    logger.info({ hostname }, 'Kicking interactive login (tailscale up)');

    const child = spawn(config.tailscaleBinaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // HOME→DATA_DIR for the same writable-cache reason as the supervisor.
      env: { ...process.env, HOME: config.dataDir },
    });
    this.child = child;

    const scan = (chunk: Buffer) => {
      const m = AUTH_URL_RE.exec(chunk.toString('utf8'));
      if (m && m[1] && this.scrapedUrl !== m[1]) {
        this.scrapedUrl = m[1];
        logger.info('AuthURL scraped from tailscale up stdout');
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);

    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      // Exit 0 = login completed (BackendState will flip to Running). Non-zero
      // without our kill is a failure the reconciler will notice and re-kick.
      logger.info({ code, signal }, 'tailscale up child exited');
    });
    child.once('error', (err) => {
      // Guard on identity like the exit handler, so a spawn error on an old
      // child never clears a newer one.
      if (this.child === child) this.child = null;
      logger.error({ err }, 'tailscale up spawn error');
    });
  }

  /**
   * Should the reconciler re-kick? True when no child is alive, or the current
   * attempt has been running past STALE_LOGIN_MS without producing a URL
   * (neither scraped here nor surfaced in status — the caller passes the
   * status AuthURL so we don't re-kick a perfectly good pending login).
   */
  shouldReKick(statusAuthUrl: string | null): boolean {
    if (!this.child) return true;
    const haveUrl = Boolean(statusAuthUrl || this.scrapedUrl);
    if (haveUrl) return false;
    return Date.now() - this.startedAt > STALE_LOGIN_MS;
  }

  /** Kill the login child (used on re-kick and shutdown). */
  killChild(reason: string): void {
    if (this.child) {
      logger.debug({ reason }, 'Killing tailscale up child');
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }
}

export const loginManager = new LoginManager();

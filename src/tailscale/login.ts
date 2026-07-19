/**
 * Interactive login kick.
 *
 * `tailscale up` blocks until login completes (tailscale/tailscale#3950), so we
 * can't await it — we spawn it detached-ish (tracked child) and read the
 * AuthURL out of `tailscale status --json` (primary; confirmed ~3s in the
 * Phase 0 spike) or scrape it from `up` stdout (fallback).
 *
 * CRITICAL — do not churn a pending login. Once an AuthURL exists, that login
 * URL is what the user authenticates against; re-kicking (especially with
 * `--reset`) mints a NEW node key + URL and invalidates the one they're about
 * to (or just did) approve. Observed on a real box: the `up` child could exit
 * non-zero immediately, and a naive "child died → re-kick" loop generated a
 * fresh URL every reconcile tick, so the node registered but never reached
 * Running. So:
 *   - Once we have a URL, we DON'T re-kick until STALE_LOGIN_MS, regardless of
 *     whether the child is still alive. tailscaled keeps the pending login
 *     server-side; when the user approves it, BackendState flips to Running on
 *     its own — no child needed to "await" it.
 *   - `--reset` is used ONLY on the first kick of a fresh session (or an
 *     explicit re-login), never on the routine self-heal re-kick.
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
  /** True after the first kick — subsequent self-heal kicks skip `--reset`. */
  private hasKicked = false;

  /** True while a login child is alive. */
  isRunning(): boolean {
    return this.child != null;
  }

  /** AuthURL scraped from `up` stdout, if any (status --json is preferred). */
  getScrapedUrl(): string | null {
    return this.scrapedUrl;
  }

  /**
   * Kick an interactive login. Pass reset=true to force a fresh node key
   * (`--reset`) — used for the first kick of a session and explicit re-login;
   * NOT for the routine self-heal re-kick, which must not invalidate a pending
   * URL. `--timeout=0` means `up` waits indefinitely (we manage lifetime).
   */
  kick(hostname: string, reset = false): void {
    this.killChild('re-kick');
    this.scrapedUrl = null;
    this.startedAt = Date.now();
    this.hasKicked = true;

    const args = [
      `--socket=${config.tailscaledSocket}`,
      'up',
      `--hostname=${hostname}`,
      '--accept-dns=false',
      ...(reset ? ['--reset'] : []),
      '--timeout=0',
    ];
    logger.info({ hostname, reset }, 'Kicking interactive login (tailscale up)');

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
      // The child exiting does NOT mean login failed — tailscaled keeps the
      // pending login and flips to Running when the user approves the URL.
      // shouldReKick() deliberately does not treat a dead child as "re-kick
      // now" while a URL is still pending.
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
   * Should the reconciler kick a login? Given the current status AuthURL:
   *   - Never kicked yet → yes (first kick; caller uses reset=true).
   *   - The attempt has been running > STALE_LOGIN_MS → yes (self-heal,
   *     reset=false). This applies EVEN IF a URL is pending: an AuthURL the user
   *     never completes must not pin the node offline forever — after the stale
   *     window we re-kick for a fresh URL (without --reset, so the node key is
   *     preserved and a genuinely-approved login still lands).
   *   - A URL exists (status or scraped) within the stale window → NO, even if
   *     the child died: that pending login is what the user is authenticating;
   *     re-kicking now would churn it.
   *   - No URL yet, within the stale window → NO (give it time to surface one).
   */
  shouldReKick(_statusAuthUrl: string | null): boolean {
    if (!this.hasKicked) return true;
    // Within the stale window, never re-kick — a pending URL (status or
    // scraped) is being authenticated, and a not-yet-surfaced URL just needs
    // time. Past the window, re-kick regardless (self-heal a wedged attempt).
    return Date.now() - this.startedAt > STALE_LOGIN_MS;
  }

  /** Whether the next kick should pass --reset (only the very first one). */
  needsReset(): boolean {
    return !this.hasKicked;
  }

  /** Kill the login child (used on re-kick and shutdown). */
  killChild(reason: string): void {
    if (this.child) {
      logger.debug({ reason }, 'Killing tailscale up child');
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  /** Reset session state so the next kick is treated as a fresh login (--reset). */
  resetSession(): void {
    this.hasKicked = false;
    this.scrapedUrl = null;
  }
}

export const loginManager = new LoginManager();

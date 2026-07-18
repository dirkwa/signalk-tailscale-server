/**
 * Thin execFile wrapper around the `tailscale` CLI.
 *
 * Everything that talks to tailscaled goes through here so the transport (CLI
 * today, a LocalAPI HTTP client over the unix socket later) lives behind one
 * seam. All calls pass `--socket=<config.tailscaledSocket>` so we address the
 * container-local daemon explicitly regardless of cwd or default socket path.
 *
 * The one long-running child — the blocking `tailscale up` login kick — is NOT
 * launched here; see tailscale/login.ts. This module is for short,
 * fire-and-collect commands (status/set/serve/logout).
 */

import { execFile } from 'child_process';
import { config } from '../config/index.js';
import { logger } from '../services/logger.js';
import type {
  TailscaleStatusJson,
  ServeStatusJson,
  TailscaleBackendState,
} from '../types/tailscale.js';

/** Default timeout for a short CLI call. `status`/`set`/`serve` are all quick. */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface CliResult {
  stdout: string;
  stderr: string;
}

export class TailscaleCliError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string
  ) {
    super(message);
    this.name = 'TailscaleCliError';
  }
}

/**
 * Run `tailscale <args...>` with the configured socket. Rejects with a
 * TailscaleCliError carrying stderr on non-zero exit.
 */
export function runTailscale(
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<CliResult> {
  const fullArgs = [`--socket=${config.tailscaledSocket}`, ...args];
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    execFile(
      config.tailscaleBinaryPath,
      fullArgs,
      { timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code =
            typeof (err as { code?: number }).code === 'number'
              ? (err as { code?: number }).code!
              : null;
          logger.debug({ args, code, stderr: stderr?.slice(0, 500) }, 'tailscale CLI error');
          reject(
            new TailscaleCliError(
              `tailscale ${args.join(' ')} failed (${code ?? 'signal'}): ${stderr || err.message}`,
              args,
              code,
              stderr ?? ''
            )
          );
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

/** `tailscale status --json` → parsed ipnstate.Status subset. */
export async function status(): Promise<TailscaleStatusJson> {
  const { stdout } = await runTailscale(['status', '--json']);
  return JSON.parse(stdout) as TailscaleStatusJson;
}

/**
 * BackendState only, tolerant of a not-yet-ready daemon: if the socket isn't up
 * or the daemon has no state, report NoState rather than throwing so the
 * reconciler/health can treat "starting" uniformly.
 */
export async function backendState(): Promise<TailscaleBackendState> {
  try {
    const s = await status();
    return s.BackendState ?? 'NoState';
  } catch {
    return 'NoState';
  }
}

/** `tailscale set <flags...>` — apply prefs (hostname, routes, accept-routes). */
export async function set(flags: string[]): Promise<void> {
  await runTailscale(['set', ...flags]);
}

/** `tailscale serve status --json` → parsed serve config ({} when none). */
export async function serveStatus(): Promise<ServeStatusJson> {
  const { stdout } = await runTailscale(['serve', 'status', '--json']);
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') return {};
  return JSON.parse(trimmed) as ServeStatusJson;
}

/** `tailscale serve <args...>` — configure/clear a serve listener. */
export async function serve(args: string[]): Promise<CliResult> {
  return runTailscale(['serve', ...args]);
}

/** `tailscale logout` — clears node key (explicit user action only). */
export async function logout(): Promise<void> {
  await runTailscale(['logout'], { timeoutMs: 30_000 });
}

/** `tailscale version` first line, or null if unavailable. */
export async function version(): Promise<string | null> {
  try {
    const { stdout } = await runTailscale(['version']);
    return stdout.split('\n')[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

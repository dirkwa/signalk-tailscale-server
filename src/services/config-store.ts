/**
 * Desired-config store.
 *
 * The plugin pushes desired state via POST /api/config; we persist it to
 * $DATA_DIR/config.json and hand it to the reconciler. Config deliberately does
 * NOT flow through container env — env changes are drift-detected by
 * signalk-container and would recreate (churn) the container on every edit.
 *
 * Also holds small runtime-only state that isn't part of desired config but is
 * reported in status: the currently-active serve target and the last serve
 * error (e.g. cert-not-ready), which the webapp turns into the "Enable HTTPS"
 * hint.
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { dirname } from 'path';
import { config, configFilePath } from '../config/index.js';
import { logger } from '../services/logger.js';
import type { DesiredConfig } from '../types/tailscale.js';

/** Factory for the defaults — fresh arrays each call, never a shared reference. */
export function defaultDesired(): DesiredConfig {
  return {
    deviceHostname: '',
    enableServe: true,
    serveTargetCandidates: [],
    advertiseRoutes: [],
    acceptRoutes: false,
  };
}

/**
 * Back-compat constant, frozen so an accidental top-level mutation throws.
 * Internal code uses defaultDesired()/cloneDesired() for writable copies; this
 * is kept for tests/consumers that only read or spread it.
 */
export const DEFAULT_DESIRED: DesiredConfig = Object.freeze(defaultDesired());

/** Deep copy with fresh arrays, so callers can't mutate internal state. */
function cloneDesired(c: DesiredConfig): DesiredConfig {
  return {
    ...c,
    serveTargetCandidates: [...c.serveTargetCandidates],
    advertiseRoutes: [...c.advertiseRoutes],
  };
}

class ConfigStore {
  private desired: DesiredConfig = defaultDesired();
  private loaded = false;

  private serveTarget: string | null = null;
  private serveLastError: string | null = null;

  /** Load persisted config from disk (once). Missing file → defaults. */
  async load(): Promise<DesiredConfig> {
    if (this.loaded) return cloneDesired(this.desired);
    try {
      const raw = await readFile(configFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<DesiredConfig>;
      this.desired = { ...defaultDesired(), ...parsed };
      logger.info({ path: configFilePath() }, 'Loaded desired config');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        logger.warn({ err }, 'Failed to read config.json; using defaults');
      }
      this.desired = defaultDesired();
    }
    this.loaded = true;
    return cloneDesired(this.desired);
  }

  /** A defensive copy — mutating the result never touches internal state. */
  get(): DesiredConfig {
    return cloneDesired(this.desired);
  }

  /**
   * Merge a patch against the latest state, persist, and commit to memory ONLY
   * after the write succeeds — a failed write leaves in-memory state unchanged
   * and rejects, so the API layer reports the failure. Updates are serialized on
   * the write chain, so overlapping POSTs merge in order without interleaving.
   */
  async update(patch: Partial<DesiredConfig>): Promise<DesiredConfig> {
    return this.enqueue(async () => {
      const next = cloneDesired({ ...this.desired, ...patch });
      await this.persist(next);
      this.desired = next;
      return cloneDesired(next);
    });
  }

  // Single-lane queue: each update() runs after the previous settles, so the
  // merge reads the committed state (not a mid-flight one) and writes stay
  // ordered.
  private updateChain: Promise<unknown> = Promise.resolve();
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.updateChain.then(task, task);
    this.updateChain = run.catch(() => undefined);
    return run;
  }

  private writeSeq = 0;

  /**
   * Atomic write via a unique temp file + rename. Serialization is handled by
   * the update queue (enqueue), so a unique temp name is belt-and-braces
   * against any stray concurrent writer. Rethrows on failure.
   */
  private async persist(snapshot: DesiredConfig): Promise<void> {
    const path = configFilePath();
    const tmp = `${path}.tmp.${process.pid}.${++this.writeSeq}`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      await rename(tmp, path);
    } catch (err) {
      logger.error({ err, path }, 'Failed to persist config.json');
      throw err;
    }
  }

  // --- runtime-only serve state (reported in status, not persisted) ---

  getServeTarget(): string | null {
    return this.serveTarget;
  }

  setServeTarget(target: string | null): void {
    this.serveTarget = target;
  }

  getServeLastError(): string | null {
    return this.serveLastError;
  }

  setServeLastError(err: string | null): void {
    this.serveLastError = err;
  }
}

export const configStore = new ConfigStore();

/** Exposed for symmetry with config/index; some tests import the raw path. */
export { configFilePath, config };

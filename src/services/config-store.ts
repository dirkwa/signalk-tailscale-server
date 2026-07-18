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

export const DEFAULT_DESIRED: DesiredConfig = {
  deviceHostname: '',
  enableServe: true,
  serveTargetCandidates: [],
  advertiseRoutes: [],
  acceptRoutes: false,
};

class ConfigStore {
  private desired: DesiredConfig = { ...DEFAULT_DESIRED };
  private loaded = false;

  private serveTarget: string | null = null;
  private serveLastError: string | null = null;

  /** Load persisted config from disk (once). Missing file → defaults. */
  async load(): Promise<DesiredConfig> {
    if (this.loaded) return this.desired;
    try {
      const raw = await readFile(configFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<DesiredConfig>;
      this.desired = { ...DEFAULT_DESIRED, ...parsed };
      logger.info({ path: configFilePath() }, 'Loaded desired config');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        logger.warn({ err }, 'Failed to read config.json; using defaults');
      }
      this.desired = { ...DEFAULT_DESIRED };
    }
    this.loaded = true;
    return this.desired;
  }

  get(): DesiredConfig {
    return this.desired;
  }

  /**
   * Merge a partial update, persist atomically, and return the new config.
   * Rejects (after logging) if the write fails, so the API layer can report the
   * failure instead of falsely acknowledging a save.
   */
  async update(patch: Partial<DesiredConfig>): Promise<DesiredConfig> {
    this.desired = { ...this.desired, ...patch };
    await this.persist(this.desired);
    return this.desired;
  }

  private writeChain: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  /**
   * Serialize concurrent writes onto a single chain (two overlapping POSTs
   * must not interleave temp-file writes), snapshot the value at call time, and
   * use a unique temp name per write so a stalled write can't clobber another.
   * Rethrows on failure.
   */
  private persist(snapshot: DesiredConfig): Promise<void> {
    const run = async (): Promise<void> => {
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
    };
    // Chain after the previous write regardless of its outcome.
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
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

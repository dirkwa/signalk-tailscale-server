/**
 * Owns the reconcile timer and adaptive cadence.
 *
 * Fast cadence (2s) while we're not yet Running — that's when the AuthURL and
 * state transitions matter most; slow cadence (15s) once Running to keep prefs
 * in sync without hammering the CLI. `triggerNow()` runs an immediate pass
 * (used right after a config POST) and reschedules.
 *
 * The Phase-3 serve applier is injected via setServeApplier() so this module
 * doesn't depend on the (not-yet-written) probe/serve code.
 */

import { reconcileOnce, type ReconcileDeps } from '../tailscale/reconciler.js';
import { configStore } from './config-store.js';
import * as cli from '../tailscale/cli.js';
import { logger } from '../services/logger.js';
import type { DesiredConfig, TailscaleStatusJson } from '../types/tailscale.js';

const FAST_MS = 2_000;
const SLOW_MS = 15_000;

class ReconcileRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private serveApplier:
    ((desired: DesiredConfig, status: TailscaleStatusJson) => Promise<void>) | undefined;

  /** Phase 3 injects the serve/probe applier here. */
  setServeApplier(
    fn: (desired: DesiredConfig, status: TailscaleStatusJson) => Promise<void>
  ): void {
    this.serveApplier = fn;
  }

  private deps(): ReconcileDeps {
    return {
      getDesired: () => configStore.get(),
      applyServe: this.serveApplier,
    };
  }

  start(): void {
    this.stopped = false;
    this.schedule(FAST_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Run one pass now (e.g. after a config change) and reschedule from here. */
  async triggerNow(): Promise<void> {
    await this.runPass();
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runPass(), delay);
  }

  private async runPass(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await reconcileOnce(this.deps());
    } catch (err) {
      logger.error({ err }, 'reconcile pass threw');
    } finally {
      this.running = false;
    }
    // Choose next cadence by observed state. backendState() swallows its own
    // errors (→ NoState), so the fast path is the natural default.
    const state = await cli.backendState();
    this.schedule(state === 'Running' ? SLOW_MS : FAST_MS);
  }
}

export const reconcileRunner = new ReconcileRunner();

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
  private pendingTrigger = false;
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

  /**
   * Run one pass now (e.g. after a config change) and reschedule from here. If a
   * pass is already running, set pendingTrigger so exactly one follow-up pass
   * runs after it completes — a config POST that arrives mid-pass must not be
   * dropped until the next scheduled tick.
   */
  async triggerNow(): Promise<void> {
    if (this.running) {
      this.pendingTrigger = true;
      return;
    }
    await this.runPass();
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runPass(), delay);
  }

  private async runPass(): Promise<void> {
    if (this.running || this.stopped) return;
    // Hold `running` across the pass AND the cadence read + reschedule, so a
    // triggerNow() arriving mid-pass can't start an overlapping reconcileOnce.
    this.running = true;
    // A trigger that landed while this pass was starting is about to be served
    // by this pass, so clear it now; only triggers during the pass re-set it.
    this.pendingTrigger = false;
    try {
      await reconcileOnce(this.deps());
      // Choose next cadence by observed state; default fast if the read fails
      // (e.g. daemon momentarily unavailable) so we retry promptly.
      let fast = true;
      try {
        fast = (await cli.backendState()) !== 'Running';
      } catch (err) {
        logger.debug({ err }, 'reconcile: cadence backendState read failed; using fast');
      }
      this.schedule(fast ? FAST_MS : SLOW_MS);
    } catch (err) {
      logger.error({ err }, 'reconcile pass threw');
      this.schedule(FAST_MS);
    } finally {
      this.running = false;
    }
    // A config change arrived mid-pass — run exactly one immediate follow-up so
    // it isn't stranded until the next scheduled tick.
    if (this.pendingTrigger && !this.stopped) {
      void this.runPass();
    }
  }
}

export const reconcileRunner = new ReconcileRunner();

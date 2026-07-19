import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Stub child_process.spawn so kick() doesn't launch a real `tailscale up`.
const spawned: FakeChild[] = [];
const spawnArgs: string[][] = [];
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(_sig?: string): boolean {
    this.killed = true;
    // Simulate async exit on kill.
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}
vi.mock('child_process', () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    spawnArgs.push(args);
    const c = new FakeChild();
    spawned.push(c);
    return c;
  }),
}));

import { loginManager } from '../../../src/tailscale/login.js';

beforeEach(() => {
  spawned.length = 0;
  spawnArgs.length = 0;
  // The manager is a module singleton; reset session state between tests.
  loginManager.killChild('test-reset');
  loginManager.resetSession();
  vi.useFakeTimers();
});
afterEach(() => {
  loginManager.killChild('test-cleanup');
  loginManager.resetSession();
  vi.useRealTimers();
});

describe('loginManager.shouldReKick', () => {
  it('kicks when never kicked yet (fresh session)', () => {
    loginManager.resetSession();
    expect(loginManager.shouldReKick(null)).toBe(true);
    expect(loginManager.needsReset()).toBe(true);
  });

  it('does NOT re-kick when a status AuthURL is present', () => {
    loginManager.kick('signalk-test');
    expect(loginManager.shouldReKick('https://login.tailscale.com/a/abc')).toBe(false);
  });

  it('does NOT re-kick a fresh attempt that has no URL yet (within the stale window)', () => {
    loginManager.kick('signalk-test');
    expect(loginManager.shouldReKick(null)).toBe(false);
  });

  // The core churn fix: a dead child + a pending status AuthURL must NOT
  // re-kick — that pending URL is what the user authenticates.
  it('does NOT re-kick after the child EXITS while a status AuthURL is pending', () => {
    loginManager.kick('signalk-test');
    const child = spawned[spawned.length - 1]!;
    child.emit('exit', 1, null); // up exits non-zero immediately (the real bug)
    expect(loginManager.isRunning()).toBe(false);
    // Status still shows the pending login → do not churn it.
    expect(loginManager.shouldReKick('https://login.tailscale.com/a/pending')).toBe(false);
  });

  it('re-kicks (without reset) only after STALE_LOGIN_MS with no URL', () => {
    loginManager.kick('signalk-test');
    expect(loginManager.shouldReKick(null)).toBe(false);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(loginManager.shouldReKick(null)).toBe(true);
    // A self-heal re-kick must NOT reset (would invalidate a pending login).
    expect(loginManager.needsReset()).toBe(false);
  });

  it('scrapes the AuthURL from up stdout as a fallback and does not re-kick on it', () => {
    loginManager.kick('signalk-test');
    const child = spawned[spawned.length - 1]!;
    child.stdout.emit(
      'data',
      Buffer.from('\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/deadbeef\n')
    );
    expect(loginManager.getScrapedUrl()).toBe('https://login.tailscale.com/a/deadbeef');
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(loginManager.shouldReKick(null)).toBe(false);
  });

  it('kills the previous child when re-kicked', () => {
    loginManager.kick('signalk-test');
    const first = spawned[spawned.length - 1]!;
    loginManager.kick('signalk-test');
    expect(first.killed).toBe(true);
    expect(spawned).toHaveLength(2);
  });
});

describe('loginManager reset semantics', () => {
  it('passes --reset only when kick(reset=true)', () => {
    loginManager.resetSession();
    loginManager.kick('signalk-test', true);
    const withReset = spawnArgs[spawnArgs.length - 1]!;
    expect(withReset).toContain('--reset');

    loginManager.kick('signalk-test', false);
    const noReset = spawnArgs[spawnArgs.length - 1]!;
    expect(noReset).not.toContain('--reset');
  });

  it('needsReset() is true only before the first kick / after resetSession', () => {
    loginManager.resetSession();
    expect(loginManager.needsReset()).toBe(true);
    loginManager.kick('signalk-test');
    expect(loginManager.needsReset()).toBe(false);
    loginManager.resetSession();
    expect(loginManager.needsReset()).toBe(true);
  });
});

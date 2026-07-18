import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Stub child_process.spawn so kick() doesn't launch a real `tailscale up`.
const spawned: FakeChild[] = [];
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
  spawn: vi.fn(() => {
    const c = new FakeChild();
    spawned.push(c);
    return c;
  }),
}));

import { loginManager } from '../../../src/tailscale/login.js';

beforeEach(() => {
  spawned.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  loginManager.killChild('test-cleanup');
  vi.useRealTimers();
});

describe('loginManager.shouldReKick', () => {
  it('re-kicks when no child is running', () => {
    expect(loginManager.isRunning()).toBe(false);
    expect(loginManager.shouldReKick(null)).toBe(true);
  });

  it('does NOT re-kick when a status AuthURL is present', () => {
    loginManager.kick('signalk-test');
    expect(loginManager.isRunning()).toBe(true);
    expect(loginManager.shouldReKick('https://login.tailscale.com/a/abc')).toBe(false);
  });

  it('does NOT re-kick a fresh child that has no URL yet (within the stale window)', () => {
    loginManager.kick('signalk-test');
    expect(loginManager.shouldReKick(null)).toBe(false);
  });

  it('re-kicks a child stuck past the stale window without any URL', () => {
    loginManager.kick('signalk-test');
    // Advance beyond STALE_LOGIN_MS (10 min).
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(loginManager.shouldReKick(null)).toBe(true);
  });

  it('scrapes the AuthURL from up stdout as a fallback', () => {
    loginManager.kick('signalk-test');
    const child = spawned[spawned.length - 1]!;
    child.stdout.emit(
      'data',
      Buffer.from('\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/deadbeef\n')
    );
    expect(loginManager.getScrapedUrl()).toBe('https://login.tailscale.com/a/deadbeef');
    // With a scraped URL, a stuck child should not be re-kicked either.
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

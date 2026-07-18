import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execFile: the last arg is the (err, stdout, stderr) callback.
type Cb = (err: Error | null, stdout: string, stderr: string) => void;
let execImpl: (bin: string, args: string[], opts: unknown, cb: Cb) => void;

vi.mock('child_process', () => ({
  execFile: (bin: string, args: string[], opts: unknown, cb: Cb) => execImpl(bin, args, opts, cb),
}));

import * as cli from '../../../src/tailscale/cli.js';
import { STATUS_NEEDS_LOGIN, STATUS_RUNNING } from '../../fixtures/status.js';

function respondWith(stdout: string, err: Error | null = null): void {
  execImpl = (_bin, _args, _opts, cb) => cb(err, stdout, err ? 'boom' : '');
}

beforeEach(() => {
  execImpl = (_bin, _args, _opts, cb) => cb(null, '{}', '');
});

describe('cli.status', () => {
  it('parses a NeedsLogin status --json (AuthURL present)', async () => {
    respondWith(JSON.stringify(STATUS_NEEDS_LOGIN));
    const s = await cli.status();
    expect(s.BackendState).toBe('NeedsLogin');
    expect(s.AuthURL).toBe('https://login.tailscale.com/a/f6372fb0106d9');
  });

  it('parses a Running status --json', async () => {
    respondWith(JSON.stringify(STATUS_RUNNING));
    const s = await cli.status();
    expect(s.BackendState).toBe('Running');
    expect(s.Self?.DNSName).toBe('signalk-boat.tail1a2b3.ts.net.');
  });

  it('passes --socket as the first arg', async () => {
    const seen: string[][] = [];
    execImpl = (_bin, args, _opts, cb) => {
      seen.push(args);
      cb(null, JSON.stringify(STATUS_RUNNING), '');
    };
    await cli.status();
    expect(seen[0]?.[0]).toMatch(/^--socket=/);
    expect(seen[0]).toContain('status');
    expect(seen[0]).toContain('--json');
  });
});

describe('cli.backendState (tolerant)', () => {
  it('returns the parsed state on success', async () => {
    respondWith(JSON.stringify(STATUS_RUNNING));
    expect(await cli.backendState()).toBe('Running');
  });

  it('returns NoState when the CLI errors (daemon not ready)', async () => {
    respondWith('', new Error('dial unix /tmp/tailscaled.sock: connect: no such file'));
    expect(await cli.backendState()).toBe('NoState');
  });

  it('returns NoState when BackendState is absent', async () => {
    respondWith(JSON.stringify({ Version: '1.98.9' }));
    expect(await cli.backendState()).toBe('NoState');
  });
});

describe('cli.serveStatus', () => {
  it('returns {} for empty / null output (no serve configured)', async () => {
    respondWith('{}');
    expect(await cli.serveStatus()).toEqual({});
    respondWith('null');
    expect(await cli.serveStatus()).toEqual({});
    respondWith('');
    expect(await cli.serveStatus()).toEqual({});
  });

  it('parses a dual-listener serve config', async () => {
    respondWith(JSON.stringify({ TCP: { '443': { HTTPS: true }, '80': { HTTP: true } } }));
    const s = await cli.serveStatus();
    expect(s.TCP?.['443']?.HTTPS).toBe(true);
    expect(s.TCP?.['80']?.HTTP).toBe(true);
  });
});

describe('cli error propagation', () => {
  it('rejects runTailscale with a TailscaleCliError carrying stderr', async () => {
    respondWith('', new Error('exit 1'));
    await expect(cli.set(['--hostname=x'])).rejects.toThrow(/failed/);
  });
});

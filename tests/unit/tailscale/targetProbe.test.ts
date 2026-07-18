import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the http-client so probes don't hit the network.
vi.mock('../../../src/utils/http-client.js', () => ({
  httpFetch: vi.fn(),
}));

import { httpFetch } from '../../../src/utils/http-client.js';
import { probeCandidate, findServeTarget } from '../../../src/tailscale/targetProbe.js';

const HELLO = JSON.stringify({
  name: 'signalk-server',
  endpoints: { v1: { version: '2.24.0' } },
});
const HELLO_BY_SERVER_ID = JSON.stringify({
  name: 'something',
  server: { id: 'signalk-server' },
  endpoints: { v1: {} },
});

function mockResponse(ok: boolean, body: string) {
  return {
    ok,
    status: ok ? 200 : 500,
    text: () => Promise.resolve(body),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('probeCandidate', () => {
  it('accepts a valid SignalK hello (name)', async () => {
    vi.mocked(httpFetch).mockResolvedValue(mockResponse(true, HELLO));
    expect(await probeCandidate('http://127.0.0.1:3000')).toBe(true);
    // probes the /signalk path
    expect(vi.mocked(httpFetch).mock.calls[0]?.[0]).toBe('http://127.0.0.1:3000/signalk');
  });

  it('accepts a hello identified by server.id', async () => {
    vi.mocked(httpFetch).mockResolvedValue(mockResponse(true, HELLO_BY_SERVER_ID));
    expect(await probeCandidate('http://host.docker.internal:3000')).toBe(true);
  });

  it('rejects a 200 that is not a SignalK hello (impostor service)', async () => {
    vi.mocked(httpFetch).mockResolvedValue(mockResponse(true, '{"hello":"world"}'));
    expect(await probeCandidate('http://127.0.0.1:9999')).toBe(false);
  });

  it('rejects non-JSON garbage (e.g. HPE_INVALID_CONSTANT service)', async () => {
    vi.mocked(httpFetch).mockResolvedValue(mockResponse(true, '\x00\x01not http'));
    expect(await probeCandidate('http://127.0.0.1:8375')).toBe(false);
  });

  it('rejects a non-2xx response', async () => {
    vi.mocked(httpFetch).mockResolvedValue(mockResponse(false, HELLO));
    expect(await probeCandidate('http://127.0.0.1:3000')).toBe(false);
  });

  it('rejects a connection error (refused/timeout)', async () => {
    vi.mocked(httpFetch).mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await probeCandidate('http://127.0.0.1:3000')).toBe(false);
  });
});

describe('findServeTarget', () => {
  it('returns the first candidate that validates, in order', async () => {
    vi.mocked(httpFetch)
      .mockResolvedValueOnce(mockResponse(false, '')) // 127.0.0.1 fails
      .mockResolvedValueOnce(mockResponse(true, HELLO)); // host.containers.internal wins
    const target = await findServeTarget([
      'http://127.0.0.1:3000',
      'http://host.containers.internal:3000',
      'http://host.docker.internal:3000',
    ]);
    expect(target).toBe('http://host.containers.internal:3000');
    // Should short-circuit — third candidate not probed.
    expect(vi.mocked(httpFetch)).toHaveBeenCalledTimes(2);
  });

  it('returns null when no candidate validates', async () => {
    vi.mocked(httpFetch).mockResolvedValue(mockResponse(false, ''));
    const target = await findServeTarget(['http://127.0.0.1:3000', 'http://127.0.0.1:3001']);
    expect(target).toBeNull();
  });
});

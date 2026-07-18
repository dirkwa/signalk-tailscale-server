/**
 * Global test setup for Vitest.
 */

import { beforeAll, afterAll, vi } from 'vitest';

beforeAll(() => {
  vi.stubEnv('NODE_ENV', 'test');
  // A deterministic host so effectiveHostname() is predictable in tests that
  // don't override it explicitly.
  vi.stubEnv('HOST_HOSTNAME', 'testboat');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

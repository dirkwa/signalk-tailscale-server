/**
 * Global test setup for Vitest.
 *
 * Stubs are applied at module-evaluation time (not in beforeAll) so they're in
 * place before any test module imports `config`, which reads env once at first
 * import. This makes HOST_HOSTNAME-derived values deterministic regardless of
 * import order.
 */

import { afterAll, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
// A deterministic host so effectiveHostname() is predictable in tests that
// don't override it explicitly.
vi.stubEnv('HOST_HOSTNAME', 'testboat');

afterAll(() => {
  vi.unstubAllEnvs();
});

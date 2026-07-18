/**
 * Shared pino logger for signalk-tailscale-server.
 *
 * tailscaled has no in-app credential we hold, but a Tailscale auth key
 * (tskey-...) could appear in a value if a future feature accepts one — redact
 * any `authKey` field defensively. stdout is picked up by signalk-container →
 * `podman logs` → the plugin's log stream.
 */

import pino from 'pino';
import { config } from '../config/index.js';

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['authKey', '*.authKey', 'AuthKey', '*.AuthKey'],
    censor: '[Redacted]',
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  transport:
    config.nodeEnv === 'development'
      ? {
          target: 'pino-pretty',
          options: { colorize: true },
        }
      : undefined,
});

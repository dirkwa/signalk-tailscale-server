/**
 * signalk-tailscale-server configuration.
 *
 * All persistent state lives under DATA_DIR, which the plugin points at
 * /signalk-data/plugin-config-data/signalk-tailscale (so it rides in SignalK
 * backups). Everything else derives from it.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { join } from 'path';

const LogLevel = Type.Union([
  Type.Literal('trace'),
  Type.Literal('debug'),
  Type.Literal('info'),
  Type.Literal('warn'),
  Type.Literal('error'),
  Type.Literal('fatal'),
]);

const NodeEnv = Type.Union([
  Type.Literal('development'),
  Type.Literal('production'),
  Type.Literal('test'),
]);

const configSchema = Type.Object({
  port: Type.Number({ default: 3020 }),

  /** Root for all persistent state: config.json + tailscale-state/. */
  dataDir: Type.String(),

  /** SignalK data dir on host, mounted so we can read config if needed. */
  signalkDataPath: Type.String(),

  /** Tailscale statedir (node key + prefs + serve config). Subdir of dataDir, 0700. */
  tailscaleStateDir: Type.String(),

  /** LocalAPI unix socket tailscaled listens on (container-local). */
  tailscaledSocket: Type.String({ default: '/tmp/tailscaled.sock' }),

  /** tailscale / tailscaled binary paths. */
  tailscaleBinaryPath: Type.String({ default: '/usr/local/bin/tailscale' }),
  tailscaledBinaryPath: Type.String({ default: '/usr/local/bin/tailscaled' }),

  /** SignalK server version, set by the plugin via env (informational). */
  signalkVersion: Type.String({ default: 'unknown' }),

  /** Host hostname, set by the plugin — used to derive the default device name. */
  hostHostname: Type.String({ default: '' }),

  logLevel: LogLevel,
  nodeEnv: NodeEnv,
});

export type Config = Static<typeof configSchema>;

export function loadConfig(): Config {
  const dataDir = process.env['DATA_DIR'] ?? '/data';
  const signalkDataPath = process.env['SIGNALK_DATA_PATH'] ?? '/signalk-data';

  const rawConfig = {
    port: parseInt(process.env['PORT'] ?? '3020', 10),
    dataDir,
    signalkDataPath,
    tailscaleStateDir: process.env['TAILSCALE_STATE_DIR'] ?? join(dataDir, 'tailscale-state'),
    tailscaledSocket: process.env['TAILSCALED_SOCKET'] ?? '/tmp/tailscaled.sock',
    tailscaleBinaryPath: process.env['TAILSCALE_BINARY_PATH'] ?? '/usr/local/bin/tailscale',
    tailscaledBinaryPath: process.env['TAILSCALED_BINARY_PATH'] ?? '/usr/local/bin/tailscaled',
    signalkVersion: process.env['SIGNALK_VERSION'] ?? 'unknown',
    hostHostname: process.env['HOST_HOSTNAME'] ?? '',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
  };

  if (!Value.Check(configSchema, rawConfig)) {
    const errors = [...Value.Errors(configSchema, rawConfig)];
    throw new Error(
      `Invalid configuration: ${errors.map((e) => `${e.path}: ${e.message}`).join(', ')}`
    );
  }

  return Value.Default(configSchema, rawConfig) as Config;
}

export const config = loadConfig();

/** Path to the persisted desired-config JSON. */
export function configFilePath(): string {
  return join(config.dataDir, 'config.json');
}

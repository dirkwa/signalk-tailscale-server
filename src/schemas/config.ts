/**
 * TypeBox schema for the plugin→shim desired-config contract (POST /api/config).
 * Also drives request validation via the openapi-registry `body` hook.
 */

import { Type, type Static } from '@sinclair/typebox';

/** A serve-target candidate URL (http/https, host, optional port + path). */
const CandidateUrl = Type.String({
  pattern: '^https?://[^\\s]+$',
  description: 'Candidate serve target, e.g. http://host.containers.internal:3000',
});

/** An RFC1918-ish CIDR to advertise. Loose pattern; the plugin computes these. */
const Cidr = Type.String({
  pattern: '^\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2}$',
  description: 'IPv4 CIDR, e.g. 192.168.0.0/24',
});

// Every field is Optional so a partial (or empty) body passes Value.Check and
// Value.Default fills the gaps — the plugin sends the full object, but the
// contract tolerates partial updates and the store merges over DEFAULT_DESIRED.
export const desiredConfigSchema = Type.Object(
  {
    deviceHostname: Type.Optional(
      Type.String({
        default: '',
        description: 'Tailscale device hostname; empty → signalk-<HOST_HOSTNAME>.',
      })
    ),
    enableServe: Type.Optional(Type.Boolean({ default: true })),
    serveTargetCandidates: Type.Optional(Type.Array(CandidateUrl, { default: [] })),
    advertiseRoutes: Type.Optional(Type.Array(Cidr, { default: [] })),
    acceptRoutes: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: 'DesiredConfig', additionalProperties: false }
);

export type DesiredConfigInput = Static<typeof desiredConfigSchema>;

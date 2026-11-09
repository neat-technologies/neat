// A ConfigMap's data, hashed per key (ADR-270). The value never leaves this
// function: the node and the healthy baseline carry `hmac:<16 hex>` per key, so a
// changed value shows as a changed hash and a removed key as a removed key. The
// hash is keyed by the project's env-hash salt (env-hash.ts, ADR-266 amendment),
// so a short value can't be brute-forced from the snapshot. Without a salt each
// key records `present` and only keys added or removed show.
// Pure: no fetch, no graph.

import type { ConfigMap } from './types.js'
import { envValueHash } from './env-hash.js'

export function configMapDataHashes(cm: ConfigMap, salt?: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  const hash = (v: unknown): string => (salt ? `hmac:${envValueHash(salt, String(v))}` : 'present')
  for (const [k, v] of Object.entries(cm.data ?? {})) out[k] = hash(v)
  for (const [k, v] of Object.entries(cm.binaryData ?? {})) out[k] = hash(v)
  return out
}

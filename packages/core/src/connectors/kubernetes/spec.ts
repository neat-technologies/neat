// A ConfigMap's data, hashed per key (ADR-270). The value never leaves this
// function: the node and the healthy baseline carry `sha256:<16 hex>` per key, so
// a changed value shows as a changed hash and a removed key as a removed key.
// Pure: no fetch, no graph.

import { createHash } from 'node:crypto'
import type { ConfigMap } from './types.js'

export function configMapDataHashes(cm: ConfigMap): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(cm.data ?? {})) out[k] = sha(String(v))
  for (const [k, v] of Object.entries(cm.binaryData ?? {})) out[k] = sha(String(v))
  return out
}

function sha(s: string): string {
  return `sha256:${createHash('sha256').update(s).digest('hex').slice(0, 16)}`
}

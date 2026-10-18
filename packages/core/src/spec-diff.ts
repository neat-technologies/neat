import { createHash } from 'node:crypto'

// Canonical form, hash and field diff for an object's operational spec
// (ADR-270). Generic over any declared object: a Kubernetes object from the
// connector today, any kind a later watch fingerprints (#1496) through the same
// `specHash`. Lists the producer keys by name arrive as maps, so the diff reads
// by name; a list left positional diffs positionally.

/** JSON with object keys sorted, so equal specs serialize identically. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`
}

/** The spec's identity: sha256 of its canonical JSON, first 16 hex. */
export function specHash(spec: unknown): string {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex').slice(0, 16)
}

export interface SpecFieldChange {
  // Slash-joined keys, `/template/containers/frontend/env/CART_ADDR`.
  path: string
  // Absent on the side where the field does not exist.
  before?: unknown
  after?: unknown
}

const MAX_SHOWN = 200

function shown(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_SHOWN) return `${v.slice(0, MAX_SHOWN - 1)}…`
  if (v !== null && typeof v === 'object') {
    const s = canonicalJson(v)
    return s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN - 1)}…` : v
  }
  return v
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * The fields that differ between two specs, deepest first-differing key per
 * branch: an added or removed key is one change at its own path, never one per
 * leaf beneath it. Arrays compare whole (a producer keys the lists that matter).
 */
export function diffSpecs(before: unknown, after: unknown, path = ''): SpecFieldChange[] {
  if (isObj(before) && isObj(after)) {
    const out: SpecFieldChange[] = []
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const p = `${path}/${k}`
      if (!(k in before)) out.push({ path: p, after: shown(after[k]) })
      else if (!(k in after)) out.push({ path: p, before: shown(before[k]) })
      else out.push(...diffSpecs(before[k], after[k], p))
    }
    return out
  }
  if (canonicalJson(before) === canonicalJson(after)) return []
  return [{ path: path || '/', before: shown(before), after: shown(after) }]
}

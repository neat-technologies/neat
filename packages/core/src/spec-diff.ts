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

// A list of objects that each carry a string `name` (containers, env vars,
// ports, init containers) as a map keyed by name, so it diffs by name: removing
// one env var is one removed key, not every later entry shifted. A repeated name
// keeps each definition, the second keyed `NAME#2` (the env-shadowing shape). The
// `name` itself is the key and drops out of the value.
function byName(list: unknown[]): Record<string, unknown> | null {
  if (list.length === 0 || !list.every((x) => isObj(x) && typeof x['name'] === 'string')) return null
  const out: Record<string, unknown> = {}
  const seen = new Map<string, number>()
  for (const x of list as Array<Record<string, unknown>>) {
    const { name, ...rest } = x
    const n = (seen.get(name as string) ?? 0) + 1
    seen.set(name as string, n)
    out[n === 1 ? (name as string) : `${name as string}#${n}`] = rest
  }
  return out
}

function keyed(v: unknown): unknown {
  if (Array.isArray(v)) return byName(v) ?? v
  return v
}

/**
 * The fields that differ between two specs, deepest first-differing key per
 * branch: an added or removed key is one change at its own path, never one per
 * leaf beneath it. A list of named objects compares by name; any other list
 * compares whole.
 */
export function diffSpecs(before: unknown, after: unknown, path = ''): SpecFieldChange[] {
  before = keyed(before)
  after = keyed(after)
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

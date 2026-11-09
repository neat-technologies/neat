// Flag grain (ADR-242). A feature-flag store is a dependency the services call,
// like a database, and its flags are its grain the way columns are a table's
// (ADR-157). The store is a `flag-store` InfraNode; each flag is a provenanced
// entry in its `flags` list. This module is the one place that parses a flag
// definition and folds one onto that list. The graph mutation stays with the
// lifecycle authorities that call it: `extract/flags.ts` for the committed
// definitions and the code that reads each key, `ingest.ts` for what the store is
// serving and what an evaluation reported. The divergence detector only reads the
// list. Pure, no graph handle, so extract and ingest can both call in.

import {
  Provenance,
  type FlagAttr,
  type FlagDefinition,
  type ProvenanceValue,
} from '@neat.is/types'

export const FLAG_STORE_KIND = 'flag-store'

// The four fields that decide what a flag evaluates to. Everything else a flag
// carries (`description`, `metadata`, a provider's `source`/`selector`/
// `flagSetId`) is bookkeeping and never part of the compare.
const DEFINITION_FIELDS = ['state', 'defaultVariant', 'variants', 'targeting'] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Recursively key-sorted copy, so two definitions that differ only in key order
// serialize the same.
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (!isRecord(v)) return v
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k])
  return out
}

// One flag's raw definition → its canonical form, or null when it isn't a flag
// definition at all (no `state`, or no `variants` object).
export function canonicalFlag(raw: unknown): FlagDefinition | null {
  if (!isRecord(raw)) return null
  if (typeof raw['state'] !== 'string' || !isRecord(raw['variants'])) return null
  const dv = raw['defaultVariant']
  const def: FlagDefinition = {
    state: raw['state'],
    defaultVariant: typeof dv === 'string' ? dv : null,
    variants: sortKeys(raw['variants']) as Record<string, unknown>,
  }
  // An empty targeting object is the same as none.
  const t = raw['targeting']
  if (t !== undefined && t !== null && !(isRecord(t) && Object.keys(t).length === 0)) {
    def.targeting = sortKeys(t)
  }
  return def
}

// The top-level definition fields that differ between two canonical forms, in a
// fixed order. Empty means the two would evaluate the same.
export function flagFieldsChanged(a: FlagDefinition, b: FlagDefinition): string[] {
  const out: string[] = []
  for (const f of DEFINITION_FIELDS) {
    if (JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null)) out.push(f)
  }
  return out
}

// A flag document's `flags` object → key → canonical definition. Recognition is
// structural: the document has a top-level `flags` object and at least one entry
// is a flag definition. Returns null for anything else, so an arbitrary JSON file
// costs one parse and yields nothing. Only the `flags` object is read (ADR-242's
// one fenced content read; ADR-016 keeps every other config file paths-only).
export function parseFlagDocument(doc: unknown): Map<string, FlagDefinition> | null {
  if (!isRecord(doc) || !isRecord(doc['flags'])) return null
  const out = new Map<string, FlagDefinition>()
  for (const [key, raw] of Object.entries(doc['flags'])) {
    const def = canonicalFlag(raw)
    if (def) out.set(key, def)
  }
  return out.size > 0 ? out : null
}

function provenancesOf(f: FlagAttr): ProvenanceValue[] {
  const out: ProvenanceValue[] = []
  if (f.declared) out.push(Provenance.EXTRACTED)
  if (f.observed || f.observedVariant !== undefined) out.push(Provenance.OBSERVED)
  return out.sort()
}

function clone(existing: readonly FlagAttr[] | undefined): FlagAttr[] {
  return (existing ?? []).map((f) => ({
    ...f,
    provenances: [...f.provenances],
    ...(f.readers ? { readers: f.readers.map((r) => ({ ...r })) } : {}),
  }))
}

function finish(flags: FlagAttr[]): FlagAttr[] {
  return flags
    .map((f) => ({ ...f, provenances: provenancesOf(f) }))
    .filter((f) => f.provenances.length > 0)
    .sort((a, b) => a.key.localeCompare(b.key))
}

export interface DeclaredFlag {
  key: string
  definition: FlagDefinition
  declaredIn: string
  readers: { file: string; service: string; line?: number }[]
}

// The EXTRACTED side, replaced whole on every extraction pass: this pass's
// declarations and readers are the truth, so a flag deleted from the file or a
// reader deleted from the code drops out. The OBSERVED side of each flag is kept.
export function foldDeclaredFlags(
  existing: readonly FlagAttr[] | undefined,
  declared: readonly DeclaredFlag[],
): FlagAttr[] {
  const byKey = new Map<string, FlagAttr>()
  for (const f of clone(existing)) {
    const { declared: _d, declaredIn: _i, readers: _r, ...observedOnly } = f
    byKey.set(f.key, observedOnly)
  }
  for (const d of declared) {
    const cur = byKey.get(d.key) ?? { key: d.key, provenances: [] }
    cur.declared = d.definition
    cur.declaredIn = d.declaredIn
    if (d.readers.length > 0) cur.readers = d.readers.map((r) => ({ ...r }))
    byKey.set(d.key, cur)
  }
  return finish([...byKey.values()])
}

// The OBSERVED side from the store's own reader: what it is serving now. Folded
// only onto flags the code base declares. A served flag with no committed
// declaration mints nothing and comes back in `undeclared`, so the reader can
// count it without the graph growing a flag nobody wrote down.
export function foldObservedFlags(
  existing: readonly FlagAttr[] | undefined,
  served: ReadonlyMap<string, FlagDefinition>,
  at: string,
): { flags: FlagAttr[]; undeclared: string[] } {
  const flags = clone(existing)
  const byKey = new Map(flags.map((f) => [f.key, f]))
  const undeclared: string[] = []
  for (const [key, def] of served) {
    const cur = byKey.get(key)
    if (!cur || !cur.declared) {
      undeclared.push(key)
      continue
    }
    cur.observed = def
    cur.observedAt = at
  }
  // A declared flag the store no longer serves keeps no stale observed copy.
  for (const f of flags) {
    if (f.observed && !served.has(f.key)) {
      delete f.observed
      delete f.observedAt
    }
  }
  return { flags: finish(flags), undeclared: undeclared.sort() }
}

// The OBSERVED side from a service's own evaluation (a `feature_flag.evaluation`
// span event): the variant it got and why. Same rule as the reader: only a
// declared flag takes it.
export function foldObservedVariant(
  existing: readonly FlagAttr[] | undefined,
  key: string,
  variant: string,
  reason: string | undefined,
  at: string,
): FlagAttr[] | null {
  const flags = clone(existing)
  const cur = flags.find((f) => f.key === key)
  if (!cur || !cur.declared) return null
  cur.observedVariant = variant
  if (reason) cur.observedVariantReason = reason
  else delete cur.observedVariantReason
  cur.observedVariantAt = at
  return finish(flags)
}

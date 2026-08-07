// Column-grain provenance fold (ADR-157). Columns are a provenanced attribute
// list on a `sql-table` InfraNode, never their own nodes. This module is the one
// place that folds a column presence onto that list; the graph mutation itself
// stays with the two lifecycle authorities that call it — `ingest.ts` for the
// OBSERVED read off `db.statement`, and `extract/calls/*` for the EXTRACTED read
// off a schema definition (lifecycle.md §3). The divergence detector
// (divergences.ts) only reads the list. Keeping the fold pure here (no graph
// handle) lets extract call in without importing ingest — ingest already imports
// extract, so the reverse would be a cycle.
//
// A column records each provenance it has been seen with in a deduped
// `provenances` set: a column that is both declared and observed carries
// `[EXTRACTED, OBSERVED]`, and the column-drift query (ADR-157 §4) reads the
// declared set and the observed set straight off that one entry. `confidence` is
// the strongest evidence's grade (max) — a column seen on both sides is the most
// certain, and a one-sided (drift) column's confidence is just that side's grade.

import { Provenance, type ColumnAttr, type ProvenanceValue } from '@neat.is/types'

// OBSERVED columns are read verbatim from a parameterized `db.statement`: the
// value is redacted but the column NAME is present in the text, so the read is
// near-certain. Graded just below 1.0 to acknowledge the parser's conservative
// reach (it degrades on JOIN / subquery / `SELECT *`) rather than claim total
// coverage. EXTRACTED columns carry their producer's grade instead.
export const OBSERVED_COLUMN_CONFIDENCE = 0.9

// Deterministic, deduped provenance order so a node's serialized shape is stable
// regardless of the order extract / ingest passes ran in. Alphabetical happens to
// read EXTRACTED, INFERRED, OBSERVED, STALE.
function normalizeProvenances(provenances: ProvenanceValue[]): ProvenanceValue[] {
  return [...new Set(provenances)].sort()
}

// Fold a set of column names onto a table node's `columns` list at one
// provenance, returning a fresh array (pure — the caller writes it back). Column
// names are lowercased so the declared read fuses with the observed read, which
// already lowercases: an unquoted SQL identifier is case-folded by the database
// anyway, so lowercasing both sides is the fusion-safe normalization and stops a
// case difference from minting a phantom drift. An unseen column is added with the
// one provenance; a column already present gains this provenance in its set
// (deduped) and keeps the stronger confidence — never duplicated. Order-stable and
// idempotent, so an OBSERVED fold and an EXTRACTED fold compose either way round.
export function foldColumns(
  existing: readonly ColumnAttr[] | undefined,
  names: readonly string[],
  provenance: ProvenanceValue,
  confidence: number,
): ColumnAttr[] {
  const out: ColumnAttr[] = (existing ?? []).map((c) => ({
    ...c,
    provenances: [...c.provenances],
  }))
  const byName = new Map(out.map((c) => [c.name, c]))
  for (const raw of names) {
    const name = raw.toLowerCase()
    const prior = byName.get(name)
    if (!prior) {
      const col: ColumnAttr = { name, provenances: [provenance], confidence }
      byName.set(name, col)
      out.push(col)
      continue
    }
    if (!prior.provenances.includes(provenance)) {
      prior.provenances = normalizeProvenances([...prior.provenances, provenance])
    }
    if (confidence > prior.confidence) prior.confidence = confidence
  }
  return out
}

// Fold per-field write-SDK tags onto a table/collection node's `columns` list
// (ADR-167), returning a fresh array — the parallel of `foldColumns`, kept
// separate so `foldColumns` (shared by Drizzle / Prisma / SQLAlchemy / OBSERVED
// ingest) stays byte-identical. `writes` maps a field name to the SDK(s) that
// wrote it (`client` = firebase/firestore, `admin` = firebase-admin/firestore); it
// merges into each column's `sdkWrites` set, deduped and order-stable the way
// `provenances` is. Field names are lowercased to match `foldColumns` (which the
// column entries went through first), so the tag lands on the right column. A
// written field with no existing column entry is skipped — the columns fold runs
// first with the same field set, so the entry is already present; this is the
// defensive path. This is the declared interface ADR-169's field-guard policy
// consumes (`col.sdkWrites ?? []`).
export function foldSdkWrites(
  existing: readonly ColumnAttr[] | undefined,
  writes: Readonly<Record<string, readonly ('client' | 'admin')[]>>,
): ColumnAttr[] {
  const out: ColumnAttr[] = (existing ?? []).map((c) => ({
    ...c,
    provenances: [...c.provenances],
    ...(c.sdkWrites ? { sdkWrites: [...c.sdkWrites] } : {}),
  }))
  const byName = new Map(out.map((c) => [c.name, c]))
  for (const [raw, sdks] of Object.entries(writes)) {
    const col = byName.get(raw.toLowerCase())
    if (!col) continue
    const merged = new Set<'client' | 'admin'>([...(col.sdkWrites ?? []), ...sdks])
    col.sdkWrites = [...merged].sort()
  }
  return out
}

// Read helpers the divergence detector uses so the "is this column declared /
// observed" test lives with the model rather than being re-derived per caller.
export function columnIsDeclared(col: ColumnAttr): boolean {
  return col.provenances.includes(Provenance.EXTRACTED)
}
export function columnIsObserved(col: ColumnAttr): boolean {
  return col.provenances.includes(Provenance.OBSERVED)
}

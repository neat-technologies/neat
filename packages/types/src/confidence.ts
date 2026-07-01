// Confidence grading helpers — single source of truth for ADR-066.
//
// EXTRACTED is graded at emit time per producer; OBSERVED is graded by the
// signal block on the edge. PROV_RANK still locks tier ordering. The grading
// sits within each tier so the divergence query can reweight against honest
// values, not flat coarse ones.
//
// Producers in packages/core/src/extract/ import `confidenceForExtracted`
// and pass the producer kind; ingest.ts imports `confidenceForObservedSignal`
// and calls it at the same point it writes the signal block.

import type { EdgeSignal } from './edges.js'

// Discriminator that producers pass when emitting an EXTRACTED edge. Each
// kind maps to a numeric grade; the divergence query treats sub-floor
// candidates as if they never existed (precision floor, NEAT_EXTRACTED_PRECISION_FLOOR).
export type ExtractedConfidenceKind =
  // 0.85 — direct AST / file facts. ConfigNode existence (ADR-016), package.json
  // deps, AST imports, Dockerfile RUNS_ON, docker-compose depends_on, parsed
  // database config files. Structural — what the code says it does.
  | 'structural'
  // 0.85 — framework-aware call-site recognizer matched the SDK shape. Today's
  // covers kafkajs producer.send / consumer.subscribe, AWS SDK Bucket/TableName
  // near a *Client, grpc-js Client construction with the import context,
  // import-aware *Client classification (#238), and @supabase/supabase-js /
  // @supabase/ssr createClient construction with the import in scope (#482).
  | 'verified-call-site'
  // 0.5 — URL-shaped literal with structural support. Today's `redis://host` /
  // `rediss://host` URL captures fit here: the scheme proves it's a redis URL,
  // but there's no call expression verifying it's actually wired into the
  // service's runtime path.
  | 'url-with-structural-support'
  // 0.7 — a scheme-qualified URL literal (http://service-c:3102, //service-c/x)
  // whose hostname resolves to a *registered* service. This is a declared HTTP
  // dependency: the source names another in-mesh service's URL. urlMatchesHost
  // requires scheme + exact hostname (+ exact port when present) and the target
  // is a known node, so it lands at the precision floor rather than below it —
  // missing-observed needs a floor-level EXTRACTED edge to measure a declared-
  // but-never-driven upstream (issue #592). Below structural/verified (no call
  // expression wraps the literal); above url-with-structural-support (a resolved
  // registered target is tighter than a bare scheme read).
  | 'url-literal-service-target'
  // 0.2 — bare URL/hostname match against a registered service with no scheme
  // to anchor it. Structurally loose and unconfirmed by any recognizer; drops
  // below the default precision floor (0.7) and never enters the graph unless
  // the floor is lowered for diagnostics.
  | 'hostname-shape-match'

export const EXTRACTED_CONFIDENCE: Record<ExtractedConfidenceKind, number> = {
  structural: 0.85,
  'verified-call-site': 0.85,
  'url-literal-service-target': 0.7,
  'url-with-structural-support': 0.5,
  'hostname-shape-match': 0.2,
}

export function confidenceForExtracted(kind: ExtractedConfidenceKind): number {
  return EXTRACTED_CONFIDENCE[kind]
}

// OBSERVED grading from the signal block (ADR-066 §2). The piecewise function
// reflects the three buckets the ADR locks plus the error-ratio adjustment.
// `lastObservedAgeMs` defaults to 0 (just-observed) when the caller doesn't
// pass a signal — upsertObservedEdge writes 0 on creation and on every span
// update; the staleness loop is the only thing that lets the age drift.

const STRONG_SPAN_THRESHOLD = 100
const GOOD_SPAN_THRESHOLD = 10
const RECENT_AGE_MS = 60 * 60 * 1000

export function confidenceForObservedSignal(signal: EdgeSignal | undefined): number {
  // No signal block — fall back to the strong-tier ceiling. This case is
  // legacy edges loaded from a pre-v0.3.4 snapshot or hand-written test
  // fixtures; new producers always write the signal block.
  if (!signal) return 1.0
  const { spanCount, errorCount } = signal
  const ageMs = signal.lastObservedAgeMs ?? 0
  const recent = ageMs < RECENT_AGE_MS

  let base: number
  if (spanCount >= STRONG_SPAN_THRESHOLD && recent) {
    // Strong tier. Scale linearly from 0.95 at the threshold up to 1.0 at
    // 10× the threshold. Saturates at 1.0 above that.
    const over = Math.min(1, (spanCount - STRONG_SPAN_THRESHOLD) / (9 * STRONG_SPAN_THRESHOLD))
    base = 0.95 + 0.05 * over
  } else if (spanCount >= GOOD_SPAN_THRESHOLD && recent) {
    // Good tier. 0.7 at the threshold up to 0.9 just below the strong tier.
    const range = STRONG_SPAN_THRESHOLD - GOOD_SPAN_THRESHOLD
    const over = (spanCount - GOOD_SPAN_THRESHOLD) / range
    base = 0.7 + 0.2 * over
  } else if (spanCount > 0 && recent) {
    // Weak tier. 0.4 at one span up to 0.6 just below the good tier.
    const range = GOOD_SPAN_THRESHOLD - 1
    const over = range > 0 ? (spanCount - 1) / range : 0
    base = 0.4 + 0.2 * over
  } else if (spanCount > 0) {
    // Not recent — clamp the weak tier; staleness loop will demote this edge
    // to STALE on the next tick.
    base = 0.4
  } else {
    // Defensive: no spans on an OBSERVED edge means the upsert path was
    // skipped somewhere. Treat as no-evidence rather than max-trust.
    base = 0.4
  }

  // Error-ratio penalty. errorCount / spanCount on a healthy edge is 0; on a
  // failing edge it climbs. Subtract up to 0.2.
  if (spanCount > 0 && errorCount > 0) {
    const ratio = Math.min(1, errorCount / spanCount)
    base -= 0.2 * ratio
  }

  if (base < 0) return 0
  if (base > 1) return 1
  return Math.round(base * 1000) / 1000
}

// Precision-floor helpers (ADR-066 §3). The floor reads the
// NEAT_EXTRACTED_PRECISION_FLOOR env var on each call so tests can flip it
// in-process. Default 0.7. NEAT_EXTRACTED_PRECISION_FLOOR=0.0 keeps every
// candidate (diagnostic mode).

export const DEFAULT_EXTRACTED_PRECISION_FLOOR = 0.7

export function extractedPrecisionFloor(): number {
  const raw = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
  if (raw === undefined) return DEFAULT_EXTRACTED_PRECISION_FLOOR
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_EXTRACTED_PRECISION_FLOOR
  return n
}

export function passesExtractedFloor(confidence: number): boolean {
  return confidence >= extractedPrecisionFloor()
}

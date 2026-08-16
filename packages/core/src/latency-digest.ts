// Bounded streaming latency-percentile estimator (ADR-190, otel-ingest.md
// §Per-edge latency). `upsertObservedEdge` records each span's duration into a
// per-edge histogram and re-derives `latencyMs: { p50, p95 }` from it. The
// contract forbids retaining raw durations — the ingest path is non-blocking and
// edge cardinality is unbounded — so this is a fixed-resolution log-linear
// (HDR-style) histogram: one span updates it in O(1), and the bucket count is
// bounded regardless of how many spans an edge accumulates.
//
// Storage is a sparse `Record<bucketIndex, count>` carried on the edge signal, so
// a narrow latency distribution costs a handful of keys and the whole thing rides
// the graph snapshot as additive schema growth. The estimator is deterministic:
// the same span durations always yield the same buckets and the same percentiles.

export type LatencyHistogram = Record<string, number>

// Log-linear bucketing. Each power-of-two octave is split into SUB linear
// sub-buckets, giving ~1/SUB relative resolution (SUB=16 → ~6% bucket width,
// tight enough to tell a saturated p95 from a healthy one). The covered range
// runs from 2^MIN_EXP ms (~1µs) to 2^(MAX_EXP+1) ms (~70min); anything below
// lands in the zero/underflow bucket, anything above in the overflow bucket.
const SUB = 16
const MIN_EXP = -10
const MAX_EXP = 22
// Index 0 is the zero/underflow bucket; 1..(OCTAVES*SUB) are the log-linear
// buckets; the last index is the overflow bucket.
const OCTAVES = MAX_EXP - MIN_EXP + 1
const OVERFLOW_INDEX = OCTAVES * SUB + 1

// The bucket a duration (in ms) falls into. Non-finite, zero, and negative
// durations land in the underflow bucket rather than throwing — a span with a
// missing or degenerate duration records as ~0 latency, honestly.
export function latencyBucketIndex(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  const e = Math.floor(Math.log2(ms))
  if (e < MIN_EXP) return 0
  if (e > MAX_EXP) return OVERFLOW_INDEX
  const base = 2 ** e
  const raw = Math.floor((ms / base - 1) * SUB)
  const s = raw < 0 ? 0 : raw >= SUB ? SUB - 1 : raw
  return (e - MIN_EXP) * SUB + s + 1
}

// The representative latency (ms) a bucket stands for — the midpoint of its
// value range — used when a percentile lands in that bucket.
function bucketRepresentativeMs(index: number): number {
  if (index <= 0) return 0
  if (index >= OVERFLOW_INDEX) return 2 ** (MAX_EXP + 1)
  const zeroBased = index - 1
  const e = MIN_EXP + Math.floor(zeroBased / SUB)
  const s = zeroBased % SUB
  const base = 2 ** e
  const lower = base * (1 + s / SUB)
  const upper = base * (1 + (s + 1) / SUB)
  return (lower + upper) / 2
}

// Record one duration into the histogram in place. Returns the same object for
// convenience. Callers pass the edge signal's `latencyHist` (creating it on
// first observation).
export function recordLatency(hist: LatencyHistogram, ms: number): LatencyHistogram {
  const key = String(latencyBucketIndex(ms))
  hist[key] = (hist[key] ?? 0) + 1
  return hist
}

function quantile(hist: LatencyHistogram, q: number): number {
  const entries = Object.entries(hist)
    .map(([k, c]) => [Number(k), c] as const)
    .filter(([idx, c]) => Number.isFinite(idx) && c > 0)
    .sort((a, b) => a[0] - b[0])
  let total = 0
  for (const [, c] of entries) total += c
  if (total === 0) return 0
  // Nearest-rank: the smallest bucket whose cumulative count reaches ⌈q·total⌉.
  const rank = Math.max(1, Math.ceil(q * total))
  let cumulative = 0
  for (const [idx, c] of entries) {
    cumulative += c
    if (cumulative >= rank) return bucketRepresentativeMs(idx)
  }
  return bucketRepresentativeMs(entries[entries.length - 1]![0])
}

function round(ms: number): number {
  // Two significant-ish decimals — enough to read a p95 without pretending the
  // bucketed estimate is exact.
  return Math.round(ms * 100) / 100
}

// Derive { p50, p95 } from the histogram, or undefined when it holds no
// observations — an edge with no recorded latency reads honestly absent, never a
// fabricated zero (file-awareness.md §6).
export function latencyPercentiles(
  hist: LatencyHistogram | undefined,
): { p50: number; p95: number } | undefined {
  if (!hist) return undefined
  let total = 0
  for (const c of Object.values(hist)) total += c
  if (total === 0) return undefined
  return { p50: round(quantile(hist, 0.5)), p95: round(quantile(hist, 0.95)) }
}

import type { NeatGraph } from '../graph.js'
import type { ParsedSpan } from '../otel.js'
import type { edgeErrorDetailFromSpan } from './edges.js'

// Per-project ingest context and the span-time clock.
// Moved out of ingest.ts; ingest.ts re-exports the public names.
export interface IngestContext {
  graph: NeatGraph
  errorsPath: string
  // Absolute scan root the daemon is watching for this project. When set, a
  // runtime `code.filepath` is made service-root-relative against it before the
  // FileNode is keyed (file-awareness.md §4) — the service's absolute root is
  // `scanPath/<repoPath>`, which recovers `dist/foo.js` even for a single-
  // package service whose `repoPath` is empty (issue #430). Omitted by ad-hoc
  // callers and most tests, which rely on the repoPath-segment anchor instead.
  scanPath?: string
  // Project name for event-bus routing (ADR-051). Defaults to DEFAULT_PROJECT
  // when omitted — keeps single-project tests / scripts wire-compatible.
  project?: string
  now?: () => number
  // Set to false when the receiver already wrote the ErrorEvent synchronously
  // (production daemons via watch.ts wire this). When true or omitted, handleSpan
  // appends the ErrorEvent itself — the path used by ad-hoc scripts and tests
  // that don't go through buildOtelReceiver. ADR-033 §Error events.
  writeErrorEventInline?: boolean
  // Post-mutation policy trigger (ADR-043). Fires after handleSpan finishes
  // and the queue is drained. Daemons wire this to evaluateAllPolicies +
  // PolicyViolationsLog.append. Ad-hoc callers leave it undefined; their tests
  // don't need policy side effects.
  onPolicyTrigger?: (graph: NeatGraph) => Promise<void> | void
  // 4xx-burst coalescing state, keyed by `${source}->${peer}` (issue #481).
  // Lazily created the first time handleSpan sees a 4xx CLIENT/PRODUCER span.
  // Carried on the context so each project/daemon keeps its own bursts and a
  // long-lived handler accumulates across spans; ad-hoc callers reuse one ctx
  // across a batch and get the same coalescing.
  burstState?: Map<string, BurstState>
}

// In-flight 4xx burst against one (source, peer) pair. Lives on IngestContext so
// it survives across spans without leaking into module state shared by every
// project. firstTs/lastTs are the span timestamps (ADR-033 — span time, not
// wall clock); codes counts each 4xx by status so the dominant one can be named
// when the burst flushes.
export interface BurstState {
  count: number
  firstTs: string
  lastTs: string
  lastMs: number
  codes: Map<number, number>
}

export function nowIso(ctx: IngestContext): string {
  return new Date(ctx.now ? ctx.now() : Date.now()).toISOString()
}

// What every per-concern span handler reads, computed once at the top of
// handleSpan so each handler sees the same values the inline branches did.
export interface SpanIngest {
  ctx: IngestContext
  span: ParsedSpan
  // Span start time (ADR-033), wall clock only as a fallback.
  ts: string
  nowMs: number
  env: string
  // The span's own ServiceNode id.
  sourceId: string
  isError: boolean
  durationMs: number | undefined
  errorDetail: ReturnType<typeof edgeErrorDetailFromSpan>
  callSiteEvidence: { file: string; line?: number } | undefined
  // The OBSERVED origin: the call-site FileNode when there is one, the service otherwise.
  observedSource: () => string
  mintsFromCallerSide: boolean
}

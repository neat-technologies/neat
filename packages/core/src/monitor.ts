// `neat monitor` — stream high-signal graph facts to stdout, one human line
// per fact (ADR-159 decision 2, extended by ADR-162). The monitor is a client
// of surface NEAT already ships: the SSE `/events` bus is the trigger, the REST
// reads are the context. No new event type, no change to the locked 8-type SSE
// taxonomy, no new REST route.
//
// What it emits, and where each fact comes from:
//   • a fresh divergence — read from `GET /graph/divergences` (the graph's own
//     computed declared-vs-observed query), on a debounced trigger. At column
//     grain it names the drifting column (`orders.amount`), not just the table
//     (ADR-157).
//   • a stale integration — from a `stale-transition` SSE payload; the edge id
//     parses back to source/target via the graph's own id encoding.
//   • a new observed runtime dependency — from an OBSERVED `edge-added` SSE
//     payload, gated to the dependency edge types.
//   • a freshly-tripped policy violation — read from `GET /policies/violations`
//     (the soft guardrail, ADR-108) on a `policy-violation` trigger; the "before
//     you edit" fact made ambient (ADR-162).
//
// It holds a seen-set so each fact prints once and stays silent when nothing
// is new. It never fabricates: only facts the graph already computed reach
// stdout, and no reachable daemon means a clean exit with no output. This is a
// lifecycle/config-style verb (like `watch`/`connector`/`hooks`), read-only,
// additive to the CLI surface — not one of the locked query verbs.

import type {
  Divergence,
  DivergenceResult,
  GraphEdge,
  PoliciesViolationsResponse,
  PolicyViolation,
} from '@neat.is/types'
import { EdgeType, parseEdgeId, Provenance } from '@neat.is/types'
import { createHttpClient, type HttpClient, TransportError } from './cli-client.js'

// The edge types that represent runtime dependencies — the CALLS family plus
// cross-service and connection edges. Mirrors divergences.ts's
// OBSERVABLE_EDGE_TYPES on purpose: a new OBSERVED edge of one of these types
// is a real "runtime just started depending on X" fact. Structural OBSERVED
// edges (CONTAINS ownership of a file/symbol) are not dependencies, so an
// `+ observed` line for them would mislead — keep them off this surface.
const OBSERVED_DEP_EDGE_TYPES: ReadonlySet<string> = new Set([
  EdgeType.CALLS,
  EdgeType.CONNECTS_TO,
  EdgeType.PUBLISHES_TO,
  EdgeType.CONSUMES_FROM,
])

// ──────────────────────────────────────────────────────────────────────────
// Fact identity + formatting (pure, unit-tested)
// ──────────────────────────────────────────────────────────────────────────

// A stable key for a divergence so a re-read dedupes it. Divergences carry no
// id (they are re-derived each call, no persistence — ADR-060), so the key is
// built from the fields that identify one: type, endpoints, and the
// type-specific discriminators (column, versions, host, compat rule).
export function divergenceKey(d: Divergence): string {
  const column = 'column' in d && d.column ? d.column : ''
  const edgeType = 'edgeType' in d && d.edgeType ? d.edgeType : ''
  let extra = ''
  switch (d.type) {
    case 'version-mismatch':
      extra = `${d.extractedVersion}->${d.observedVersion}`
      break
    case 'host-mismatch':
      extra = `${d.extractedHost}->${d.observedHost}`
      break
    case 'compat-violation':
      extra = `${d.rule.kind}:${d.rule.package ?? ''}`
      break
    case 'observed-failing':
      // Two failure families can land on one node (source == target at the
      // incident locus), so key on kind + declaring location to keep them
      // distinct across re-reads.
      extra = `${d.failureKind}:${d.location ?? ''}`
      break
    default:
      extra = ''
  }
  return `div|${d.type}|${d.source}|${d.target}|${edgeType}|${column}|${extra}`
}

// The short table label for a column-locus divergence — the node id the graph
// carries. Not massaged into a bare table name; the id is what the graph knows.
function tableLabel(d: Divergence): string {
  return ('table' in d && d.table ? d.table : d.source)
}

// One greppable line per divergence, prefixed `⚠ divergence [<type>]`.
export function formatDivergenceLine(d: Divergence): string {
  switch (d.type) {
    case 'missing-observed':
      if (d.column) {
        return `⚠ divergence [missing-observed] ${tableLabel(d)}.${d.column} declared, never observed in production`
      }
      return `⚠ divergence [missing-observed] ${d.source} → ${d.target} declared, never observed in production`
    case 'missing-extracted':
      if (d.column) {
        return `⚠ divergence [missing-extracted] production writes ${tableLabel(d)}.${d.column} — not declared in code`
      }
      return `⚠ divergence [missing-extracted] production ${d.source} → ${d.target} — not declared in code`
    case 'version-mismatch':
      return `⚠ divergence [version-mismatch] ${d.source} → ${d.target} declared ${d.extractedVersion}, observed ${d.observedVersion} (${d.compatibility})`
    case 'host-mismatch':
      return `⚠ divergence [host-mismatch] ${d.source} → ${d.target} declared host ${d.extractedHost}, observed host ${d.observedHost}`
    case 'compat-violation':
      return `⚠ divergence [compat-violation] ${d.source} → ${d.target} — ${d.rule.kind}${d.rule.package ? ` (${d.rule.package})` : ''}`
    case 'observed-symbol-mismatch': {
      // Symbol/field-grain (ADR-215) — the code declares access to a member the
      // runtime object lacks; name the member and the declaring file:line.
      const at = d.location ? ` at ${d.location}` : ''
      const member = d.symbol ? ` ${d.symbol}` : ' a member'
      return `⚠ divergence [observed-symbol-mismatch] ${d.source}${at} reads${member} the runtime object does not have (${d.mismatchKind})`
    }
    case 'observed-failing': {
      // Behavioral-failure (ADR-220) — a declared dependency observed failing.
      if (d.edgeType) {
        const rate = d.errorRate !== undefined ? `, ${Math.round(d.errorRate * 100)}% errors` : ''
        return `⚠ divergence [observed-failing] ${d.source} → ${d.target} declared and observed, but failing (${d.failureKind}${rate})`
      }
      const at = d.location ? ` at ${d.location}` : ''
      return `⚠ divergence [observed-failing] ${d.source}${at} declares a call observed failing (${d.failureKind})`
    }
  }
}

// A stale-transition SSE payload carries only the edge id. The OBSERVED edge id
// encodes `${type}:OBSERVED:${source}->${target}` (identity.ts), so parseEdgeId
// — the graph's own decoder — recovers source/target. Falls back to the raw id
// when the shape is unexpected, so the line always renders something truthful.
export function formatStaleLine(edgeId: string): string {
  const parsed = parseEdgeId(edgeId)
  if (parsed) {
    return `⋯ stale  ${parsed.source} → ${parsed.target}  (observed edge went quiet)`
  }
  return `⋯ stale  ${edgeId}  (observed edge went quiet)`
}

// A new OBSERVED edge is a runtime dependency the graph just saw. It is framed
// as exactly that and nothing more: an OBSERVED edge can coexist with an
// EXTRACTED twin (the coexistence rule, contracts.md Rule 2), so "the code does
// not declare it" is not knowable from the event alone — the undeclared subset
// surfaces separately and authoritatively as a `missing-extracted` divergence.
export function formatObservedEdgeLine(edge: GraphEdge): string {
  return `+ observed  ${edge.source} → ${edge.target}  (new runtime dependency)`
}

// `--json` fact shapes — one object per line for non-Claude consumers.
export function divergenceJson(d: Divergence): string {
  return JSON.stringify({ kind: 'divergence', ...d })
}
export function staleJson(edgeId: string): string {
  const parsed = parseEdgeId(edgeId)
  return JSON.stringify({
    kind: 'stale',
    edgeId,
    ...(parsed ? { source: parsed.source, target: parsed.target, edgeType: parsed.type } : {}),
  })
}
export function observedEdgeJson(edge: GraphEdge): string {
  return JSON.stringify({
    kind: 'observed',
    id: edge.id,
    source: edge.source,
    target: edge.target,
    edgeType: edge.type,
    provenance: edge.provenance,
  })
}

// A policy violation carries a deterministic id (`${policyId}:${context}`,
// ADR-043), so the id is the dedupe key — a re-read of /policies/violations
// keys off exactly the same string.
export function policyKey(v: PolicyViolation): string {
  return `policy|${v.id}`
}

// The node / edge / path a violation points at — the locus an agent is about
// to touch. Node first (the common "before you edit this node" case), then
// edge, then a rule path.
function policySubject(v: PolicyViolation): string {
  const s = v.subject
  if (s.nodeId) return s.nodeId
  if (s.edgeId) return s.edgeId
  if (s.path && s.path.length > 0) return s.path.join(' → ')
  return ''
}

// One greppable line per fresh policy violation, prefixed `⚠ policy [<severity>]`.
// The message is the evaluator's own human-readable text; the subject locus is
// appended so the agent knows exactly where the rule bites before it edits.
export function formatPolicyLine(v: PolicyViolation): string {
  const subject = policySubject(v)
  const where = subject ? `  (${subject})` : ''
  return `⚠ policy [${v.severity}] ${v.policyName} — ${v.message}${where}`
}

export function policyJson(v: PolicyViolation): string {
  return JSON.stringify({ kind: 'policy', ...v })
}

// ──────────────────────────────────────────────────────────────────────────
// Emitter — the seen-set + write. Network-free, so tests drive it directly.
// ──────────────────────────────────────────────────────────────────────────

export interface EmitterOptions {
  json: boolean
  write: (line: string) => void
}

export class MonitorEmitter {
  private readonly seen = new Set<string>()
  constructor(private readonly opts: EmitterOptions) {}

  private out(line: string): void {
    this.opts.write(line + '\n')
  }

  // Emit every not-yet-seen divergence in a fresh result. Returns the count
  // newly emitted (0 → nothing printed, the silent path). Idempotent across
  // re-reads: the seen-set keys off divergenceKey.
  emitDivergences(result: DivergenceResult): number {
    let emitted = 0
    for (const d of result.divergences) {
      const key = divergenceKey(d)
      if (this.seen.has(key)) continue
      this.seen.add(key)
      this.out(this.opts.json ? divergenceJson(d) : formatDivergenceLine(d))
      emitted++
    }
    return emitted
  }

  // Emit a stale-transition once, keyed on the edge id.
  emitStale(edgeId: string): boolean {
    const key = `stale|${edgeId}`
    if (this.seen.has(key)) return false
    this.seen.add(key)
    this.out(this.opts.json ? staleJson(edgeId) : formatStaleLine(edgeId))
    return true
  }

  // Emit a new OBSERVED runtime dependency once, keyed on the edge id. Silently
  // ignores non-OBSERVED edges and non-dependency edge types (structural
  // ownership), so only real runtime dependencies reach stdout.
  emitObservedEdge(edge: GraphEdge): boolean {
    if (edge.provenance !== Provenance.OBSERVED) return false
    if (!OBSERVED_DEP_EDGE_TYPES.has(edge.type)) return false
    const key = `edge|${edge.id}`
    if (this.seen.has(key)) return false
    this.seen.add(key)
    this.out(this.opts.json ? observedEdgeJson(edge) : formatObservedEdgeLine(edge))
    return true
  }

  // Emit every not-yet-seen policy violation in a fresh /policies/violations
  // read. Returns the count newly emitted (0 → nothing printed, the silent
  // path). Idempotent across re-reads: the seen-set keys off the violation id.
  emitPolicies(response: PoliciesViolationsResponse): number {
    let emitted = 0
    for (const v of response.violations) {
      const key = policyKey(v)
      if (this.seen.has(key)) continue
      this.seen.add(key)
      this.out(this.opts.json ? policyJson(v) : formatPolicyLine(v))
      emitted++
    }
    return emitted
  }
}

// ──────────────────────────────────────────────────────────────────────────
// SSE reader — a minimal EventSource-shaped reader over fetch (Node 20 has
// global fetch + ReadableStream). Parses `event:`/`data:` frames; ignores the
// `:open`/`:heartbeat` comment lines the daemon writes (streaming.ts).
// ──────────────────────────────────────────────────────────────────────────

export interface SseFrame {
  event: string
  data: string
}

function parseFrame(raw: string): SseFrame | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue // comment / blank
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
    }
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

// Drain a response body stream, splitting on the SSE frame separator (`\n\n`)
// and handing each complete frame to `onFrame`. Resolves when the stream ends
// or the signal aborts; rejects only on a transport read error.
async function drainSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // Normalise CRLF so the frame split is robust to either newline style.
      buf = buf.replace(/\r\n/g, '\n')
      let idx: number
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const rawFrame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const frame = parseFrame(rawFrame)
        if (frame) onFrame(frame)
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore — the stream may already be torn down on abort
    }
  }
}

function safeParse(data: string): Record<string, unknown> | null {
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    return null
  }
}

// Same project-routing shape the CLI verbs use: undefined → the legacy
// unprefixed routes the server maps to `default`; a name → `/projects/:name/...`.
function projectPath(project: string | undefined, suffix: string): string {
  if (!project) return suffix
  return `/projects/${encodeURIComponent(project)}${suffix}`
}

function backoffDelay(attempt: number, capMs: number): number {
  return Math.min(capMs, 500 * 2 ** Math.min(attempt, 6))
}

// ──────────────────────────────────────────────────────────────────────────
// Injectable transport + a debounced reader. Both keep runMonitor testable
// without a live daemon: a test injects the SSE source and the REST client and
// drives real triggers through the same onFrame path production uses.
// ──────────────────────────────────────────────────────────────────────────

export interface EventsResponse {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
}

// Opens the SSE `/events` connection. Defaults to a thin wrapper over global
// fetch; a test swaps in a scripted stream.
export type OpenEvents = (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
) => Promise<EventsResponse>

const defaultOpenEvents: OpenEvents = async (url, headers, signal) => {
  const res = await fetch(url, { headers, signal })
  return { ok: res.ok, status: res.status, body: res.body }
}

// A debounced, self-coalescing REST read. A burst of triggers collapses into
// one read; a trigger that lands while a read is in flight coalesces into a
// single trailing re-read. Transient read failures are swallowed — the next
// trigger retries; a hard daemon-down surfaces on the SSE side as a disconnect.
interface DebouncedReader {
  schedule: () => void
  runNow: () => Promise<void>
  cancel: () => void
}

function makeDebouncedReader(read: () => Promise<void>, debounceMs: number): DebouncedReader {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let pending = false
  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const run = async (): Promise<void> => {
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      await read()
    } catch {
      // Transient. Stay silent; a later trigger re-reads.
    } finally {
      running = false
      if (pending) {
        pending = false
        schedule()
      }
    }
  }
  const schedule = (): void => {
    cancel()
    timer = setTimeout(() => {
      timer = null
      void run()
    }, debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  return {
    schedule,
    runNow: async () => {
      cancel()
      await run()
    },
    cancel,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// runMonitor — the orchestrator. Daemon resolution happens in cli.ts (reusing
// the query-verb resolution) and lands here as a concrete baseUrl + project.
// ──────────────────────────────────────────────────────────────────────────

export interface RunMonitorOptions {
  baseUrl: string
  project: string | undefined
  json: boolean
  authToken?: string | undefined
  // Injectable for tests; defaults to stdout.
  write?: (line: string) => void
  // Abort to shut the monitor down (SIGINT/SIGTERM, or a test).
  signal?: AbortSignal
  // Debounce window before a triggered read. Small for tests.
  debounceMs?: number
  // Cap on the reconnect backoff interval.
  backoffCapMs?: number
  // Bound the reconnect loop (Infinity for a real long-lived run).
  maxReconnects?: number
  // Injectable transport for tests; default to the real REST client + SSE fetch.
  httpClient?: HttpClient
  openEvents?: OpenEvents
}

export async function runMonitor(opts: RunMonitorOptions): Promise<number> {
  const write = opts.write ?? ((line: string) => process.stdout.write(line))
  const debounceMs = opts.debounceMs ?? 400
  const backoffCapMs = opts.backoffCapMs ?? 10_000
  const maxReconnects = opts.maxReconnects ?? Number.POSITIVE_INFINITY

  const client: HttpClient = opts.httpClient ?? createHttpClient(opts.baseUrl, opts.authToken)
  const openEvents: OpenEvents = opts.openEvents ?? defaultOpenEvents
  const emitter = new MonitorEmitter({ json: opts.json, write })

  const divergencesPath = projectPath(opts.project, '/graph/divergences')
  const policiesPath = projectPath(opts.project, '/policies/violations')
  const eventsUrl = `${opts.baseUrl.replace(/\/$/, '')}${projectPath(opts.project, '/events')}`

  // Two debounced reads, same shape, one per live query the monitor watches:
  // the divergence view (declared-vs-observed, down to the drifting column) and
  // the soft-guardrail policy violations. Each dedupes through the emitter's
  // seen-set, so a re-read prints only what is genuinely new.
  const divergences = makeDebouncedReader(async () => {
    const result = await client.get<DivergenceResult>(divergencesPath)
    emitter.emitDivergences(result)
  }, debounceMs)
  const policies = makeDebouncedReader(async () => {
    const result = await client.get<PoliciesViolationsResponse>(policiesPath)
    emitter.emitPolicies(result)
  }, debounceMs)

  const onFrame = (frame: SseFrame): void => {
    switch (frame.event) {
      case 'extraction-complete':
        divergences.schedule()
        break
      case 'stale-transition': {
        const payload = safeParse(frame.data)
        const edgeId = payload && typeof payload.edgeId === 'string' ? payload.edgeId : undefined
        if (edgeId) emitter.emitStale(edgeId)
        divergences.schedule()
        break
      }
      case 'edge-added': {
        const payload = safeParse(frame.data)
        const edge = payload?.edge as GraphEdge | undefined
        if (edge && edge.provenance === Provenance.OBSERVED) {
          emitter.emitObservedEdge(edge)
          divergences.schedule()
        }
        break
      }
      case 'policy-violation':
        // A freshly-evaluated violation is the "before you edit" fact (ADR-108).
        // Read the authoritative /policies/violations list rather than the event
        // payload, so the seen-set dedupes against the same set the baseline read
        // saw and a reconnect can't double-print.
        policies.schedule()
        break
      default:
        // node-added / node-updated / node-removed / edge-removed / error —
        // not monitor triggers.
        break
    }
  }

  const headers: Record<string, string> = { accept: 'text/event-stream' }
  if (opts.authToken && opts.authToken.length > 0) {
    headers.authorization = `Bearer ${opts.authToken}`
  }

  let connectedOnce = false
  let firstConnect = true
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) break

    let conn: EventsResponse
    try {
      conn = await openEvents(eventsUrl, headers, opts.signal)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') break
      // Connection refused / DNS / timeout. If we never connected, the daemon
      // is down — exit clean with no output (the monitor does not fabricate).
      if (!connectedOnce || attempt >= maxReconnects) break
      await sleep(backoffDelay(attempt, backoffCapMs), opts.signal)
      continue
    }

    if (!conn.ok || !conn.body) {
      // Drain the body so the socket frees, then decide. A non-2xx on first
      // contact is treated the same as unreachable — quiet exit.
      await conn.body?.cancel().catch(() => {})
      if (!connectedOnce || attempt >= maxReconnects) break
      await sleep(backoffDelay(attempt, backoffCapMs), opts.signal)
      continue
    }

    connectedOnce = true
    attempt = 0

    // Baseline on the first successful connect: read the present divergences
    // and policy violations so an agent starting a session is told the current
    // state, not only what changes mid-session. On a reconnect, schedule a
    // catch-up read of both — the seen-set keeps either from reprinting.
    if (firstConnect) {
      firstConnect = false
      await divergences.runNow()
      await policies.runNow()
    } else {
      divergences.schedule()
      policies.schedule()
    }

    try {
      await drainSse(conn.body, onFrame)
    } catch {
      // Read error mid-stream — fall through to reconnect.
    }

    if (opts.signal?.aborted) break
    if (attempt >= maxReconnects) break
    await sleep(backoffDelay(attempt, backoffCapMs), opts.signal)
  }

  divergences.cancel()
  policies.cancel()
  return 0
}

// Abortable sleep. Resolves on timeout or immediately when the signal aborts.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Re-export for the dispatcher — TransportError is the daemon-down signal the
// cli.ts monitor branch maps to a clean exit.
export { TransportError }

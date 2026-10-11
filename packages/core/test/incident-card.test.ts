import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import type { ErrorEvent, GraphEdge, GraphNode, IncidentCard } from '@neat.is/types'
import { Provenance } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { buildIncidentCard, divergenceSummary } from '../src/goodybag.js'
import { mergeObservedDeployContext } from '../src/ingest.js'
import { MonitorEmitter, formatIncidentLine, incidentJson } from '../src/monitor.js'

// The incident card (ADR-221) — the assembler's own guarantees are the thing
// under test: zero fabrication (a missing locus stays null), the incident-kind
// mapping, and honest degradation when the affected node isn't in the graph.
// The composed queries (root cause, blast radius, policies, divergence) have
// their own suites; here they run over minimal graphs and simply must not throw.

function graphWithNode(id: string, attrs: Record<string, unknown>): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode(id, { id, ...attrs } as unknown as GraphNode)
  return g
}

const NODE = 'symbol:api/auth.ts#validateSession'

function baseEvent(over: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    id: 't1:s1',
    timestamp: '2026-08-29T14:03:11.482Z',
    service: 'api',
    traceId: 't1',
    spanId: 's1',
    errorMessage: 'TypeError: cannot read id of null',
    exceptionType: 'TypeError',
    affectedNode: NODE,
    attributes: { 'code.filepath': 'api/auth.ts', 'code.lineno': 42 },
    ...over,
  }
}

describe('buildIncidentCard — locus', () => {
  const graph = graphWithNode(NODE, { type: 'SymbolNode', qualname: 'validateSession', service: 'api' })

  it('recovers the locus from code.filepath / code.lineno', () => {
    const card = buildIncidentCard(graph, baseEvent(), [baseEvent()], [])
    expect(card.locus).not.toBeNull()
    expect(card.locus?.file).toBe('api/auth.ts')
    expect(card.locus?.lineStart).toBe(42)
    expect(card.locus?.symbol).toBe('validateSession')
    expect(card.locus?.provenance).toBe(Provenance.OBSERVED)
    // The headline uses the file's base name and the symbol, never the abs path
    // or the raw node id — the structured locus.file keeps the full path.
    expect(card.headline).toContain('SYMBOL validateSession')
    expect(card.headline).toContain('in auth.ts')
    expect(card.headline).not.toContain('api/auth.ts')
    expect(card.headline).not.toContain(NODE)
    expect(card.id).toBe('t1:s1')
    expect(card.at).toBe('2026-08-29T14:03:11.482Z')
  })

  it('names the symbol from a SymbolNode, which carries qualname rather than name (#1351)', () => {
    const symbolGraph = graphWithNode(NODE, {
      type: 'SymbolNode',
      kind: 'function',
      qualname: 'validateSession',
      service: 'api',
      relPath: 'api/auth.ts',
      span: { startLine: 40, endLine: 58 },
    })
    const card = buildIncidentCard(symbolGraph, baseEvent(), [baseEvent()], [])
    expect(card.locus?.symbol).toBe('validateSession')
    expect(card.locus?.provenance).toBe(Provenance.OBSERVED)
    expect(card.headline).toContain('SYMBOL validateSession')
  })

  it('does not name the service as the symbol when the call site fell back to the ServiceNode', () => {
    const serviceGraph = graphWithNode(NODE, { type: 'ServiceNode', name: 'checkout', service: 'checkout' })
    const card = buildIncidentCard(serviceGraph, baseEvent(), [baseEvent()], [])
    expect(card.locus?.file).toBeDefined()
    expect(card.locus?.symbol).toBeUndefined()
  })

  it('leaves locus null when the incident carries no code attributes — never fabricated', () => {
    const ev = baseEvent({ attributes: undefined })
    const card = buildIncidentCard(graph, ev, [ev], [])
    expect(card.locus).toBeNull()
  })
})

describe('buildIncidentCard — incident kind', () => {
  const graph = graphWithNode(NODE, { type: 'SymbolNode', qualname: 'validateSession', service: 'api' })

  it('maps a gRPC failure to status-error', () => {
    const ev = baseEvent({ errorType: 'grpc-failure', exceptionType: undefined, attributes: undefined })
    expect(buildIncidentCard(graph, ev, [ev], []).incidentKind).toBe('status-error')
  })

  it('maps a coalesced http-failure burst to 4xx-burst', () => {
    const ev = baseEvent({
      errorType: 'http-failure',
      exceptionType: undefined,
      httpStatusCode: 404,
      incidentCount: 5,
      firstTimestamp: '2026-08-29T14:03:00.000Z',
      lastTimestamp: '2026-08-29T14:03:08.000Z',
      attributes: undefined,
    })
    const card = buildIncidentCard(graph, ev, [ev], [])
    expect(card.incidentKind).toBe('4xx-burst')
    expect(card.count).toBe(5)
    expect(card.window).toEqual({
      first: '2026-08-29T14:03:00.000Z',
      last: '2026-08-29T14:03:08.000Z',
    })
  })

  it('maps a single http-failure to 5xx and an exception span to exception', () => {
    const fivexx = baseEvent({
      errorType: 'http-failure',
      exceptionType: undefined,
      httpStatusCode: 500,
      incidentCount: 1,
      attributes: undefined,
    })
    expect(buildIncidentCard(graph, fivexx, [fivexx], []).incidentKind).toBe('5xx')
    const exc = baseEvent({ attributes: undefined })
    expect(buildIncidentCard(graph, exc, [exc], []).incidentKind).toBe('exception')
  })
})

describe('buildIncidentCard — honest degradation', () => {
  it('ships a card with no root cause / blast radius when the affected node is not in the graph', () => {
    // Empty graph — the incident is attributed to a node the graph does not carry.
    const graph: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    const card = buildIncidentCard(graph, baseEvent(), [baseEvent()], [])
    expect(card.rootCause).toBeNull()
    expect(card.blastRadius).toBeUndefined()
    expect(card.policies).toBeUndefined()
    // The locus still comes through — it reads the incident record, not the graph.
    expect(card.locus?.file).toBe('api/auth.ts')
  })
})

describe('buildIncidentCard — clean rendering (#1107)', () => {
  it('normalizes chain grain from the raw NodeType and keeps the abs path out of the headline', () => {
    const node = 'symbol:svc:app.ts#handler'
    const graph = graphWithNode(node, { type: 'SymbolNode', qualname: 'handler', service: 'svc' })
    const ev = baseEvent({
      affectedNode: node,
      service: 'svc',
      attributes: { 'code.filepath': '/abs/repo/src/app.ts', 'code.lineno': 7 },
    })
    const card = buildIncidentCard(graph, ev, [ev], [])
    // Headline: base name only — no absolute path, no raw node id.
    expect(card.headline).toContain('in app.ts')
    expect(card.headline).not.toContain('/abs/repo/src/app.ts')
    expect(card.headline).not.toContain(node)
    // The structured locus keeps the absolute path for the agent to open.
    expect(card.locus?.file).toBe('/abs/repo/src/app.ts')
    // Grain is the normalized vocabulary, never the raw NodeType.
    for (const hop of card.rootCause?.chain ?? []) {
      expect(hop.grain).toBe(hop.grain.toLowerCase())
      expect(hop.grain.endsWith('Node')).toBe(false)
    }
    const self = card.rootCause?.chain.find((h) => h.node === node)
    if (self) expect(self.grain).toBe('symbol')
  })
})

describe('buildIncidentCard — root-cause locus promotion (#1111)', () => {
  const sym = 'symbol:svc:app.py#handler'
  function symGraph(): NeatGraph {
    return graphWithNode(sym, {
      type: 'SymbolNode',
      qualname: 'handler',
      service: 'svc',
      relPath: 'app.py',
      span: { startLine: 12, endLine: 20 },
    })
  }

  it('promotes the cause node declared file:line as INFERRED when the incident carries no locus', () => {
    const ev = baseEvent({ affectedNode: sym, service: 'svc', attributes: undefined, exceptionType: 'AttributeError' })
    const card = buildIncidentCard(symGraph(), ev, [ev], [])
    expect(card.rootCause).not.toBeNull()
    expect(card.locus).not.toBeNull()
    expect(card.locus?.provenance).toBe(Provenance.INFERRED)
    expect(card.locus?.file).toBe('app.py')
    expect(card.locus?.lineStart).toBe(12)
    expect(card.locus?.symbol).toBe('handler')
    expect(card.headline).toContain('app.py')
  })

  it('prefers the exact failing line from a native incident recorded at the cause node', () => {
    const native = baseEvent({
      id: 'n1',
      affectedNode: sym,
      service: 'svc',
      attributes: { 'code.filepath': '/app/app.py', 'code.lineno': 17 },
    })
    const victim = baseEvent({ id: 'v1', affectedNode: sym, service: 'svc', attributes: undefined, exceptionType: 'AttributeError' })
    const card = buildIncidentCard(symGraph(), victim, [native, victim], [])
    expect(card.locus?.provenance).toBe(Provenance.INFERRED)
    expect(card.locus?.lineStart).toBe(17) // the native's exact line, not the def span (12)
    expect(card.locus?.file).toBe('/app/app.py')
  })

  it('leaves locus null when neither the incident nor the root cause carries a file', () => {
    const svc = 'service:frontend'
    const graph = graphWithNode(svc, { type: 'ServiceNode', name: 'frontend', service: 'frontend' })
    const ev = baseEvent({
      affectedNode: svc,
      service: 'frontend',
      attributes: undefined,
      exceptionType: undefined,
      errorMessage: 'gRPC UNKNOWN',
    })
    const card = buildIncidentCard(graph, ev, [ev], [])
    expect(card.locus).toBeNull()
  })
})

describe('buildIncidentCard — deploy/process context (ADR-240, read from the node per ADR-241)', () => {
  const svc = 'service:recommendation'
  const incidentId = 'k8s:deploy:otel-demo:recommendation:crash-loop'
  // A k8s crash-on-boot incident. Its process/config context lives on the workload
  // node, where ingest fused it, not on the incident.
  const k8sEvent = (): ErrorEvent =>
    baseEvent({
      id: incidentId,
      affectedNode: svc,
      service: 'recommendation',
      exceptionType: undefined,
      errorMessage: 'Deployment recommendation is crashlooping (restarts: 6)',
      attributes: { 'k8s.namespace': 'otel-demo', 'k8s.deployment': 'recommendation' },
    })
  const context = {
    fault: 'crash-loop',
    waitingReason: 'CrashLoopBackOff',
    restartCount: 6,
    exitCode: 1,
    image: 'quay.io/x:neo4j-label-bootstrap',
    containerEnv: ['NEO4J_PRODUCT_DATABASE_ENDPOINT=master-neo4j-productdb:7979', 'DB_PASSWORD=***REDACTED***'],
    containerArgs: ['python', '-m', 'recommendation_server'],
  }
  const graphWith = (ctx: Record<string, unknown> = context, id = incidentId) => {
    const g = graphWithNode(svc, { type: 'ServiceNode', name: 'recommendation', service: 'recommendation' })
    mergeObservedDeployContext(g, svc, id, '2026-10-11T10:00:00.000Z', ctx)
    return g
  }

  it('reads the redacted env/args/fault off the workload node so the wrong host is on the card', () => {
    const card = buildIncidentCard(graphWith(), k8sEvent(), [k8sEvent()], [])
    expect(card.deployContext).toEqual(context)
    // the smoking gun: the wrong neo4j host is on the card the agent reads
    expect(card.deployContext?.containerEnv).toContain('NEO4J_PRODUCT_DATABASE_ENDPOINT=master-neo4j-productdb:7979')
    // and a secret stays redacted on the card
    expect(card.deployContext?.containerEnv).toContain('DB_PASSWORD=***REDACTED***')
    expect(JSON.stringify(card)).not.toContain('s3cr3t')
  })

  it('carries a current/last-terminated process log tail when present', () => {
    const card = buildIncidentCard(
      graphWith({ ...context, processLog: 'socket.gaierror: [Errno -3] Temporary failure in name resolution' }),
      k8sEvent(),
      [k8sEvent()],
      [],
    )
    expect(card.deployContext?.processLog).toContain('Temporary failure in name resolution')
  })

  it('shows the context only on the incident it was observed with', () => {
    const other = { ...k8sEvent(), id: 'k8s:deploy:otel-demo:recommendation:image-pull' }
    expect(buildIncidentCard(graphWith(), other, [other], []).deployContext).toBeUndefined()
  })

  it('ignores a copy on the incident attributes: the node is the one source', () => {
    const ev = k8sEvent()
    ev.attributes = { ...ev.attributes, 'k8s.containerEnv': ['STALE=from-incident'] }
    const card = buildIncidentCard(graphWith(), ev, [ev], [])
    expect(card.deployContext?.containerEnv).toEqual(context.containerEnv)
  })

  it('omits deployContext entirely for a non-k8s incident', () => {
    const card = buildIncidentCard(graphWith(), baseEvent(), [baseEvent()], [])
    expect(card.deployContext).toBeUndefined()
  })
})

describe('divergenceSummary — symbol-grain mismatch (#1113)', () => {
  it('names the member and where it is read, not the node twice', () => {
    const node = 'symbol:src/products.py#get_product_list'
    const summary = divergenceSummary({
      type: 'observed-symbol-mismatch',
      source: node,
      target: node,
      confidence: 0.9,
      reason: 'r',
      recommendation: 'r',
      mismatchKind: 'missing-attribute',
      symbol: 'product.sku',
      location: 'src/products.py:42',
      provenance: Provenance.OBSERVED,
      errorMessage: "AttributeError: 'Product' object has no attribute 'sku'",
    } as never)
    expect(summary).toBe('product.sku at src/products.py:42')
    expect(summary).not.toContain('→')
  })
})

describe('monitor: incident → line', () => {
  const card: IncidentCard = {
    kind: 'incident',
    id: 't1:s1',
    at: '2026-08-29T14:03:11.482Z',
    incidentKind: 'exception',
    service: 'api',
    affectedNode: NODE,
    message: 'TypeError: cannot read id of null',
    exceptionType: 'TypeError',
    locus: {
      file: 'api/auth.ts',
      lineStart: 42,
      symbol: 'validateSession',
      service: 'api',
      provenance: Provenance.OBSERVED,
    },
    rootCause: {
      node: NODE,
      classification: 'primary-failure',
      reason: 'session lookup returns null',
      confidence: 0.71,
      fix: 'guard the null session',
      chain: [
        { node: NODE, grain: 'symbol', provenance: Provenance.OBSERVED },
        { node: 'table:supabase.users', grain: 'table', provenance: Provenance.INFERRED },
      ],
    },
    headline:
      'SYMBOL validateSession at LINE 42 in auth.ts (SERVICE api) raised TypeError at 2026-08-29T14:03:11.482Z',
  }

  it('renders one greppable ✖ incident line with the provenance mix', () => {
    const line = formatIncidentLine(card)
    expect(line).toContain('✖ incident [exception]')
    expect(line).toContain(card.headline)
    expect(line).toContain('primary-failure 0.71')
    expect(line).toContain('[OBSERVED·INFERRED]')
  })

  it('emits an incident once, keyed on the incident id', () => {
    const lines: string[] = []
    const emitter = new MonitorEmitter({ json: false, write: (l) => lines.push(l) })
    expect(emitter.emitIncident(card)).toBe(true)
    expect(emitter.emitIncident(card)).toBe(false)
    expect(lines).toHaveLength(1)
  })

  it('emits the full card as one JSON object under --json', () => {
    const lines: string[] = []
    const emitter = new MonitorEmitter({ json: true, write: (l) => lines.push(l) })
    emitter.emitIncident(card)
    const parsed = JSON.parse(lines[0]!.trim()) as IncidentCard
    expect(parsed.kind).toBe('incident')
    expect(parsed.rootCause?.chain).toHaveLength(2)
    expect(incidentJson(card)).toBe(JSON.stringify(card))
  })
})

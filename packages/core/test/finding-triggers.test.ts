import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  FindingBaselineRowSchema,
  FindingClearedRowSchema,
  FindingPresentRowSchema,
  FindingRowSchema,
  NodeType,
  Provenance,
  dependencyId,
  extractedEdgeId,
  fileId,
  observedEdgeId,
  serviceId,
  symbolId,
  type ErrorEvent,
  type FindingRow,
  type GraphEdge,
  type GraphNode,
  type SecurityDiff,
  type SecurityScanResult,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { EVENT_BUS_CHANNEL, eventBus, emitNeatEvent, type NeatEventEnvelope } from '../src/events.js'
import { computeDivergences } from '../src/divergences.js'
import {
  beginSourceExtraction,
  finishSourceExtraction,
  invalidateSourceBaseline,
} from '../src/extract/source-baseline.js'
import { buildGateVerdict } from '../src/pr-verdict.js'
import { scanProjectCves } from '../src/security-scan.js'
import {
  FINDINGS_MAX_ROWS,
  createFindingsMemory,
  declaringRepository,
  divergenceCandidates,
  divergenceFindingId,
  evaluateFindings,
  loadFindingReplay,
  parseFindingsLedger,
  securityCardFindingId,
  startFindingsLoop,
  type EvaluateFindingsInput,
} from '../src/findings-ledger.js'

// The findings ledger (ADR-279, docs/contracts/finding-triggers.md). Each `it`
// below is one line of the contract's §7, or one of the fail-closed cases around it.

const REPO = 'acme/shop'
const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const PROJECT = 'findings-test'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-findings-'))
  dirs.push(dir)
  return dir
}

function emptyGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
}

function addService(g: NeatGraph, name: string, declaredBy: string[] | null = [REPO]): string {
  const id = serviceId(name)
  g.addNode(id, {
    id,
    type: NodeType.ServiceNode,
    name,
    language: 'ts',
    ...(declaredBy ? { declaredBy } : {}),
  } as GraphNode)
  return id
}

// A declared call nobody has observed: one `missing-observed` divergence whose
// affected node is the calling service. The edge carries text a ledger row must
// never repeat.
function declareCall(g: NeatGraph, source: string, target: string): string {
  const id = extractedEdgeId(source, target, EdgeType.CALLS)
  g.addEdgeWithKey(id, source, target, {
    id,
    source,
    target,
    type: EdgeType.CALLS,
    provenance: Provenance.EXTRACTED,
    confidence: 0.85,
    evidence: { file: 'src/SOURCE_SENTINEL.ts', line: 7, snippet: 'const SOURCE_SENTINEL = fetch(url)' },
  } as GraphEdge)
  return id
}

// Mark a repository's baseline `ready` at a commit, the way a complete
// extraction pass of that repository does.
function setReady(g: NeatGraph, sha: string, repository = REPO): void {
  const commit = { repository, sha }
  const generation = beginSourceExtraction(g, repository, commit)
  finishSourceExtraction(g, generation, repository, commit, { extractionErrors: 0, skippedFiles: 0 })
}

// A scan with no advisory matches, as a clean and complete lookup returns it.
const cleanScan = async (): Promise<SecurityScanResult> => ({
  advisories: 'mirror',
  asOf: '2026-11-16T00:00:00.000Z',
  stale: 0,
  errors: [],
  inventory: 0,
  findings: [],
  context: [],
})

function collectEvents(project = PROJECT): { events: NeatEventEnvelope[]; stop: () => void } {
  const events: NeatEventEnvelope[] = []
  const listener = (e: NeatEventEnvelope): void => {
    if (e.project === project && e.type === 'finding') events.push(e)
  }
  eventBus.on(EVENT_BUS_CHANNEL, listener)
  return { events, stop: () => eventBus.off(EVENT_BUS_CHANNEL, listener) }
}

function readRows(file: string): FindingRow[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => FindingRowSchema.parse(JSON.parse(line)))
}

interface Fixture {
  graph: NeatGraph
  file: string
  input: EvaluateFindingsInput
  events: NeatEventEnvelope[]
  stop: () => void
}

// A project whose ledger already exists and is empty: the graph had no findings
// at the baseline evaluation, so whatever appears next is a first appearance.
async function started(): Promise<Fixture> {
  const dir = await tmp()
  const graph = emptyGraph()
  addService(graph, 'shop')
  addService(graph, 'pay')
  setReady(graph, SHA1)
  const file = path.join(dir, 'neat-out', 'findings.ndjson')
  let clock = Date.parse('2026-11-16T10:00:00.000Z')
  const input: EvaluateFindingsInput = {
    project: PROJECT,
    graph,
    findingsPath: file,
    scan: cleanScan,
    now: () => (clock += 1000),
    memory: createFindingsMemory(),
    durable: {},
  }
  const created = await evaluateFindings(input)
  expect(created.status).toBe('created')
  expect(readFileSync(file, 'utf8')).toBe('')
  const { events, stop } = collectEvents()
  return { graph, file, input, events, stop }
}

describe('findings ledger: recording', () => {
  it('records a finding present at a commit once, however many evaluations run', async () => {
    const f = await started()
    try {
      declareCall(f.graph, serviceId('shop'), serviceId('pay'))
      for (let i = 0; i < 4; i++) await evaluateFindings(f.input)
      const rows = readRows(f.file)
      expect(rows).toHaveLength(1)
      const row = FindingPresentRowSchema.parse(rows[0])
      expect(row).toMatchObject({
        kind: 'divergence',
        affectedNode: serviceId('shop'),
        repository: REPO,
        sha: SHA1,
        divergenceType: 'missing-observed',
      })
      expect(f.events).toHaveLength(1)
      expect(f.events[0]!.payload).toEqual(row)
    } finally {
      f.stop()
    }
  })

  it('writes one cleared row when a finding goes away, and a new first appearance when it returns', async () => {
    const f = await started()
    try {
      const edge = declareCall(f.graph, serviceId('shop'), serviceId('pay'))
      await evaluateFindings(f.input)
      f.graph.dropEdge(edge)
      await evaluateFindings(f.input)
      await evaluateFindings(f.input)
      let rows = readRows(f.file)
      expect(rows).toHaveLength(2)
      const cleared = FindingClearedRowSchema.parse(rows[1])
      expect(cleared).toMatchObject({ findingId: rows[0]!.findingId, kind: 'divergence', sha: SHA1, cleared: true })

      declareCall(f.graph, serviceId('shop'), serviceId('pay'))
      await evaluateFindings(f.input)
      await evaluateFindings(f.input)
      rows = readRows(f.file)
      expect(rows).toHaveLength(3)
      const again = FindingPresentRowSchema.parse(rows[2])
      expect(again.findingId).toBe(rows[0]!.findingId)
      expect(again.sha).toBe(SHA1)
      expect(again.firstSeenAt > (rows[0] as { firstSeenAt: string }).firstSeenAt).toBe(true)
      // present, cleared, present again: three events, in ledger order.
      expect(f.events.map((e) => e.payload)).toEqual(rows)
    } finally {
      f.stop()
    }
  })

  it('records the same finding once more at a new commit', async () => {
    const f = await started()
    try {
      declareCall(f.graph, serviceId('shop'), serviceId('pay'))
      await evaluateFindings(f.input)
      setReady(f.graph, SHA2)
      await evaluateFindings(f.input)
      await evaluateFindings(f.input)
      const rows = readRows(f.file).map((r) => FindingPresentRowSchema.parse(r))
      expect(rows.map((r) => r.sha)).toEqual([SHA1, SHA2])
      expect(rows[0]!.findingId).toBe(rows[1]!.findingId)
      expect(f.events).toHaveLength(2)
      // Going back to a commit already recorded during this presence writes nothing.
      setReady(f.graph, SHA1)
      await evaluateFindings(f.input)
      expect(readRows(f.file)).toHaveLength(2)
    } finally {
      f.stop()
    }
  })
})

describe('findings ledger: the baseline', () => {
  it('writes the findings present when the ledger is created as baseline rows, never emitted and never served', async () => {
    const dir = await tmp()
    const graph = emptyGraph()
    addService(graph, 'shop')
    addService(graph, 'pay')
    addService(graph, 'mail')
    declareCall(graph, serviceId('shop'), serviceId('pay'))
    declareCall(graph, serviceId('shop'), serviceId('mail'))
    setReady(graph, SHA1)
    const file = path.join(dir, 'findings.ndjson')
    const { events, stop } = collectEvents()
    try {
      const input: EvaluateFindingsInput = { project: PROJECT, graph, findingsPath: file, scan: cleanScan, memory: createFindingsMemory(), durable: {} }
      const created = await evaluateFindings(input)
      expect(created.status).toBe('created')
      await evaluateFindings(input)
      const rows = readRows(file)
      expect(rows).toHaveLength(2)
      for (const row of rows) expect(FindingBaselineRowSchema.parse(row).baseline).toBe(true)
      expect(events).toHaveLength(0)
      expect(loadFindingReplay(file)).toEqual([])

      // A baseline finding still there at the next commit is still a baseline
      // finding: it was never a trigger, and a new commit does not make it one.
      setReady(graph, SHA2)
      await evaluateFindings(input)
      const later = readRows(file)
      expect(later).toHaveLength(4)
      expect(later.every((r) => 'baseline' in r)).toBe(true)
      expect(events).toHaveLength(0)
      expect(loadFindingReplay(file)).toEqual([])

      // A finding that appears after the baseline is a trigger.
      addService(graph, 'search')
      declareCall(graph, serviceId('shop'), serviceId('search'))
      await evaluateFindings(input)
      expect(events).toHaveLength(1)
      expect(loadFindingReplay(file)).toHaveLength(1)

      // A baseline finding that clears leaves quietly; when it returns it is new.
      graph.dropEdge(extractedEdgeId(serviceId('shop'), serviceId('mail'), EdgeType.CALLS))
      await evaluateFindings(input)
      expect(readRows(file).filter((r) => 'cleared' in r)).toHaveLength(1)
      expect(events).toHaveLength(1)
      expect(loadFindingReplay(file)).toHaveLength(1)
      declareCall(graph, serviceId('shop'), serviceId('mail'))
      await evaluateFindings(input)
      expect(events).toHaveLength(2)
      expect(loadFindingReplay(file)).toHaveLength(2)
    } finally {
      stop()
    }
  })

  it('keeps a finding that could not be recorded at the baseline evaluation a baseline finding', async () => {
    const dir = await tmp()
    const graph = emptyGraph()
    addService(graph, 'shop')
    addService(graph, 'pay')
    // Declared by a second repository whose baseline is not ready yet.
    addService(graph, 'ops', ['acme/ops'])
    declareCall(graph, serviceId('ops'), serviceId('pay'))
    setReady(graph, SHA1)
    const file = path.join(dir, 'findings.ndjson')
    const { events, stop } = collectEvents()
    try {
      const input: EvaluateFindingsInput = { project: PROJECT, graph, findingsPath: file, scan: cleanScan, memory: createFindingsMemory(), durable: {} }
      expect((await evaluateFindings(input)).status).toBe('created')
      expect(readRows(file)).toHaveLength(0)
      setReady(graph, SHA2, 'acme/ops')
      await evaluateFindings(input)
      const rows = readRows(file)
      expect(rows).toHaveLength(1)
      expect(FindingBaselineRowSchema.parse(rows[0])).toMatchObject({ repository: 'acme/ops', sha: SHA2 })
      expect(events).toHaveLength(0)
    } finally {
      stop()
    }
  })
})

describe('findings ledger: the commit', () => {
  it('records nothing without a ready baseline, and records once the baseline is ready', async () => {
    const dir = await tmp()
    const graph = emptyGraph()
    addService(graph, 'shop')
    addService(graph, 'pay')
    const file = path.join(dir, 'findings.ndjson')
    const input: EvaluateFindingsInput = { project: PROJECT, graph, findingsPath: file, scan: cleanScan, memory: createFindingsMemory(), durable: {} }
    // No baseline at all (a local project with no commit): no ledger is started.
    expect((await evaluateFindings(input)).status).toBe('waiting')
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    // A pass in flight: still nothing.
    invalidateSourceBaseline(graph, REPO, 'syncing')
    expect((await evaluateFindings(input)).status).toBe('waiting')
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })

    setReady(graph, SHA1)
    expect((await evaluateFindings(input)).status).toBe('created')

    const { events, stop } = collectEvents()
    try {
      // A finding that appears while its repository is being re-extracted waits.
      invalidateSourceBaseline(graph, REPO, 'syncing')
      declareCall(graph, serviceId('shop'), serviceId('pay'))
      await evaluateFindings(input)
      expect(readRows(file)).toHaveLength(0)
      expect(events).toHaveLength(0)
      // An extraction that did not complete leaves the baseline unavailable.
      invalidateSourceBaseline(graph, REPO, 'unavailable')
      await evaluateFindings(input)
      expect(readRows(file)).toHaveLength(0)

      setReady(graph, SHA2)
      await evaluateFindings(input)
      const rows = readRows(file)
      expect(rows).toHaveLength(1)
      expect(FindingPresentRowSchema.parse(rows[0]).sha).toBe(SHA2)
      expect(events).toHaveLength(1)
    } finally {
      stop()
    }
  })

  it('does not clear a finding while its repository has no ready baseline', async () => {
    const f = await started()
    try {
      const edge = declareCall(f.graph, serviceId('shop'), serviceId('pay'))
      await evaluateFindings(f.input)
      // Halfway through a pass the edge is gone. That is not the finding clearing.
      invalidateSourceBaseline(f.graph, REPO, 'syncing')
      f.graph.dropEdge(edge)
      await evaluateFindings(f.input)
      expect(readRows(f.file)).toHaveLength(1)
      declareCall(f.graph, serviceId('shop'), serviceId('pay'))
      setReady(f.graph, SHA1)
      await evaluateFindings(f.input)
      expect(readRows(f.file)).toHaveLength(1)
      expect(f.events).toHaveLength(1)
    } finally {
      f.stop()
    }
  })

  it('records nothing for a node with no recorded declarer or with more than one', async () => {
    const f = await started()
    try {
      addService(f.graph, 'runtime-only', null)
      addService(f.graph, 'shared', [REPO, 'acme/other'])
      declareCall(f.graph, serviceId('runtime-only'), serviceId('pay'))
      declareCall(f.graph, serviceId('shared'), serviceId('pay'))
      expect(declaringRepository(f.graph, serviceId('runtime-only'))).toBeNull()
      expect(declaringRepository(f.graph, serviceId('shared'))).toBeNull()
      expect(declaringRepository(f.graph, 'service:not-in-graph')).toBeNull()
      expect(declaringRepository(f.graph, serviceId('shop'))).toBe(REPO)
      expect(divergenceCandidates(f.graph)).toHaveLength(2)
      await evaluateFindings(f.input)
      expect(readRows(f.file)).toHaveLength(0)
      expect(f.events).toHaveLength(0)
    } finally {
      f.stop()
    }
  })
})

// ── vulnerabilities ─────────────────────────────────────────────────────────

const FIX = path.join(__dirname, 'fixtures/osv')
const osvRecord = (id: string) => JSON.parse(readFileSync(path.join(FIX, `${id}.json`), 'utf8'))
const osv = (async (url: string, init?: RequestInit) => {
  if (url.endsWith('/v1/querybatch')) {
    const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { name: string } }> }
    return new Response(
      JSON.stringify({ results: body.queries.map((q) => ({ vulns: q.package.name === 'lodash' ? [{ id: 'GHSA-35jh-r3h4-6jhm' }] : [] })) }),
    )
  }
  return new Response(JSON.stringify(osvRecord(decodeURIComponent(url.split('/v1/vulns/')[1] ?? ''))))
}) as typeof fetch

// shop depends on a vulnerable lodash and imports it: one card at `imported`.
function addVulnerableImport(g: NeatGraph): void {
  const LODASH = dependencyId('npm', 'lodash', '4.17.15')
  g.addNode(LODASH, { id: LODASH, type: NodeType.DependencyNode, name: 'lodash', ecosystem: 'npm', version: '4.17.15', purl: 'pkg:npm/lodash@4.17.15' } as GraphNode)
  const file = fileId('shop', 'src/render.ts')
  g.addNode(file, { id: file, type: NodeType.FileNode, service: 'shop', path: 'src/render.ts', declaredBy: [REPO] } as GraphNode)
  const edge = (source: string, target: string, type: string, extra: Partial<GraphEdge>) => {
    const id = `${type}:${source}->${target}`
    g.addEdgeWithKey(id, source, target, { id, source, target, type, provenance: Provenance.EXTRACTED, confidence: 1, ...extra } as GraphEdge)
  }
  edge(serviceId('shop'), LODASH, EdgeType.DEPENDS_ON, { evidence: { file: 'package-lock.json' }, dependency: { scope: 'direct', dev: false, introducedBy: [] } })
  edge(file, LODASH, EdgeType.IMPORTS, { evidence: { file: 'src/render.ts', line: 2, specifier: 'lodash', bindings: ['template'] } })
}

describe('findings ledger: vulnerabilities', () => {
  it('does not record a vulnerability at imported, and records it when it becomes reachable-static', async () => {
    const dir = await tmp()
    const home = await tmp()
    const graph = emptyGraph()
    addService(graph, 'shop')
    setReady(graph, SHA1)
    const file = path.join(dir, 'findings.ndjson')
    // The real scan on the live graph. `reach` lifts the composed card to
    // reachable-static, standing in for the call path a fix-diff would give it.
    let reach = false
    const scan = async (g: NeatGraph): Promise<SecurityScanResult> => {
      const r = await scanProjectCves(g, { fetchImpl: osv, env: { NEAT_HOME: home } })
      if (!reach) return r
      return { ...r, findings: r.findings.map((c) => ({ ...c, reachability: { ...c.reachability, level: 'reachable-static' as const } })) }
    }
    const input: EvaluateFindingsInput = { project: PROJECT, graph, findingsPath: file, scan, memory: createFindingsMemory(), durable: {} }
    expect((await evaluateFindings(input)).status).toBe('created')

    const { events, stop } = collectEvents()
    try {
      addVulnerableImport(graph)
      const imported = await scan(graph)
      expect(imported.findings.map((c) => c.reachability.level)).toEqual(['imported'])
      await evaluateFindings(input)
      expect(readRows(file)).toHaveLength(0)
      expect(events).toHaveLength(0)

      reach = true
      await evaluateFindings(input)
      await evaluateFindings(input)
      const rows = readRows(file)
      expect(rows).toHaveLength(1)
      const row = FindingPresentRowSchema.parse(rows[0])
      expect(row).toMatchObject({
        kind: 'vulnerability',
        affectedNode: serviceId('shop'),
        repository: REPO,
        sha: SHA1,
        advisoryId: 'GHSA-35jh-r3h4-6jhm',
      })
      expect(row.divergenceType).toBeUndefined()
      expect(events).toHaveLength(1)

      // The gate's id for the same vulnerability is the ledger's.
      const card = (await scan(graph)).findings[0]!
      const gate = buildGateVerdict({
        introducedDivergences: [],
        securityDiff: {
          advisories: 'osv', asOf: '2026-11-16T00:00:00Z', stale: 0, errors: [],
          base: { ref: 'b', inventory: 0 }, head: { ref: 'h', inventory: 1 },
          introduced: [{ advisoryId: card.advisory.id, ecosystem: 'npm', package: card.dependency.name, service: card.service, before: null, after: card }],
          removed: [], stillPresent: [], context: { introduced: [], removed: [] },
        } as SecurityDiff,
        observedBreaks: [],
        affectedFiles: 0,
        affectedServices: 0,
      })
      const gateFinding = gate.findings.find((x) => x.kind === 'vulnerability')!
      expect(gateFinding.findingId).toBe(row.findingId)
      expect(gateFinding.findingId).toBe(securityCardFindingId(card))
      expect(gateFinding.affectedNode).toBe(row.affectedNode)

      // An advisory lookup that could not complete says nothing about absence.
      const down = { ...input, scan: async () => ({ ...(await cleanScan()), asOf: null, advisories: 'disabled' as const }) }
      await evaluateFindings(down)
      expect(readRows(file)).toHaveLength(1)
      const failing = { ...input, scan: async () => { throw new Error('feed down') } }
      await evaluateFindings(failing)
      expect(readRows(file)).toHaveLength(1)
      // A complete lookup with the card back at imported clears it.
      reach = false
      await evaluateFindings(input)
      expect(readRows(file)).toHaveLength(2)
      expect(FindingClearedRowSchema.parse(readRows(file)[1]).kind).toBe('vulnerability')
    } finally {
      stop()
    }
  })
})

describe('findings ledger: identity', () => {
  it("gives a divergence the gate's findingId", async () => {
    // A declared and observed call that mostly fails: `observed-failing`, a type
    // the gate counts, so both sides produce a finding for it.
    const f = await started()
    try {
      const src = serviceId('shop')
      const dst = serviceId('pay')
      declareCall(f.graph, src, dst)
      const obs = observedEdgeId(src, dst, EdgeType.CALLS)
      f.graph.addEdgeWithKey(obs, src, dst, {
        id: obs, source: src, target: dst, type: EdgeType.CALLS, provenance: Provenance.OBSERVED,
        lastObserved: new Date().toISOString(), callCount: 84, signal: { spanCount: 84, errorCount: 84 },
      } as GraphEdge)
      const failing = computeDivergences(f.graph).divergences.filter((d) => d.type === 'observed-failing')
      expect(failing).toHaveLength(1)
      const gate = buildGateVerdict({
        introducedDivergences: failing,
        securityDiff: null,
        observedBreaks: [],
        affectedFiles: 0,
        affectedServices: 0,
      })
      const gateFinding = gate.findings.find((x) => x.kind === 'divergence')!
      await evaluateFindings(f.input)
      const row = readRows(f.file).map((r) => FindingPresentRowSchema.parse(r)).find((r) => r.divergenceType === 'observed-failing')!
      expect(row.findingId).toBe(gateFinding.findingId)
      expect(row.findingId).toBe(divergenceFindingId(failing[0]!))
      expect(row.affectedNode).toBe(gateFinding.affectedNode)
    } finally {
      f.stop()
    }
  })
})

// ── incident-fused divergences ──────────────────────────────────────────────

describe('findings ledger: divergences read from incident records', () => {
  const REL = 'src/recommendation_server.py'
  const SYM = symbolId('shop', REL, 'list_recommendations')

  // An incident whose error names a member the runtime object does not have,
  // sitting on a declared symbol: one `observed-symbol-mismatch`. Every field a
  // row must never repeat carries a sentinel.
  const incident = (id: string): ErrorEvent => ({
    id,
    timestamp: '2026-11-16T09:00:00.000Z',
    service: 'shop',
    traceId: id,
    spanId: id,
    errorType: 'AttributeError',
    errorMessage: "'INCIDENT_SENTINEL_Response' object has no attribute 'sentinel_member'",
    exceptionType: 'AttributeError',
    exceptionStacktrace: 'Traceback INCIDENT_SENTINEL\n  File "src/recommendation_server.py", line 82',
    attributes: { 'code.filepath': REL, 'code.lineno': 82, 'http.url': 'https://INCIDENT_SENTINEL.example/x', 'db.statement': 'select INCIDENT_SENTINEL' },
    affectedNode: SYM,
  })

  async function withSymbol(): Promise<Fixture & { errorsPath: string }> {
    const f = await started()
    const file = fileId('shop', REL)
    f.graph.addNode(file, { id: file, type: NodeType.FileNode, service: 'shop', path: REL, language: 'python', declaredBy: [REPO] } as GraphNode)
    f.graph.addNode(SYM, {
      id: SYM, type: NodeType.SymbolNode, kind: 'function', qualname: 'list_recommendations',
      span: { startLine: 70, endLine: 95 }, service: 'shop', relPath: REL, declaredBy: [REPO],
    } as GraphNode)
    const errorsPath = path.join(path.dirname(f.file), 'errors.ndjson')
    f.input = { ...f.input, errorsPath }
    return { ...f, errorsPath }
  }

  it('records an observed-symbol-mismatch, clears it and records it again like any other finding', async () => {
    const f = await withSymbol()
    try {
      // No incident ledger yet: nothing to record, and nothing fails.
      await evaluateFindings(f.input)
      expect(readRows(f.file)).toHaveLength(0)

      await fs.writeFile(f.errorsPath, `${JSON.stringify(incident('t1:s1'))}\n`)
      const seen = computeDivergences(f.graph, { incidents: [incident('t1:s1')] }).divergences
      expect(seen.map((d) => d.type)).toEqual(['observed-symbol-mismatch'])
      // Without the incidents handed in, the type cannot fire at all.
      expect(divergenceCandidates(f.graph)).toHaveLength(0)

      for (let i = 0; i < 3; i++) await evaluateFindings(f.input)
      let rows = readRows(f.file)
      expect(rows).toHaveLength(1)
      const row = FindingPresentRowSchema.parse(rows[0])
      expect(row).toMatchObject({ kind: 'divergence', divergenceType: 'observed-symbol-mismatch', affectedNode: SYM, repository: REPO, sha: SHA1 })
      expect(row.findingId).toBe(divergenceFindingId(seen[0]!))
      // The gate's id for the same divergence.
      const gate = buildGateVerdict({ introducedDivergences: seen, securityDiff: null, observedBreaks: [], affectedFiles: 0, affectedServices: 0 })
      expect(gate.findings[0]!.findingId).toBe(row.findingId)

      // A second incident of the same failure is the same finding.
      await fs.appendFile(f.errorsPath, `${JSON.stringify(incident('t2:s2'))}\n`)
      await evaluateFindings(f.input)
      expect(readRows(f.file)).toHaveLength(1)
      // A new commit records it once more.
      setReady(f.graph, SHA2)
      await evaluateFindings(f.input)
      expect(readRows(f.file).map((r) => r.sha)).toEqual([SHA1, SHA2])

      // The incidents leave the ledger: the finding is cleared, once.
      await fs.writeFile(f.errorsPath, '')
      await evaluateFindings(f.input)
      await evaluateFindings(f.input)
      rows = readRows(f.file)
      expect(rows).toHaveLength(3)
      expect(FindingClearedRowSchema.parse(rows[2])).toMatchObject({ findingId: row.findingId, sha: SHA2, cleared: true })

      // It happens again: a first appearance again.
      await fs.writeFile(f.errorsPath, `${JSON.stringify(incident('t3:s3'))}\n`)
      await evaluateFindings(f.input)
      rows = readRows(f.file)
      expect(rows).toHaveLength(4)
      expect(FindingPresentRowSchema.parse(rows[3])).toMatchObject({ findingId: row.findingId, sha: SHA2, divergenceType: 'observed-symbol-mismatch' })
      expect(f.events.map((e) => e.payload)).toEqual(rows)
    } finally {
      f.stop()
    }
  })

  it('lets nothing from an incident record reach a row or the event', async () => {
    const f = await withSymbol()
    try {
      await fs.writeFile(f.errorsPath, `${JSON.stringify(incident('t1:s1'))}\n`)
      // The divergence itself quotes the incident: its message, its id.
      const d = computeDivergences(f.graph, { incidents: [incident('t1:s1')] }).divergences[0]!
      expect(JSON.stringify(d)).toContain('INCIDENT_SENTINEL')
      expect(JSON.stringify(d)).toContain('t1:s1')
      await evaluateFindings(f.input)
      await fs.writeFile(f.errorsPath, '')
      await evaluateFindings(f.input)

      const text = readFileSync(f.file, 'utf8')
      expect(text.split('\n').filter(Boolean)).toHaveLength(2)
      const wire = text + JSON.stringify(f.events.map((e) => e.payload))
      expect(f.events).toHaveLength(2)
      for (const leak of ['INCIDENT_SENTINEL', 'sentinel_member', 'Traceback', 'AttributeError', 'no attribute', 't1:s1', 'code.filepath', 'http.url', 'db.statement', 'select ', ':82']) {
        expect(wire, leak).not.toContain(leak)
      }
      for (const key of ['errorMessage', 'incidentId', 'incidentCount', 'exceptionStacktrace', 'attributes', 'symbol', 'mismatchKind', 'location', 'reason']) {
        expect(wire, key).not.toContain(`"${key}"`)
      }
      // Strict rows: an incident field on a row would not parse.
      for (const row of readRows(f.file)) expect(FindingRowSchema.safeParse({ ...row, errorMessage: 'x' }).success).toBe(false)
    } finally {
      f.stop()
    }
  })

  it('neither records nor clears an incident-fused finding while the incident ledger cannot be read', async () => {
    const f = await withSymbol()
    try {
      await fs.writeFile(f.errorsPath, `${JSON.stringify(incident('t1:s1'))}\n`)
      await evaluateFindings(f.input)
      expect(readRows(f.file)).toHaveLength(1)
      await fs.writeFile(f.errorsPath, 'not json at all\n')
      await evaluateFindings(f.input)
      expect(readRows(f.file)).toHaveLength(1)
      await fs.writeFile(f.errorsPath, `${JSON.stringify(incident('t4:s4'))}\n`)
      await evaluateFindings(f.input)
      expect(readRows(f.file)).toHaveLength(1)
      expect(f.events).toHaveLength(1)
    } finally {
      f.stop()
    }
  })

  it('reads the incident ledger again only when its size or mtime changed', async () => {
    const f = await withSymbol()
    try {
      await fs.writeFile(f.errorsPath, `${JSON.stringify(incident('t1:s1'))}\n`)
      await evaluateFindings(f.input)
      const held = f.input.memory!.incidents!
      expect(held.events).toHaveLength(1)
      await evaluateFindings(f.input)
      // Same file, same parsed records: not read again.
      expect(f.input.memory!.incidents!.events).toBe(held.events)
      await fs.appendFile(f.errorsPath, `${JSON.stringify(incident('t2:s2'))}\n`)
      await evaluateFindings(f.input)
      expect(f.input.memory!.incidents!.events).not.toBe(held.events)
      expect(f.input.memory!.incidents!.events).toHaveLength(2)
      await fs.rm(f.errorsPath)
      await evaluateFindings(f.input)
      expect(f.input.memory!.incidents).toBeUndefined()
    } finally {
      f.stop()
    }
  })
})

describe('findings ledger: the row', () => {
  it('carries only the listed fields, and nothing source-bearing', async () => {
    const f = await started()
    try {
      const edge = declareCall(f.graph, serviceId('shop'), serviceId('pay'))
      addService(f.graph, 'mail')
      declareCall(f.graph, serviceId('shop'), serviceId('mail'))
      // The divergence itself carries prose and evidence. None of it is a row field.
      const divergence = computeDivergences(f.graph).divergences[0]!
      expect(divergence.reason.length).toBeGreaterThan(0)
      await evaluateFindings(f.input)
      f.graph.dropEdge(edge)
      await evaluateFindings(f.input)

      const text = readFileSync(f.file, 'utf8')
      const present = new Set(['findingId', 'kind', 'affectedNode', 'repository', 'sha', 'firstSeenAt', 'divergenceType', 'advisoryId', 'baseline'])
      const cleared = new Set(['findingId', 'kind', 'sha', 'clearedAt', 'cleared'])
      const lines = text.split('\n').filter(Boolean)
      expect(lines).toHaveLength(3)
      for (const line of lines) {
        const raw = JSON.parse(line) as Record<string, unknown>
        // Strict schemas: a field outside the contract's list fails the parse.
        expect(() => FindingRowSchema.parse(raw)).not.toThrow()
        const allowed = 'cleared' in raw ? cleared : present
        for (const key of Object.keys(raw)) expect(allowed.has(key), key).toBe(true)
      }
      expect(text).not.toContain('SOURCE_SENTINEL')
      expect(text).not.toContain(divergence.reason)
      expect(text).not.toContain(divergence.recommendation)
      expect(text).not.toMatch(/reason|recommendation|evidence|snippet|location|message/)
      // The bus payload is the row, so the same holds for the event.
      for (const e of f.events) expect(JSON.stringify(e.payload)).not.toContain('SOURCE_SENTINEL')

      expect(FindingPresentRowSchema.safeParse({ ...JSON.parse(lines[0]!), reason: 'why' }).success).toBe(false)
      expect(FindingClearedRowSchema.safeParse({ ...JSON.parse(lines[2]!), affectedNode: 'service:shop' }).success).toBe(false)
      // What the scrubbing writer put on disk is the row, byte for byte.
      expect(lines.map((l) => JSON.parse(l))).toEqual(f.events.map((e) => e.payload))
    } finally {
      f.stop()
    }
  })

  it('leaves a ledger it cannot read exactly untouched', async () => {
    const f = await started()
    try {
      declareCall(f.graph, serviceId('shop'), serviceId('pay'))
      await fs.writeFile(f.file, '{"findingId":"not-a-row"}\n')
      const r = await evaluateFindings(f.input)
      expect(r.status).toBe('unreadable')
      expect(readFileSync(f.file, 'utf8')).toBe('{"findingId":"not-a-row"}\n')
      expect(f.events).toHaveLength(0)
      expect(() => parseFindingsLedger('{"torn":')).toThrow()
    } finally {
      f.stop()
    }
  })
})

describe('findings ledger: the queries stay pure', () => {
  it('computeDivergences returns the same result before and after an evaluation, and the graph is not mutated', async () => {
    const f = await started()
    try {
      declareCall(f.graph, serviceId('shop'), serviceId('pay'))
      addService(f.graph, 'mail')
      declareCall(f.graph, serviceId('pay'), serviceId('mail'))
      const strip = (r: ReturnType<typeof computeDivergences>) => ({ ...r, computedAt: '' })
      const before = strip(computeDivergences(f.graph))
      const graphBefore = JSON.stringify(f.graph.export())
      const r = await evaluateFindings(f.input)
      expect(r.appended).toHaveLength(2)
      await evaluateFindings(f.input)
      expect(strip(computeDivergences(f.graph))).toEqual(before)
      expect(JSON.stringify(f.graph.export())).toBe(graphBefore)
    } finally {
      f.stop()
    }
  })
})

// ── the bound ───────────────────────────────────────────────────────────────

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0')

describe('findings ledger: the bound', () => {
  it("drops the oldest commits' rows at the bound, keeps what is present now, and the stream still serves", async () => {
    const f = await started()
    try {
      // A full ledger: one finding still present from the very first commit,
      // then 4,999 findings that each appeared and cleared, 100 per commit.
      const at = '2026-11-01T00:00:00.000Z'
      const oldest = hex(1, 40)
      const still = { findingId: 'e'.repeat(64), kind: 'divergence', affectedNode: serviceId('pay'), repository: REPO, sha: oldest, firstSeenAt: at, divergenceType: 'missing-observed' }
      const lines: string[] = [JSON.stringify(still)]
      for (let i = 0; i < 4999; i++) {
        const sha = hex(1 + Math.floor(i / 100), 40)
        const findingId = hex(i + 1, 64)
        lines.push(JSON.stringify({ findingId, kind: 'divergence', affectedNode: serviceId('shop'), repository: REPO, sha, firstSeenAt: at, divergenceType: 'missing-observed' }))
        lines.push(JSON.stringify({ findingId, kind: 'divergence', sha, clearedAt: at, cleared: true }))
      }
      lines.push(JSON.stringify({ findingId: 'f'.repeat(64), kind: 'divergence', affectedNode: serviceId('shop'), repository: REPO, sha: hex(60, 40), firstSeenAt: at, divergenceType: 'missing-observed' }))
      await fs.writeFile(f.file, lines.join('\n') + '\n')
      expect(parseFindingsLedger(readFileSync(f.file, 'utf8')).rows).toHaveLength(FINDINGS_MAX_ROWS)
      const cursorBefore = `${hex(4999, 64)}:${hex(1 + 49, 40)}`
      // After the cursor: that finding's cleared row and the last present row.
      expect(loadFindingReplay(f.file, cursorBefore)).toHaveLength(2)

      // The graph holds neither synthetic finding as recordable, and the
      // repository is ready, so both are cleared: two rows over the bound.
      const r = await evaluateFindings(f.input)
      expect(r.appended).toHaveLength(2)
      expect(r.deferred).toBe(0)
      // The oldest commit held 201 rows; 200 of them are droppable.
      expect(r.dropped).toBe(200)
      const rows = readRows(f.file)
      expect(rows.length).toBeLessThanOrEqual(FINDINGS_MAX_ROWS)
      expect(rows).toHaveLength(FINDINGS_MAX_ROWS - 200 + 2)
      // The row that said a finding was present at the oldest commit survived
      // the drop, so its clearing is one cleared row and not a new appearance.
      expect(rows[0]).toEqual(still)
      expect(rows.filter((x) => x.sha === oldest)).toHaveLength(2)
      expect(rows.some((x) => x.sha === hex(2, 40))).toBe(true)
      // The stream still serves: from the start, and after a cursor that survived.
      expect(loadFindingReplay(f.file).length).toBeGreaterThan(0)
      expect(loadFindingReplay(f.file, cursorBefore)).toHaveLength(4)
      // A cursor whose row was dropped is unknown now.
      expect(() => loadFindingReplay(f.file, `${hex(1, 64)}:${oldest}`)).toThrow()
    } finally {
      f.stop()
    }
  })

  it('refuses to replay a ledger above the bound', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'findings.ndjson')
    const at = '2026-11-01T00:00:00.000Z'
    const lines: string[] = []
    for (let i = 0; i <= FINDINGS_MAX_ROWS; i++) {
      lines.push(JSON.stringify({ findingId: hex(i, 64), kind: 'divergence', affectedNode: 'service:s', repository: REPO, sha: SHA1, firstSeenAt: at }))
    }
    await fs.writeFile(file, lines.join('\n') + '\n')
    expect(() => loadFindingReplay(file)).toThrow('finding replay unavailable')
  })
})

// ── hosted durability ───────────────────────────────────────────────────────

describe('findings ledger: a hosted daemon', () => {
  it('does not append or emit before the sidecar has committed the row', async () => {
    const f = await started()
    try {
      declareCall(f.graph, serviceId('shop'), serviceId('pay'))
      const seen: Array<{ url: string; body: { project: string; row: FindingRow }; rowsOnDisk: number; events: number }> = []
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
          rowsOnDisk: readRows(f.file).length,
          events: f.events.length,
        })
        expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${'t'.repeat(32)}`)
        await gate
        return new Response(null, { status: 204 })
      }) as typeof fetch
      const running = evaluateFindings({ ...f.input, durable: { token: 't'.repeat(32), fetchImpl } })
      // The commit is in flight: nothing on disk, nothing on the bus.
      await new Promise((r) => setTimeout(r, 30))
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ url: 'http://127.0.0.1:8081/finding-append', rowsOnDisk: 0, events: 0 })
      expect(readRows(f.file)).toHaveLength(0)
      expect(f.events).toHaveLength(0)
      release()
      await running
      const rows = readRows(f.file)
      expect(rows).toHaveLength(1)
      expect(seen[0]!.body).toEqual({ project: PROJECT, row: rows[0] })
      expect(f.events.map((e) => e.payload)).toEqual(rows)
    } finally {
      f.stop()
    }
  })

  it('records nothing and emits nothing when the sidecar does not commit', async () => {
    const f = await started()
    try {
      declareCall(f.graph, serviceId('shop'), serviceId('pay'))
      const refuse = (async () => new Response(null, { status: 503 })) as typeof fetch
      await expect(evaluateFindings({ ...f.input, durable: { token: 't'.repeat(32), fetchImpl: refuse } }))
        .rejects.toThrow('durable finding sink unavailable')
      await expect(evaluateFindings({ ...f.input, durable: { token: 'short', fetchImpl: refuse } }))
        .rejects.toThrow('durable finding sink unavailable')
      expect(readRows(f.file)).toHaveLength(0)
      expect(f.events).toHaveLength(0)
      // The finding is still unrecorded, so a later evaluation records it.
      await evaluateFindings(f.input)
      expect(readRows(f.file)).toHaveLength(1)
      expect(f.events).toHaveLength(1)
    } finally {
      f.stop()
    }
  })

  it('creates no ledger when the sidecar refuses a baseline row', async () => {
    const dir = await tmp()
    const graph = emptyGraph()
    addService(graph, 'shop')
    addService(graph, 'pay')
    declareCall(graph, serviceId('shop'), serviceId('pay'))
    setReady(graph, SHA1)
    const file = path.join(dir, 'findings.ndjson')
    const refuse = (async () => new Response(null, { status: 404 })) as typeof fetch
    const input: EvaluateFindingsInput = { project: PROJECT, graph, findingsPath: file, scan: cleanScan, memory: createFindingsMemory() }
    await expect(evaluateFindings({ ...input, durable: { token: 't'.repeat(32), fetchImpl: refuse } })).rejects.toThrow()
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    // The next evaluation is still the baseline one.
    expect((await evaluateFindings({ ...input, durable: {} })).status).toBe('created')
    expect(readRows(file).every((r) => 'baseline' in r)).toBe(true)
  })
})

// ── the loop ────────────────────────────────────────────────────────────────

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('findings ledger: when the daemon evaluates', () => {
  it('evaluates after extraction-complete, a stale-transition and an OBSERVED edge-added, debounced, and stops cleanly', async () => {
    const dir = await tmp()
    const graph = emptyGraph()
    addService(graph, 'shop')
    addService(graph, 'pay')
    setReady(graph, SHA1)
    const file = path.join(dir, 'findings.ndjson')
    let evaluations = 0
    const listenersBefore = eventBus.listenerCount(EVENT_BUS_CHANNEL)
    const loop = startFindingsLoop({
      project: PROJECT,
      graph,
      findingsPath: file,
      scan: cleanScan,
      durable: {},
      debounceMs: 20,
      onEvaluated: () => { evaluations++ },
    })
    const { events, stop } = collectEvents()
    try {
      expect(eventBus.listenerCount(EVENT_BUS_CHANNEL)).toBe(listenersBefore + 2)
      // The loop evaluates once on start: the baseline evaluation.
      await settle(80)
      expect(evaluations).toBe(1)
      expect(readFileSync(file, 'utf8')).toBe('')

      declareCall(graph, serviceId('shop'), serviceId('pay'))
      // A burst of triggers is one evaluation.
      for (let i = 0; i < 5; i++) {
        emitNeatEvent({ type: 'extraction-complete', project: PROJECT, payload: { project: PROJECT, fileCount: 1, nodesAdded: 0, edgesAdded: 1 } })
      }
      await settle(80)
      expect(evaluations).toBe(2)
      expect(events).toHaveLength(1)

      emitNeatEvent({ type: 'stale-transition', project: PROJECT, payload: { edgeId: 'e', from: Provenance.OBSERVED, to: Provenance.STALE } })
      await settle(80)
      expect(evaluations).toBe(3)

      const observed = { id: 'o', source: serviceId('shop'), target: serviceId('pay'), type: EdgeType.CALLS, provenance: Provenance.OBSERVED, confidence: 1 } as GraphEdge
      emitNeatEvent({ type: 'edge-added', project: PROJECT, payload: { edge: observed } })
      await settle(80)
      expect(evaluations).toBe(4)

      // The dependency loop's tick asks through schedule().
      loop.schedule()
      await settle(80)
      expect(evaluations).toBe(5)

      // Not a trigger: an EXTRACTED edge, another project's event, another type.
      emitNeatEvent({ type: 'edge-added', project: PROJECT, payload: { edge: { ...observed, provenance: Provenance.EXTRACTED } } })
      emitNeatEvent({ type: 'extraction-complete', project: 'someone-else', payload: { project: 'someone-else', fileCount: 1, nodesAdded: 0, edgesAdded: 0 } })
      emitNeatEvent({ type: 'node-removed', project: PROJECT, payload: { id: 'x' } })
      await settle(80)
      expect(evaluations).toBe(5)
      // However many evaluations ran, the finding was recorded once.
      expect(readRows(file)).toHaveLength(1)

      loop.stop()
      expect(eventBus.listenerCount(EVENT_BUS_CHANNEL)).toBe(listenersBefore + 1)
      emitNeatEvent({ type: 'extraction-complete', project: PROJECT, payload: { project: PROJECT, fileCount: 1, nodesAdded: 0, edgesAdded: 0 } })
      loop.schedule()
      await settle(80)
      expect(evaluations).toBe(5)
    } finally {
      loop.stop()
      stop()
    }
  })
})

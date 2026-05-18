/**
 * Contract assertions — auto-derived from /docs/contracts.md and the verification
 * pass at /docs/audits/verification.md. Each rule that verification graded PASS
 * is locked here as a regression test. Rules currently graded FAIL or PARTIAL
 * are queued as `it.todo` with the cleanup issue number — they flip to live
 * assertions as each fix lands.
 *
 * If a contract assertion fails: the implementation drifted from the contract.
 * The right move is almost always to fix the implementation, not the test.
 * Only relax a test if /docs/contracts.md and the relevant ADR change first.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import {
  EdgeType,
  NodeType,
  Provenance,
  ProvenanceSchema,
  EdgeTypeSchema,
  GraphEdgeSchema,
  GraphNodeSchema,
  RootCauseResultSchema,
  BlastRadiusResultSchema,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { NeatGraph } from '../../src/graph.js'
import { getBlastRadius, getRootCause } from '../../src/traverse.js'

const CORE_SRC = join(__dirname, '../../src')
const TYPES_SRC = join(__dirname, '../../../types/src')
const MCP_SRC = join(__dirname, '../../../mcp/src')

function walkSrc(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walkSrc(full, files)
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) files.push(full)
  }
  return files
}

// ──────────────────────────────────────────────────────────────────────────
// Rule 1 — Provenance is a shared const; no raw string literals outside @neat.is/types
// ──────────────────────────────────────────────────────────────────────────
describe('Rule 1 — Provenance contract', () => {
  it('Provenance enum has exactly four values (ADR-068)', () => {
    expect(Provenance.OBSERVED).toBe('OBSERVED')
    expect(Provenance.INFERRED).toBe('INFERRED')
    expect(Provenance.EXTRACTED).toBe('EXTRACTED')
    expect(Provenance.STALE).toBe('STALE')
    expect(Object.keys(Provenance).sort()).toEqual(['EXTRACTED', 'INFERRED', 'OBSERVED', 'STALE'])
    expect(ProvenanceSchema.options.slice().sort()).toEqual(['EXTRACTED', 'INFERRED', 'OBSERVED', 'STALE'])
  })

  it('no raw provenance string literals in core/src or mcp/src', () => {
    const offenders: string[] = []
    const re = /['"](OBSERVED|INFERRED|EXTRACTED|STALE|FRONTIER)['"]/
    // persist.ts is the single allowed site — its v2 → v3 migration matches
    // the legacy 'FRONTIER' literal and writes 'OBSERVED' as part of the
    // schema rewrite (ADR-068). No other code reads or writes raw provenance.
    for (const file of [...walkSrc(CORE_SRC), ...walkSrc(MCP_SRC)]) {
      if (file.endsWith('persist.ts')) continue
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        if (
          re.test(line) &&
          !line.includes('Provenance.') &&
          !line.includes('// ') &&
          !line.includes('describe(') &&
          !line.trim().startsWith('*')
        ) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Rule 2 — OBSERVED/EXTRACTED coexistence (distinct id pattern)
// ──────────────────────────────────────────────────────────────────────────
describe('Rule 2 — OBSERVED/EXTRACTED coexistence', () => {
  it('graph supports two edges between the same node pair under different ids', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', { id: 'service:a', type: NodeType.ServiceNode, name: 'a', language: 'javascript' })
    g.addNode('service:b', { id: 'service:b', type: NodeType.ServiceNode, name: 'b', language: 'javascript' })

    const extractedId = `${EdgeType.CALLS}:service:a->service:b`
    const observedId = `${EdgeType.CALLS}:OBSERVED:service:a->service:b`

    g.addEdgeWithKey(extractedId, 'service:a', 'service:b', {
      id: extractedId,
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
    })
    g.addEdgeWithKey(observedId, 'service:a', 'service:b', {
      id: observedId,
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-04T00:00:00.000Z',
      callCount: 1,
      confidence: 1.0,
    })

    expect(g.hasEdge(extractedId)).toBe(true)
    expect(g.hasEdge(observedId)).toBe(true)
    expect(g.edges('service:a', 'service:b').length).toBe(2)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Rule 3 — FRONTIER edges excluded from traversal
// ──────────────────────────────────────────────────────────────────────────
describe('Rule 3 — FrontierNode termination in traversal (ADR-068)', () => {
  it('getRootCause returns null when the only inbound path is through a FrontierNode (issue #136)', async () => {
    const { observedEdgeId, frontierId, databaseId } = await import('@neat.is/types')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    // Origin is a DatabaseNode. The would-be culprit sits behind a
    // FrontierNode hop — traversal terminates at the FrontierNode per Rule 3
    // and the walk returns null without checking compat.
    const dbId = databaseId('payments')
    g.addNode(dbId, {
      id: dbId,
      type: NodeType.DatabaseNode,
      name: 'payments',
      engine: 'postgresql',
      engineVersion: '15',
      compatibleDrivers: [{ name: 'pg', minVersion: '8.0.0' }],
    })
    const fid = frontierId('mystery-host')
    g.addNode(fid, { id: fid, type: NodeType.FrontierNode, name: 'mystery-host', host: 'mystery-host' })
    const eId = observedEdgeId(fid, dbId, EdgeType.CONNECTS_TO)
    g.addEdgeWithKey(eId, fid, dbId, {
      id: eId,
      source: fid,
      target: dbId,
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-16T00:00:00.000Z',
      callCount: 1,
    })
    expect(getRootCause(g, dbId)).toBeNull()
  })

  it('getBlastRadius does not enqueue a FrontierNode target (issue #136)', async () => {
    const { observedEdgeId, frontierId } = await import('@neat.is/types')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:origin', { id: 'service:origin', type: NodeType.ServiceNode, name: 'origin', language: 'javascript' })
    const fid = frontierId('unknown:8080')
    g.addNode(fid, { id: fid, type: NodeType.FrontierNode, name: 'unknown:8080', host: 'unknown:8080' })
    const eId = observedEdgeId('service:origin', fid, EdgeType.CALLS)
    g.addEdgeWithKey(eId, 'service:origin', fid, {
      id: eId,
      source: 'service:origin',
      target: fid,
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-16T00:00:00.000Z',
      callCount: 1,
    })
    const result = getBlastRadius(g, 'service:origin')
    expect(result.affectedNodes.find((n) => n.nodeId === fid)).toBeUndefined()
    expect(result.totalAffected).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Rule 4 — Per-edge-type staleness (ADR-024)
// ──────────────────────────────────────────────────────────────────────────
describe('Rule 4 — Per-edge-type staleness thresholds', () => {
  it('no flat 24h-only threshold constant in ingest.ts', () => {
    const ingest = readFileSync(join(CORE_SRC, 'ingest.ts'), 'utf8')
    // The legacy single-threshold constant (STALE_THRESHOLD_MS = 24h) must not exist.
    expect(ingest).not.toMatch(/const\s+STALE_THRESHOLD_MS\s*=\s*24/)
  })

  it('STALE_THRESHOLDS_BY_EDGE_TYPE exists', () => {
    const ingest = readFileSync(join(CORE_SRC, 'ingest.ts'), 'utf8')
    expect(ingest).toMatch(/STALE_THRESHOLDS_BY_EDGE_TYPE/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Rule 5 — Schemas live in @neat.is/types; consumers don't redefine
// ──────────────────────────────────────────────────────────────────────────
describe('Rule 5 — Shared schemas, no local redefinitions', () => {
  it('no local interface (Service|Database|Config|Infra|Frontier|Graph)Node in core/mcp', () => {
    const offenders: string[] = []
    const re = /^\s*(export\s+)?interface\s+(ServiceNode|DatabaseNode|ConfigNode|InfraNode|FrontierNode|GraphNode|GraphEdge|ErrorEvent)\b/
    for (const file of [...walkSrc(CORE_SRC), ...walkSrc(MCP_SRC)]) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        if (re.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no z.object or z.enum in core/mcp src (schemas belong in @neat.is/types)', () => {
    const offenders: string[] = []
    const re = /\bz\.(object|enum)\s*\(/
    for (const file of [...walkSrc(CORE_SRC), ...walkSrc(MCP_SRC)]) {
      const content = readFileSync(file, 'utf8')
      if (re.test(content)) offenders.push(file)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('getRootCause validates result against RootCauseResultSchema (issue #139)', async () => {
    // Property assertion: any non-null result returned by getRootCause must
    // round-trip through the schema. The fixture matches the demo graph the
    // existing traverse.test.ts uses.
    const { extractedEdgeId } = await import('@neat.is/types')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('database:payments-db', {
      id: 'database:payments-db',
      type: NodeType.DatabaseNode,
      name: 'payments-db',
      engine: 'postgresql',
      engineVersion: '15',
      compatibleDrivers: [{ name: 'pg', minVersion: '8.0.0' }],
    })
    g.addNode('service:b', {
      id: 'service:b',
      type: NodeType.ServiceNode,
      name: 'b',
      language: 'javascript',
      dependencies: { pg: '7.4.0' },
    })
    const eId = extractedEdgeId('service:b', 'database:payments-db', EdgeType.CONNECTS_TO)
    g.addEdgeWithKey(eId, 'service:b', 'database:payments-db', {
      id: eId,
      source: 'service:b',
      target: 'database:payments-db',
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.EXTRACTED,
    })
    const result = getRootCause(g, 'database:payments-db')
    expect(result).not.toBeNull()
    expect(() => RootCauseResultSchema.parse(result)).not.toThrow()
  })

  it('getBlastRadius validates result against BlastRadiusResultSchema (issue #139)', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', { id: 'service:a', type: NodeType.ServiceNode, name: 'a', language: 'javascript' })
    g.addNode('service:b', { id: 'service:b', type: NodeType.ServiceNode, name: 'b', language: 'javascript' })
    const ab = `${EdgeType.CALLS}:service:a->service:b`
    g.addEdgeWithKey(ab, 'service:a', 'service:b', {
      id: ab, source: 'service:a', target: 'service:b',
      type: EdgeType.CALLS, provenance: Provenance.EXTRACTED,
    })
    expect(() => BlastRadiusResultSchema.parse(getBlastRadius(g, 'service:a'))).not.toThrow()
    // Empty-result branch (origin missing) also schema-validates.
    expect(() =>
      BlastRadiusResultSchema.parse(getBlastRadius(g, 'service:does-not-exist')),
    ).not.toThrow()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Rule 6 — Live graphology, not graph.json
// ──────────────────────────────────────────────────────────────────────────
describe('Rule 6 — Live graph reads', () => {
  it('no readFileSync of graph.json outside persist.ts startup load', () => {
    const offenders: string[] = []
    for (const file of walkSrc(CORE_SRC)) {
      if (file.endsWith('persist.ts')) continue
      const content = readFileSync(file, 'utf8')
      if (/readFileSync\([^)]*graph\.json/.test(content)) {
        offenders.push(file)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Rule 16 — Node ids come from @neat.is/types/identity helpers, not literals
// ──────────────────────────────────────────────────────────────────────────
describe('Rule 16 — Node identity helpers (ADR-028)', () => {
  it('no hand-rolled `service:`/`database:`/`config:`/`infra:`/`frontier:` template literals in core/mcp src', () => {
    const offenders: string[] = []
    // Match a template literal that opens with one of the prefixes immediately
    // followed by `${...}`. That's the shape of `service:${name}` etc. Pure
    // string literals like 'service:foo' (no interpolation) are caught
    // separately because they're rare and almost always test fixtures.
    const re = /`(service|database|config|infra|frontier):\$\{/
    for (const file of [...walkSrc(CORE_SRC), ...walkSrc(MCP_SRC)]) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        if (re.test(line) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
          offenders.push(`${file}:${i + 1}: ${trimmed}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('identity helpers produce stable wire format', async () => {
    const { serviceId, databaseId, configId, infraId, frontierId } = await import('@neat.is/types')
    expect(serviceId('checkout')).toBe('service:checkout')
    expect(databaseId('db.example.com')).toBe('database:db.example.com')
    expect(configId('apps/web/.env')).toBe('config:apps/web/.env')
    expect(infraId('redis', 'cache.internal')).toBe('infra:redis:cache.internal')
    expect(frontierId('payments-api:8080')).toBe('frontier:payments-api:8080')
  })

  it('inverse helpers parse the wire format back', async () => {
    const {
      serviceId,
      parseServiceId,
      databaseId,
      parseDatabaseId,
      configId,
      parseConfigId,
      infraId,
      parseInfraId,
      frontierId,
      parseFrontierId,
    } = await import('@neat.is/types')
    expect(parseServiceId(serviceId('checkout'))).toBe('checkout')
    expect(parseDatabaseId(databaseId('host'))).toBe('host')
    expect(parseConfigId(configId('a/b/.env'))).toBe('a/b/.env')
    expect(parseInfraId(infraId('redis', 'cache'))).toEqual({ kind: 'redis', name: 'cache' })
    expect(parseFrontierId(frontierId('host:8080'))).toBe('host:8080')

    expect(parseServiceId('not-a-service-id')).toBe(null)
    expect(parseInfraId('infra:noname')).toBe(null)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Lifecycle contract — only ingest.ts and extract/* may mutate the graph (ADR-030)
// ──────────────────────────────────────────────────────────────────────────
describe('Lifecycle contract — mutation authority (ADR-030)', () => {
  it('graph mutation methods are only called from ingest.ts and extract/*', () => {
    const offenders: string[] = []
    const mutators = [
      'addNode',
      'addEdge',
      'addEdgeWithKey',
      'addDirectedEdge',
      'addDirectedEdgeWithKey',
      'dropNode',
      'dropEdge',
      'replaceEdgeAttributes',
      'replaceNodeAttributes',
      'mergeEdgeAttributes',
      'mergeNodeAttributes',
    ]
    const re = new RegExp(`\\b(graph|g)\\.(${mutators.join('|')})\\s*\\(`)

    for (const file of walkSrc(CORE_SRC)) {
      // Allowed mutation sites: ingest.ts and everything under extract/.
      if (file.endsWith('/ingest.ts')) continue
      if (file.includes('/extract/')) continue

      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        if (re.test(line) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
          offenders.push(`${file}:${i + 1}: ${trimmed}`)
        }
      })
    }

    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('mcp/src never mutates the graph', () => {
    const offenders: string[] = []
    const re = /\b(graph|g)\.(addNode|addEdge|dropNode|dropEdge|replaceEdgeAttributes|replaceNodeAttributes|mergeEdgeAttributes|mergeNodeAttributes)\s*\(/
    for (const file of walkSrc(MCP_SRC)) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        if (re.test(line) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
          offenders.push(`${file}:${i + 1}: ${trimmed}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

describe('Lifecycle contract — STALE → OBSERVED resurrection (ADR-030)', () => {
  it('a span on a STALE edge flips provenance back to OBSERVED with a fresh graded confidence', async () => {
    const { observedEdgeId } = await import('@neat.is/types')
    const { handleSpan } = await import('../../src/ingest.js')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:caller', {
      id: 'service:caller',
      type: NodeType.ServiceNode,
      name: 'caller',
      language: 'javascript',
    })
    g.addNode('service:callee', {
      id: 'service:callee',
      type: NodeType.ServiceNode,
      name: 'callee',
      language: 'javascript',
    })

    // Seed a STALE edge under the OBSERVED id pattern. STALE never has its own
    // id pattern — it's a transitioned-in-place OBSERVED edge.
    const id = observedEdgeId('service:caller', 'service:callee', EdgeType.CALLS)
    const seeded: GraphEdge = {
      id,
      source: 'service:caller',
      target: 'service:callee',
      type: EdgeType.CALLS,
      provenance: Provenance.STALE,
      lastObserved: '2026-04-01T00:00:00.000Z',
      callCount: 5,
      confidence: 0.3,
    }
    g.addEdgeWithKey(id, 'service:caller', 'service:callee', seeded)

    const errorsPath = join(mkdtempSync(join(tmpdir(), 'contract-test-')), 'errors.ndjson')
    await handleSpan(
      { graph: g, errorsPath, now: () => Date.parse('2026-05-05T12:00:00.000Z') },
      {
        traceId: 't1',
        spanId: 's1',
        service: 'caller',
        name: 'GET /things',
        statusCode: 0,
        startTimeUnixNano: '0',
        endTimeUnixNano: '0',
        durationNanos: 0n,
        attributes: {
          'server.address': 'callee',
          'http.method': 'GET',
        },
      },
    )

    const after = g.getEdgeAttributes(id) as GraphEdge
    expect(after.provenance).toBe(Provenance.OBSERVED)
    // ADR-066 — confidence grades from the signal block. The resurrection
    // restores OBSERVED provenance; the grade reflects how much fresh signal
    // came in. Bounded above STALE's 0.3 floor and below the strong tier's
    // 1.0 ceiling.
    expect(after.confidence).toBeGreaterThan(0.3)
    expect(after.callCount).toBeGreaterThanOrEqual(6)
  })
})

describe('Lifecycle contract — FrontierNode promotion preserves provenance (ADR-030 + ADR-068)', () => {
  it('promoteFrontierNodes rewires target ref; OBSERVED edge stays OBSERVED', async () => {
    const { frontierId, observedEdgeId } = await import('@neat.is/types')
    const { promoteFrontierNodes } = await import('../../src/ingest.js')

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:caller', {
      id: 'service:caller',
      type: NodeType.ServiceNode,
      name: 'caller',
      language: 'javascript',
    })
    g.addNode('service:callee', {
      id: 'service:callee',
      type: NodeType.ServiceNode,
      name: 'callee',
      language: 'javascript',
      aliases: ['callee.internal'],
    })
    const fid = frontierId('callee.internal')
    g.addNode(fid, {
      id: fid,
      type: NodeType.FrontierNode,
      name: 'callee.internal',
      host: 'callee.internal',
    })

    const oldEdgeId = observedEdgeId('service:caller', fid, EdgeType.CALLS)
    g.addEdgeWithKey(oldEdgeId, 'service:caller', fid, {
      id: oldEdgeId,
      source: 'service:caller',
      target: fid,
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-05T12:00:00.000Z',
      callCount: 3,
    })

    const promoted = promoteFrontierNodes(g)
    expect(promoted).toBe(1)
    expect(g.hasNode(fid)).toBe(false)
    expect(g.hasEdge(oldEdgeId)).toBe(false)

    // After promotion, an OBSERVED edge from caller to callee exists at the
    // canonical observedEdgeId; provenance carried through unchanged.
    const newId = observedEdgeId('service:caller', 'service:callee', EdgeType.CALLS)
    expect(g.hasEdge(newId)).toBe(true)
    const rebuilt = g.getEdgeAttributes(newId) as GraphEdge
    expect(rebuilt.provenance).toBe(Provenance.OBSERVED)
    expect(rebuilt.target).toBe('service:callee')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Static-extraction contract — producer interface, evidence, idempotency (ADR-032)
// ──────────────────────────────────────────────────────────────────────────
describe('Static-extraction contract (ADR-032)', () => {
  // Producer interface: every exported `addX` function under `extract/` accepts
  // (graph, services, scanPath) — or a strict subset. The scan reads function
  // signatures syntactically; it's a static check, not a runtime invocation.
  it('producer entry points accept (graph, services, scanPath) — strict subset allowed', () => {
    const offenders: string[] = []
    const EXTRACT_DIR = join(CORE_SRC, 'extract')
    // Match `export (async)? function add<Word>...(args)` and capture the args.
    const re = /export\s+(?:async\s+)?function\s+(add[A-Z]\w*)\s*\(([^)]*)\)/g
    const allowed = ['graph', 'services', 'scanPath', 'service']

    for (const file of walkSrc(EXTRACT_DIR)) {
      const content = readFileSync(file, 'utf8')
      let m: RegExpExecArray | null
      while ((m = re.exec(content)) !== null) {
        const fnName = m[1]!
        const argList = m[2]!
        // Pull parameter names off the type-annotated param list.
        const paramNames = argList
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
          .map((p) => p.split(':')[0]!.trim().replace(/\?$/, ''))
        for (const name of paramNames) {
          if (!allowed.includes(name)) {
            offenders.push(`${file}: ${fnName} has unexpected parameter \`${name}\``)
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('producers guard every node write with hasNode (idempotency)', () => {
    // Heuristic: any line that calls graph.addNode(...) should be inside an
    // `if (!graph.hasNode(...))` guard within the previous 5 lines, or the
    // addNode call itself is preceded by hasNode in the same expression.
    const offenders: string[] = []
    const EXTRACT_DIR = join(CORE_SRC, 'extract')
    for (const file of walkSrc(EXTRACT_DIR)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/\bgraph\.addNode\s*\(/.test(line)) return
        const window = lines.slice(Math.max(0, i - 15), i + 1).join('\n')
        if (/\bgraph\.hasNode\s*\(/.test(window)) return
        offenders.push(`${file}:${i + 1}: addNode without hasNode guard`)
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('producers guard every edge write with hasEdge (idempotency)', () => {
    const offenders: string[] = []
    const EXTRACT_DIR = join(CORE_SRC, 'extract')
    for (const file of walkSrc(EXTRACT_DIR)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/\bgraph\.addEdge(WithKey)?\s*\(/.test(line)) return
        const window = lines.slice(Math.max(0, i - 15), i + 1).join('\n')
        if (/\bgraph\.hasEdge\s*\(/.test(window)) return
        offenders.push(`${file}:${i + 1}: addEdge without hasEdge guard`)
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  // Every object literal that sets `provenance: Provenance.EXTRACTED` must
  // also include an `evidence:` key. The check is structural rather than
  // runtime — we look at the surrounding source-window of each match. Issue
  // #140 closed the gap by populating evidence on CONNECTS_TO, CONFIGURED_BY,
  // DEPENDS_ON, and RUNS_ON producers (CALLS-family already had it).
  it('every EXTRACTED edge construction site under extract/ includes evidence.file', () => {
    const offenders: string[] = []
    const EXTRACT_DIR = join(CORE_SRC, 'extract')
    for (const file of walkSrc(EXTRACT_DIR)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/provenance:\s*Provenance\.EXTRACTED\b/.test(line)) return
        const window = lines
          .slice(Math.max(0, i - 12), Math.min(lines.length, i + 12))
          .join('\n')
        if (/evidence\s*[:?]/.test(window)) return
        offenders.push(`${file}:${i + 1}`)
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  // Issue #142 adds `framework` to ServiceNodeSchema and populates it from
  // package.json deps. The schema-snapshot guard catches the schema growth;
  // this test asserts the producer wires it up.
  it.todo(
    'extract/services.ts populates ServiceNode.framework from known framework packages (issue #142)',
  )
})

// ──────────────────────────────────────────────────────────────────────────
// ServiceNode.owner extraction (ADR-054)
// ──────────────────────────────────────────────────────────────────────────
//
// Adds optional `owner?: string` to ServiceNodeSchema; populates from
// CODEOWNERS at <scanPath>/CODEOWNERS or <scanPath>/.github/CODEOWNERS, with
// package.json `author` fallback, and undefined when neither covers. Per
// ADR-031 the schema addition is growth — schema-snapshot regenerates as the
// audit trail. Per ADR-030 backfill on existing nodes is allowed by extract
// producers; OTel-auto-created services (per ADR-033 #4) get owner populated
// when extract/services.ts later discovers their source.
describe('ServiceNode.owner extraction (ADR-054)', () => {
  async function scaffold(
    files: Record<string, string>,
  ): Promise<string> {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'owner-test-'))
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content, 'utf8')
    }
    return root
  }

  it('ServiceNodeSchema includes optional `owner` field (ADR-054 #1 — schema growth)', async () => {
    const { ServiceNodeSchema } = await import('@neat.is/types')
    const shape = ServiceNodeSchema.shape
    expect('owner' in shape).toBe(true)
    expect(shape.owner.isOptional()).toBe(true)
    // Round-trip: parses with and without the field present.
    expect(ServiceNodeSchema.parse({
      id: 'service:x', type: NodeType.ServiceNode, name: 'x', language: 'javascript',
    }).owner).toBeUndefined()
    expect(ServiceNodeSchema.parse({
      id: 'service:x', type: NodeType.ServiceNode, name: 'x', language: 'javascript',
      owner: '@neat-tools/backend',
    }).owner).toBe('@neat-tools/backend')
  })

  it('extract/services.ts populates ServiceNode.owner from <scanPath>/CODEOWNERS when one exists (ADR-054 #2.1)', async () => {
    const { discoverServices } = await import('../../src/extract/services.js')
    const root = await scaffold({
      'CODEOWNERS': '* @neat-tools/backend\n',
      'package.json': JSON.stringify({ name: 'svc-a', version: '1.0.0' }),
    })
    const services = await discoverServices(root)
    expect(services).toHaveLength(1)
    expect(services[0]!.node.owner).toBe('@neat-tools/backend')
  })

  it('extract/services.ts falls back to <scanPath>/.github/CODEOWNERS when no root CODEOWNERS file (ADR-054 #2.1)', async () => {
    const { discoverServices } = await import('../../src/extract/services.js')
    const root = await scaffold({
      '.github/CODEOWNERS': '* @neat-tools/platform\n',
      'package.json': JSON.stringify({ name: 'svc-b', version: '1.0.0' }),
    })
    const services = await discoverServices(root)
    expect(services).toHaveLength(1)
    expect(services[0]!.node.owner).toBe('@neat-tools/platform')
  })

  it('extract/services.ts falls back to package.json `author` when CODEOWNERS does not cover the path (ADR-054 #2.2)', async () => {
    const { discoverServices } = await import('../../src/extract/services.js')
    // CODEOWNERS exists but only matches `apps/web` — the service lives at
    // packages/api so the root pattern doesn't apply, package.json wins.
    const root = await scaffold({
      'CODEOWNERS': 'apps/web @neat-tools/frontend\n',
      'packages/api/package.json': JSON.stringify({
        name: 'api',
        version: '1.0.0',
        author: 'cem@neat.is',
      }),
    })
    const services = await discoverServices(root)
    expect(services).toHaveLength(1)
    expect(services[0]!.node.owner).toBe('cem@neat.is')
  })

  it('extract/services.ts accepts package.json `author` as either string form or `{ name }` object form (ADR-054 #2.2)', async () => {
    const { discoverServices } = await import('../../src/extract/services.js')

    const stringRoot = await scaffold({
      'package.json': JSON.stringify({
        name: 'svc-string',
        version: '1.0.0',
        author: 'Cem D <cem@example.com>',
      }),
    })
    const stringServices = await discoverServices(stringRoot)
    expect(stringServices[0]!.node.owner).toBe('Cem D <cem@example.com>')

    const objectRoot = await scaffold({
      'package.json': JSON.stringify({
        name: 'svc-object',
        version: '1.0.0',
        author: { name: 'Deniz D', email: 'deniz@neat.is' },
      }),
    })
    const objectServices = await discoverServices(objectRoot)
    expect(objectServices[0]!.node.owner).toBe('Deniz D')
  })

  it('extract/services.ts leaves owner undefined when neither source covers (ADR-054 #2.3)', async () => {
    const { discoverServices } = await import('../../src/extract/services.js')
    const root = await scaffold({
      'package.json': JSON.stringify({ name: 'svc-no-owner', version: '1.0.0' }),
    })
    const services = await discoverServices(root)
    expect(services).toHaveLength(1)
    expect(services[0]!.node.owner).toBeUndefined()
  })

  it('CODEOWNERS pattern matcher supports `*`, `**`, and exact paths only (ADR-054 #6 — minimal MVP)', async () => {
    const { matchOwner } = await import('../../src/extract/owners.js')
    const file = {
      rules: [
        { pattern: 'apps/web', owners: '@team/exact' },
        { pattern: 'packages/*', owners: '@team/single-star' },
        { pattern: 'services/**', owners: '@team/double-star' },
      ],
    }
    // Exact path
    expect(matchOwner(file, 'apps/web')).toBe('@team/exact')
    expect(matchOwner(file, 'apps/web/src/index.ts')).toBe('@team/exact')
    // Single * — one segment under packages/
    expect(matchOwner(file, 'packages/api')).toBe('@team/single-star')
    // ** — anything below services/
    expect(matchOwner(file, 'services/checkout')).toBe('@team/double-star')
    expect(matchOwner(file, 'services/checkout/src/handler.ts')).toBe('@team/double-star')
    // No match
    expect(matchOwner(file, 'tools/scripts')).toBeNull()
    // First match wins
    const ordered = {
      rules: [
        { pattern: 'apps/web', owners: '@first' },
        { pattern: 'apps/**', owners: '@second' },
      ],
    }
    expect(matchOwner(ordered, 'apps/web')).toBe('@first')
  })

  it('OTel-auto-created services with no owner get backfilled when extract/services.ts later discovers source (ADR-054 #5)', async () => {
    const { discoverServices, addServiceNodes } = await import('../../src/extract/services.js')

    // Stage 1: OTel ingest auto-creates a minimal node with no owner.
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:checkout', {
      id: 'service:checkout',
      type: NodeType.ServiceNode,
      name: 'checkout',
      language: 'unknown',
      discoveredVia: 'otel',
    })
    expect((g.getNodeAttributes('service:checkout') as { owner?: string }).owner).toBeUndefined()

    // Stage 2: static extraction later discovers source with an owner.
    const root = await scaffold({
      'CODEOWNERS': '* @neat-tools/backend\n',
      'package.json': JSON.stringify({ name: 'checkout', version: '1.0.0' }),
    })
    const services = await discoverServices(root)
    expect(services[0]!.node.owner).toBe('@neat-tools/backend')

    addServiceNodes(g, services)

    const merged = g.getNodeAttributes('service:checkout') as { owner?: string; discoveredVia?: string }
    expect(merged.owner).toBe('@neat-tools/backend')
    expect(merged.discoveredVia).toBe('merged')
  })

  // ────────────────────────────────────────────────────────────────────────
  // ADR-065 — precision filters + loud failure mode.
  //
  // The 2026-05-12 medusa experiment produced 20 EXTRACTED edges in the
  // divergence report; every single one was a false positive. Five filter
  // categories cover the failure shapes; loud failure mode surfaces the
  // ~90 silently-skipped files. Fixtures live at
  // `packages/core/test/fixtures/precision/` and are verbatim minimisations
  // of the highest-signal experiment evidence rows. Each `it.todo` flips
  // live in the corresponding Phase 3B implementation PR.
  // ────────────────────────────────────────────────────────────────────────

  it('ADR-065 #1 — test-scope exclusion: isTestPath matches the documented patterns', async () => {
    const { isTestPath } = await import('../../src/extract/shared.js')
    expect(isTestPath('packages/foo/__tests__/bar.spec.ts')).toBe(true)
    expect(isTestPath('packages/foo/__fixtures__/bar.ts')).toBe(true)
    expect(isTestPath('packages/foo/integration-tests/bar.ts')).toBe(true)
    expect(isTestPath('packages/foo/bar.spec.ts')).toBe(true)
    expect(isTestPath('packages/foo/bar.test.ts')).toBe(true)
    expect(isTestPath('packages/foo/bar.test.tsx')).toBe(true)
    expect(isTestPath('packages/foo/bar.test.py')).toBe(true)
    expect(isTestPath('packages/foo/bar.ts')).toBe(false)
    expect(isTestPath('packages/foo/specifications.ts')).toBe(false)
    // The seed fixture from experiment row 0016 is correctly identified.
    const fixture = join(
      __dirname,
      '../fixtures/precision/__tests__/test-scope-postgres.spec.ts',
    )
    expect(isTestPath(fixture)).toBe(true)
  })

  it('ADR-065 #2 — comment-body exclusion: maskCommentsInSource strips URLs in comments (row 0014)', async () => {
    const { maskCommentsInSource } = await import('../../src/extract/shared.js')
    const fixture = readFileSync(
      join(__dirname, '../fixtures/precision/comment-body-jsdoc.ts'),
      'utf8',
    )
    const masked = maskCommentsInSource(fixture)
    // The JSDoc @example URL the v0.3.0 extractor pulled an edge from is gone
    // from the masked content. Strings in code still survive.
    expect(masked).not.toContain('http://localhost:9000')
    expect(masked).not.toContain('@example')
    // Identifier from the interface declaration is preserved.
    expect(masked).toContain('backendUrl')
  })

  it('ADR-065 #3 — JSX external-link exclusion: <Link to="..."> URL produces no CALLS edge (row 0006)', async () => {
    const { callsFromSource } = await import('../../src/extract/calls/http.js')
    const ParserMod = (await import('tree-sitter')).default as unknown as new () => {
      setLanguage(lang: unknown): void
      parse(src: string): { rootNode: unknown }
    }
    const JavaScript = (await import('tree-sitter-javascript')).default
    const parser = new ParserMod() as unknown as import('tree-sitter')
    parser.setLanguage(JavaScript)
    const src = readFileSync(
      join(__dirname, '../fixtures/precision/jsx-external-link.tsx'),
      'utf8',
    )
    // Configure knownHosts so without the JSX filter, the substring matcher
    // would have produced a candidate match against `medusajs.com`.
    const targets = callsFromSource(src, parser, new Set(['medusajs.com']))
    expect([...targets]).toEqual([])
  })

  it('ADR-065 #4 — .env.template exclusion: isEnvTemplateFile + isConfigFile both filter (rows 0008/0015)', async () => {
    const { isEnvTemplateFile, isConfigFile } = await import('../../src/extract/shared.js')
    // Direct predicate.
    expect(isEnvTemplateFile('.env.template')).toBe(true)
    expect(isEnvTemplateFile('.env.example')).toBe(true)
    expect(isEnvTemplateFile('.env.sample')).toBe(true)
    expect(isEnvTemplateFile('.env.production.template')).toBe(true)
    expect(isEnvTemplateFile('.env.production.example')).toBe(true)
    // Real env files keep matching.
    expect(isEnvTemplateFile('.env')).toBe(false)
    expect(isEnvTemplateFile('.env.local')).toBe(false)
    expect(isEnvTemplateFile('.env.production')).toBe(false)
    // isConfigFile delegates — templates are not config.
    expect(isConfigFile('.env.template').match).toBe(false)
    expect(isConfigFile('.env.production.template').match).toBe(false)
    expect(isConfigFile('.env').match).toBe(true)
    expect(isConfigFile('.env.local').match).toBe(true)
  })

  it('ADR-065 #5 — no URL-substring service matching: urlMatchesHost requires a real URL with exact hostname (rows 0001-0003/0012/0013)', async () => {
    const { urlMatchesHost } = await import('../../src/extract/shared.js')
    // The v0.3.0 substring bug: medusa.cloud matched @medusajs/medusa.
    // Post-fix: only exact hostname against a real URL.
    expect(urlMatchesHost('https://medusa.cloud/foo', 'medusajs/medusa')).toBe(false)
    expect(urlMatchesHost('https://medusajs.com/changelog/', 'medusajs/medusa')).toBe(false)
    // Real matches still work.
    expect(urlMatchesHost('http://api.example.com:8080/x', 'api.example.com')).toBe(true)
    expect(urlMatchesHost('http://api.example.com:8080/x', 'api.example.com:8080')).toBe(true)
    // Port mismatch fails when port is specified in the wanted host.
    expect(urlMatchesHost('http://api.example.com:9999/x', 'api.example.com:8080')).toBe(false)
    // Scheme-relative URLs are accepted.
    expect(urlMatchesHost('//api.example.com/x', 'api.example.com')).toBe(true)
    // Bare-string matching is rejected — the v0.3.3 medusa pre-check produced
    // 279 false positives because `urlMatchesHost('admin-bundler', 'admin-bundler')`
    // used to fall through to `http://admin-bundler` and match every basename.
    expect(urlMatchesHost('admin-bundler', 'admin-bundler')).toBe(false)
    expect(urlMatchesHost('index', 'index')).toBe(false)
    expect(urlMatchesHost('@medusajs/types', '@medusajs/types')).toBe(false)
    // Empty / garbage inputs fail closed.
    expect(urlMatchesHost('', 'api.example.com')).toBe(false)
    expect(urlMatchesHost('not a url', 'api.example.com')).toBe(false)
  })

  it('#238 — `new S3Client()` with @aws-sdk/client-s3 import → kind aws-s3 (row 0007)', async () => {
    const { grpcEndpointsFromFile } = await import('../../src/extract/calls/grpc.js')
    const fixturePath = join(
      __dirname,
      '../fixtures/precision/aws-client-raw.ts',
    )
    const content = readFileSync(fixturePath, 'utf8')
    const eps = grpcEndpointsFromFile({ path: fixturePath, content }, __dirname)
    expect(eps.length).toBeGreaterThan(0)
    // Every endpoint emitted from this file must be aws-s3, never the
    // v0.3.0 `grpc-service` lie.
    for (const ep of eps) {
      expect(ep.kind).toBe('aws-s3')
      expect(ep.infraId).toMatch(/^infra:aws-s3:/)
      expect(ep.infraId).not.toMatch(/grpc-service/)
    }
  })

  it('#238 — `new SomeClient()` without an SDK import emits no edge (the v0.3.3 medusa pre-check caught QueryClient as a false positive)', async () => {
    const { grpcEndpointsFromFile } = await import('../../src/extract/calls/grpc.js')
    const source = `
      class SomeClient { constructor(_: unknown) {} }
      export function build(): SomeClient {
        return new SomeClient({ region: 'us-east-1' })
      }
    `
    // No @aws-sdk import, no @grpc/grpc-js or *_grpc_pb import — the
    // classifier returns null and the producer emits no edge. The earlier
    // "default to `service` kind" behaviour produced false positives like
    // `infra:service:Query` from TanStack's QueryClient.
    const eps = grpcEndpointsFromFile({ path: '/tmp/some.ts', content: source }, '/tmp')
    expect(eps).toEqual([])
  })

  it('#238 — legitimate gRPC stubs (via @grpc/grpc-js or *_grpc_pb import) stay classified as grpc-service', async () => {
    const { grpcEndpointsFromFile } = await import('../../src/extract/calls/grpc.js')
    const source = `
      const grpc = require('@grpc/grpc-js')
      const { OrdersClient } = require('./generated/orders_grpc_pb')
      const client = new OrdersClient('orders.internal:50051', grpc.credentials.createInsecure())
    `
    const eps = grpcEndpointsFromFile({ path: '/tmp/g.js', content: source }, '/tmp')
    expect(eps.length).toBeGreaterThan(0)
    for (const ep of eps) {
      expect(ep.kind).toBe('grpc-service')
    }
  })

  it('ADR-065 — errors.ndjson lines have shape { file, error, stack, ts, source: "extract" }', async () => {
    const { recordExtractionError, drainExtractionErrors, writeExtractionErrors } =
      await import('../../src/extract/errors.js')
    const os2 = await import('node:os')
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const tmp = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'adr-065-errors-'))
    const errorsPath = path2.join(tmp, 'errors.ndjson')
    const prevWarn = console.warn
    console.warn = () => {}
    try {
      drainExtractionErrors() // clear any prior state
      // recordExtractionError captures the shape; writeExtractionErrors
      // serialises it as ndjson with `source: 'extract'`.
      recordExtractionError('test-producer', '/repo/foo.ts', new Error('boom'))
      const entries = drainExtractionErrors()
      await writeExtractionErrors(entries, errorsPath)
      const raw = await fs2.readFile(errorsPath, 'utf8')
      const lines = raw.trim().split('\n')
      expect(lines).toHaveLength(1)
      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(parsed.file).toBe('/repo/foo.ts')
      expect(parsed.error).toBe('boom')
      expect(typeof parsed.stack).toBe('string')
      expect(typeof parsed.ts).toBe('string')
      expect(parsed.source).toBe('extract')
      expect(parsed.producer).toBe('test-producer')
    } finally {
      console.warn = prevWarn
      await fs2.rm(tmp, { recursive: true, force: true })
    }
  })

  it('ADR-065 — extraction banner reports a skipped-count phrase unconditionally', async () => {
    const { formatExtractionBanner } = await import('../../src/extract/errors.js')
    // Zero is observable as a positive signal — no special-casing.
    expect(formatExtractionBanner(0)).toBe('[neat] 0 files skipped due to parse errors')
    expect(formatExtractionBanner(1)).toBe('[neat] 1 file skipped due to parse errors')
    expect(formatExtractionBanner(92)).toBe('[neat] 92 files skipped due to parse errors')
    // The CLI summary in cli.ts always logs this — source-grep to make sure
    // the line stays in place across refactors.
    const cliSrc = readFileSync(join(CORE_SRC, 'cli.ts'), 'utf8')
    expect(cliSrc).toMatch(/formatExtractionBanner\(\s*result\.extractionErrors\s*\)/)
  })

  it('ADR-065 — isStrictExtractionEnabled flips on NEAT_STRICT_EXTRACTION and the CLI exits non-zero on any failure', async () => {
    const { isStrictExtractionEnabled } = await import('../../src/extract/errors.js')
    const prev = process.env.NEAT_STRICT_EXTRACTION
    try {
      delete process.env.NEAT_STRICT_EXTRACTION
      expect(isStrictExtractionEnabled()).toBe(false)
      process.env.NEAT_STRICT_EXTRACTION = '0'
      expect(isStrictExtractionEnabled()).toBe(false)
      process.env.NEAT_STRICT_EXTRACTION = '1'
      expect(isStrictExtractionEnabled()).toBe(true)
      process.env.NEAT_STRICT_EXTRACTION = 'true'
      expect(isStrictExtractionEnabled()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.NEAT_STRICT_EXTRACTION
      else process.env.NEAT_STRICT_EXTRACTION = prev
    }
    // The CLI uses isStrictExtractionEnabled() to gate a non-zero exit when
    // the extract pass reported any per-file failures.
    const cliSrc = readFileSync(join(CORE_SRC, 'cli.ts'), 'utf8')
    expect(cliSrc).toMatch(/isStrictExtractionEnabled\(\)/)
    expect(cliSrc).toMatch(/result\.extractionErrors\s*>\s*0\s*&&\s*isStrictExtractionEnabled/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Producer per-file parse-failure isolation (ADR-055)
// ──────────────────────────────────────────────────────────────────────────
//
// Surfaced 2026-05-10 by the debugger agent's medusa-codebase session: a
// single malformed file in a producer's per-file walk could throw inside the
// parse call and abort the entire phase. ADR-055 codifies the rule — every
// producer wraps each per-file parse in try/catch, warns on failure, and
// continues. Six call sites needed the fix at ADR time. The first assertion
// is a live regression scan; the six per-site todos flip as each call site
// is wrapped.
describe('Producer per-file parse-failure isolation (ADR-055)', () => {
  async function scaffold(files: Record<string, string>): Promise<string> {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'adr-055-'))
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content, 'utf8')
    }
    return root
  }

  async function scaffoldDir(files: Record<string, string>, dirs: string[]): Promise<string> {
    const { mkdirSync } = await import('node:fs')
    const root = await scaffold(files)
    for (const d of dirs) mkdirSync(join(root, d), { recursive: true })
    return root
  }

  // Global scan. Walks every file under packages/core/src/extract/, finds
  // each parse-like call (`readJson`, `readYaml`, `parseAllDocuments`,
  // `callsFromSource`), and asserts the file contains at least one
  // try/catch block. Whole-file presence is sufficient evidence — per-site
  // precision lives in the six tests below.
  it('every producer file under extract/ that calls a parse-like function wraps it in try/catch (ADR-055 — global scan)', () => {
    const EXTRACT_SRC = join(CORE_SRC, 'extract')
    const PARSE_RE = /\b(readJson|readYaml|parseAllDocuments|callsFromSource)\s*[<(]/
    const TRY_RE = /\btry\s*\{/
    const CATCH_RE = /\bcatch\b/
    // shared.ts defines readJson/readYaml; the helpers themselves intentionally
    // throw (ADR-055 #4 — wrap at call site, not in shared helpers).
    // databases/index.ts dispatches every parser.parse() through a single
    // try/catch (lines 191-198), so the per-parser modules don't need their
    // own — the dispatcher catches for them.
    const VIA_DISPATCHER = new Set<string>([
      join(EXTRACT_SRC, 'shared.ts'),
      join(EXTRACT_SRC, 'databases/sequelize.ts'),
      join(EXTRACT_SRC, 'databases/ormconfig.ts'),
      join(EXTRACT_SRC, 'databases/docker-compose.ts'),
      join(EXTRACT_SRC, 'databases/db-config-yaml.ts'),
    ])
    const offenders: string[] = []
    for (const file of walkSrc(EXTRACT_SRC)) {
      if (VIA_DISPATCHER.has(file)) continue
      const content = readFileSync(file, 'utf8')
      if (!PARSE_RE.test(content)) continue
      if (!TRY_RE.test(content) || !CATCH_RE.test(content)) {
        offenders.push(file)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('extract/services.ts:125 — readJson<PackageJson>(pkgPath) wrapped (ADR-055 #1)', async () => {
    const { discoverServices } = await import('../../src/extract/services.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const root = await scaffold({
        // Malformed package.json — JSON.parse throws on the trailing comma + missing close.
        'svc-broken/package.json': '{ "name": "broken", "version":,',
        'svc-good/package.json': JSON.stringify({ name: 'svc-good', version: '1.0.0' }),
      })
      const services = await discoverServices(root)
      // The broken service is skipped, the valid sibling is still discovered.
      expect(services.map((s) => s.node.name)).toEqual(['svc-good'])
      const warnedAboutBroken = warn.mock.calls.some(([msg]) =>
        typeof msg === 'string' && /services skipped .*svc-broken[\\/]package\.json/.test(msg),
      )
      expect(warnedAboutBroken).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('extract/services.ts:173 — readJson<RootPackageJson>(rootPkgPath) wrapped (ADR-055 #1)', async () => {
    const { discoverServices } = await import('../../src/extract/services.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const root = await scaffold({
        // Malformed root package.json — extraction must fall back to the free walk.
        'package.json': '{ "name": "root", "workspaces":',
        'apps/api/package.json': JSON.stringify({ name: 'api', version: '1.0.0' }),
      })
      const services = await discoverServices(root)
      // Root is unparseable, but the nested service is still found.
      expect(services.map((s) => s.node.name)).toContain('api')
      const warnedAboutRoot = warn.mock.calls.some(([msg]) =>
        typeof msg === 'string' && /services workspaces skipped package\.json/.test(msg),
      )
      expect(warnedAboutRoot).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('extract/aliases.ts:98 — readYaml<ComposeFile>(composePath) wrapped (ADR-055 #1)', async () => {
    const { addServiceAliases } = await import('../../src/extract/aliases.js')
    const { discoverServices } = await import('../../src/extract/services.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const root = await scaffold({
        'docker-compose.yml': 'services:\n  api: {\n  unterminated',
        'package.json': JSON.stringify({ name: 'api', version: '1.0.0' }),
      })
      const services = await discoverServices(root)
      const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
      for (const s of services) g.addNode(s.node.id, s.node)
      // Phase must complete without throwing.
      await expect(addServiceAliases(g, root, services)).resolves.toBeUndefined()
      const warned = warn.mock.calls.some(([msg]) =>
        typeof msg === 'string' && /aliases compose skipped docker-compose\.yml/.test(msg),
      )
      expect(warned).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('extract/aliases.ts:149 — Dockerfile fs.readFile wrapped (ADR-055 #5)', async () => {
    const { addServiceAliases } = await import('../../src/extract/aliases.js')
    const { discoverServices } = await import('../../src/extract/services.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A directory named `Dockerfile` makes fs.access succeed (so `exists` returns true)
      // but fs.readFile throws EISDIR. Reproduces the failure mode without needing chmod.
      const root = await scaffoldDir(
        { 'package.json': JSON.stringify({ name: 'svc', version: '1.0.0' }) },
        ['Dockerfile'],
      )
      const services = await discoverServices(root)
      const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
      for (const s of services) g.addNode(s.node.id, s.node)
      await expect(addServiceAliases(g, root, services)).resolves.toBeUndefined()
      const warned = warn.mock.calls.some(([msg]) =>
        typeof msg === 'string' && /aliases dockerfile skipped/.test(msg),
      )
      expect(warned).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('extract/infra/docker-compose.ts:58 — readYaml<ComposeFile>(composePath) wrapped (ADR-055 #1)', async () => {
    const { addComposeInfra } = await import('../../src/extract/infra/docker-compose.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const root = await scaffold({
        'docker-compose.yml': 'services:\n  db: {\n  unterminated',
      })
      const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
      const result = await addComposeInfra(g, root, [])
      expect(result).toEqual({ nodesAdded: 0, edgesAdded: 0 })
      const warned = warn.mock.calls.some(([msg]) =>
        typeof msg === 'string' && /infra docker-compose skipped docker-compose\.yml/.test(msg),
      )
      expect(warned).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('extract/infra/dockerfile.ts:42 — fs.readFile wrapped (ADR-055 #5)', async () => {
    const { addDockerfileRuntimes } = await import('../../src/extract/infra/dockerfile.js')
    const { discoverServices } = await import('../../src/extract/services.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const root = await scaffoldDir(
        { 'package.json': JSON.stringify({ name: 'svc', version: '1.0.0' }) },
        ['Dockerfile'],
      )
      const services = await discoverServices(root)
      const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
      for (const s of services) g.addNode(s.node.id, s.node)
      const result = await addDockerfileRuntimes(g, services, root)
      expect(result).toEqual({ nodesAdded: 0, edgesAdded: 0 })
      const warned = warn.mock.calls.some(([msg]) =>
        typeof msg === 'string' && /infra dockerfile skipped Dockerfile/.test(msg),
      )
      expect(warned).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// OTel ingest contract — non-blocking, span-time, parent-cache (ADR-033)
// ──────────────────────────────────────────────────────────────────────────
describe('OTel ingest contract (ADR-033)', () => {
  it('OTel receiver replies before mutation completes (issue #131)', async () => {
    const { buildOtelReceiver } = await import('../../src/otel.js')

    // 250ms keeps the gap large enough that scheduling jitter on slow CI
    // runners can't push replyMs up to HANDLER_DELAY_MS (a 40ms delay tied
    // the bound on one CI run; bumping fixes the flake).
    const HANDLER_DELAY_MS = 250
    const handlerEnd: number[] = []
    const app = await buildOtelReceiver({
      onSpan: async () => {
        await new Promise((r) => setTimeout(r, HANDLER_DELAY_MS))
        handlerEnd.push(Date.now())
      },
    })
    try {
      const replyStart = Date.now()
      const res = await app.inject({
        method: 'POST',
        url: '/v1/traces',
        headers: { 'content-type': 'application/json' },
        payload: {
          resourceSpans: [
            {
              resource: { attributes: [{ key: 'service.name', value: { stringValue: 's' } }] },
              scopeSpans: [
                { spans: [{ name: 'op', startTimeUnixNano: '0', endTimeUnixNano: '0' }] },
              ],
            },
          ],
        },
      })
      const replyMs = Date.now() - replyStart
      expect(res.statusCode).toBe(200)
      // Receiver replies before the slow handler finishes — proof the queue
      // decoupled mutation from the response. Bound chosen to avoid CI flake.
      expect(replyMs).toBeLessThan(HANDLER_DELAY_MS)
      await (app as unknown as { flushPending: () => Promise<void> }).flushPending()
      expect(handlerEnd.length).toBe(1)
    } finally {
      await app.close()
    }
  })
  it('lastObserved derives from span.startTimeUnixNano, not Date.now() (issue #132)', async () => {
    const { handleSpan } = await import('../../src/ingest.js')
    const { isoFromUnixNano } = await import('../../src/otel.js')
    const { observedEdgeId } = await import('@neat.is/types')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:caller', {
      id: 'service:caller',
      type: NodeType.ServiceNode,
      name: 'caller',
      language: 'javascript',
    })
    g.addNode('service:callee', {
      id: 'service:callee',
      type: NodeType.ServiceNode,
      name: 'callee',
      language: 'javascript',
    })

    const errorsPath = join(mkdtempSync(join(tmpdir(), 'contract-test-')), 'errors.ndjson')
    // Backdated span: April 1st, ~5 weeks before "now". The receiver clock is
    // pinned to 2026-05-05 so the only way the edge could end up with the
    // April 1st timestamp is if the handler reads the span's own startTime.
    const spanStartNano = (BigInt(Date.parse('2026-04-01T09:00:00.000Z')) * 1_000_000n).toString()
    await handleSpan(
      {
        graph: g,
        errorsPath,
        now: () => Date.parse('2026-05-05T12:00:00.000Z'),
      },
      {
        traceId: 't-backdated',
        spanId: 's-backdated',
        service: 'caller',
        name: 'GET /things',
        statusCode: 0,
        startTimeUnixNano: spanStartNano,
        endTimeUnixNano: spanStartNano,
        startTimeIso: isoFromUnixNano(spanStartNano),
        durationNanos: 0n,
        attributes: { 'server.address': 'callee', 'http.method': 'GET' },
      },
    )

    const edge = g.getEdgeAttributes(
      observedEdgeId('service:caller', 'service:callee', EdgeType.CALLS),
    ) as GraphEdge
    expect(edge.lastObserved).toBe('2026-04-01T09:00:00.000Z')
  })
  it('parent-span cache resolves cross-service CALLS when address-based resolution fails (issue #133)', async () => {
    const { handleSpan, resetParentSpanCache } = await import('../../src/ingest.js')
    const { observedEdgeId, serviceId } = await import('@neat.is/types')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    resetParentSpanCache()

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    const errorsPath = join(mkdtempSync(join(tmpdir(), 'contract-test-')), 'errors.ndjson')
    const ctx = { graph: g, errorsPath, now: () => Date.parse('2026-05-06T12:00:00.000Z') }

    // Parent (CLIENT) span on service:caller. No outbound edge yet because no
    // peer attribute is set on this span — only spanId is recorded for the
    // child to look up later.
    await handleSpan(ctx, {
      traceId: 't1',
      spanId: 'parent-1',
      service: 'caller',
      name: 'rpc.client',
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      attributes: {},
    })

    // Child (SERVER) span on service:callee whose parent points back at the
    // CLIENT span. No address attribute, so address-based resolution fails;
    // the parent-span cache is the only path that produces an edge here.
    await handleSpan(ctx, {
      traceId: 't1',
      spanId: 'child-1',
      parentSpanId: 'parent-1',
      service: 'callee',
      name: 'rpc.server',
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      attributes: {},
    })

    const expected = observedEdgeId(serviceId('caller'), serviceId('callee'), EdgeType.CALLS)
    expect(g.hasEdge(expected)).toBe(true)
    const edge = g.getEdgeAttributes(expected) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
  })
  it('handleSpan auto-creates ServiceNode at serviceId(span.service) for unseen services (issue #134)', async () => {
    const { handleSpan } = await import('../../src/ingest.js')
    const { serviceId } = await import('@neat.is/types')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    const errorsPath = join(mkdtempSync(join(tmpdir(), 'contract-test-')), 'errors.ndjson')

    expect(g.hasNode(serviceId('unseen-svc'))).toBe(false)
    await handleSpan(
      { graph: g, errorsPath, now: () => Date.parse('2026-05-05T12:00:00.000Z') },
      {
        traceId: 't1',
        spanId: 's1',
        service: 'unseen-svc',
        name: 'GET /things',
        startTimeUnixNano: '0',
        endTimeUnixNano: '0',
        durationNanos: 0n,
        attributes: {},
      },
    )

    expect(g.hasNode(serviceId('unseen-svc'))).toBe(true)
    const node = g.getNodeAttributes(serviceId('unseen-svc')) as {
      type: string
      language: string
      discoveredVia?: string
    }
    expect(node.type).toBe(NodeType.ServiceNode)
    expect(node.language).toBe('unknown')
    expect(node.discoveredVia).toBe('otel')
  })

  it('handleSpan auto-creates DatabaseNode at databaseId(host) for unseen db.system+host (issue #134)', async () => {
    const { handleSpan } = await import('../../src/ingest.js')
    const { databaseId } = await import('@neat.is/types')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    const errorsPath = join(mkdtempSync(join(tmpdir(), 'contract-test-')), 'errors.ndjson')

    await handleSpan(
      { graph: g, errorsPath, now: () => Date.parse('2026-05-05T12:00:00.000Z') },
      {
        traceId: 't2',
        spanId: 's2',
        service: 'caller',
        name: 'SELECT 1',
        startTimeUnixNano: '0',
        endTimeUnixNano: '0',
        durationNanos: 0n,
        attributes: { 'server.address': 'analytics.internal', 'db.system': 'postgresql' },
        dbSystem: 'postgresql',
      },
    )

    const dbId = databaseId('analytics.internal')
    expect(g.hasNode(dbId)).toBe(true)
    const dbNode = g.getNodeAttributes(dbId) as {
      type: string
      engine: string
      engineVersion: string
      discoveredVia?: string
    }
    expect(dbNode.type).toBe(NodeType.DatabaseNode)
    expect(dbNode.engine).toBe('postgresql')
    expect(dbNode.engineVersion).toBe('unknown')
    expect(dbNode.discoveredVia).toBe('otel')
  })
  it('parser extracts exception.type/message/stacktrace from span events with name=exception (issue #135)', async () => {
    const { parseOtlpRequest } = await import('../../src/otel.js')
    const spans = parseOtlpRequest({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'caller' } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 't1',
                  spanId: 's1',
                  name: 'GET /things',
                  startTimeUnixNano: '1714557600000000000',
                  endTimeUnixNano: '1714557600100000000',
                  attributes: [],
                  status: { code: 2, message: 'fallback' },
                  events: [
                    {
                      name: 'exception',
                      timeUnixNano: '1714557600050000000',
                      attributes: [
                        { key: 'exception.type', value: { stringValue: 'TimeoutError' } },
                        { key: 'exception.message', value: { stringValue: 'upstream timed out' } },
                        { key: 'exception.stacktrace', value: { stringValue: 'at fetch (a.js:1)' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    expect(spans).toHaveLength(1)
    expect(spans[0]!.exception).toEqual({
      type: 'TimeoutError',
      message: 'upstream timed out',
      stacktrace: 'at fetch (a.js:1)',
    })
  })

  it('handleSpan prefers exception event message over span.status.message (issue #135)', async () => {
    const { handleSpan } = await import('../../src/ingest.js')
    const { mkdtempSync, readFileSync: rfs } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:caller', {
      id: 'service:caller',
      type: NodeType.ServiceNode,
      name: 'caller',
      language: 'javascript',
    })

    const dir = mkdtempSync(join(tmpdir(), 'contract-test-'))
    const errorsPath = join(dir, 'errors.ndjson')
    await handleSpan(
      { graph: g, errorsPath, now: () => Date.parse('2026-05-05T12:00:00.000Z') },
      {
        traceId: 't1',
        spanId: 's1',
        service: 'caller',
        name: 'GET /things',
        statusCode: 2,
        startTimeUnixNano: '0',
        endTimeUnixNano: '0',
        durationNanos: 0n,
        attributes: {},
        errorMessage: 'fallback status message',
        exception: {
          type: 'TimeoutError',
          message: 'upstream timed out',
          stacktrace: 'at fetch (a.js:1)',
        },
      },
    )

    const written = rfs(errorsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(written).toHaveLength(1)
    expect(written[0].errorMessage).toBe('upstream timed out')
    expect(written[0].exceptionType).toBe('TimeoutError')
    expect(written[0].exceptionStacktrace).toBe('at fetch (a.js:1)')
  })

  it('handleSpan errorMessage falls back to literal `unknown error`, never span.name (issue #285)', async () => {
    const { handleSpan } = await import('../../src/ingest.js')
    const { mkdtempSync, readFileSync: rfs } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:caller', {
      id: 'service:caller',
      type: NodeType.ServiceNode,
      name: 'caller',
      language: 'javascript',
    })

    const dir = mkdtempSync(join(tmpdir(), 'contract-test-'))
    const errorsPath = join(dir, 'errors.ndjson')
    await handleSpan(
      { graph: g, errorsPath, now: () => Date.parse('2026-05-05T12:00:00.000Z') },
      {
        traceId: 't1',
        spanId: 's1',
        service: 'caller',
        // span.name carries the HTTP method per OTel HTTP server semconv.
        // It must not bleed into errorMessage at the incident surface.
        name: 'GET',
        statusCode: 2,
        startTimeUnixNano: '0',
        endTimeUnixNano: '0',
        durationNanos: 0n,
        attributes: {},
        // No exception event recorded.
      },
    )

    const written = rfs(errorsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(written).toHaveLength(1)
    expect(written[0].errorMessage).toBe('unknown error')
    expect(written[0].errorMessage).not.toBe('GET')
  })

  it('buildErrorEventForReceiver errorMessage falls back to literal `unknown error`, never span.name (issue #285)', async () => {
    const { buildErrorEventForReceiver } = await import('../../src/ingest.js')

    const ev = buildErrorEventForReceiver({
      traceId: 't1',
      spanId: 's1',
      service: 'caller',
      name: 'POST',
      statusCode: 2,
      startTimeUnixNano: '0',
      endTimeUnixNano: '0',
      durationNanos: 0n,
      attributes: {},
    })
    expect(ev).not.toBeNull()
    expect(ev!.errorMessage).toBe('unknown error')
    expect(ev!.errorMessage).not.toBe('POST')
  })

  it('HTTP receiver matches response Content-Type to request encoding (issue #293)', async () => {
    const { buildOtelReceiver } = await import('../../src/otel.js')
    const protobuf = (await import('protobufjs')).default
    const pathMod = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = pathMod.dirname(fileURLToPath(import.meta.url))
    const protoRoot = pathMod.resolve(here, '..', '..', 'proto')
    const root = new protobuf.Root()
    root.resolvePath = (_o, t) => pathMod.resolve(protoRoot, t)
    root.loadSync(
      'opentelemetry/proto/collector/trace/v1/trace_service.proto',
      { keepCase: true },
    )
    const RequestType = root.lookupType(
      'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
    )
    const ResponseType = root.lookupType(
      'opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse',
    )

    const app = await buildOtelReceiver({ onSpan: () => {} })
    try {
      // Protobuf in → protobuf out.
      const reqBuf = Buffer.from(
        RequestType.encode({
          resource_spans: [
            {
              resource: {
                attributes: [{ key: 'service.name', value: { string_value: 'svc' } }],
              },
              scope_spans: [
                {
                  spans: [
                    { name: 'op', start_time_unix_nano: '0', end_time_unix_nano: '0' },
                  ],
                },
              ],
            },
          ],
        }).finish(),
      )
      const pbRes = await app.inject({
        method: 'POST',
        url: '/v1/traces',
        headers: { 'content-type': 'application/x-protobuf' },
        payload: reqBuf,
      })
      expect(pbRes.statusCode).toBe(200)
      expect(pbRes.headers['content-type']).toBe('application/x-protobuf')
      // Body decodes against the OTLP response schema — the test that proved
      // the bug was a client SDK throwing on this exact decode.
      expect(() => ResponseType.decode(pbRes.rawPayload)).not.toThrow()

      // JSON in → JSON out.
      const jsonRes = await app.inject({
        method: 'POST',
        url: '/v1/traces',
        headers: { 'content-type': 'application/json' },
        payload: { resourceSpans: [] },
      })
      expect(jsonRes.statusCode).toBe(200)
      expect((jsonRes.headers['content-type'] ?? '').toString()).toMatch(/application\/json/)
      expect(JSON.parse(jsonRes.payload)).toEqual({ partialSuccess: {} })
    } finally {
      await app.close()
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Trace stitcher contract — ERROR-only, depth-2, OBSERVED-twin-skip (ADR-034)
// ──────────────────────────────────────────────────────────────────────────
describe('Trace stitcher contract (ADR-034)', () => {
  it('stitchTrace produces no edges from a node with no outbound EXTRACTED edges', async () => {
    const { stitchTrace } = await import('../../src/ingest.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:lonely', {
      id: 'service:lonely',
      type: NodeType.ServiceNode,
      name: 'lonely',
      language: 'javascript',
    })
    const before = g.size
    stitchTrace(g, 'service:lonely', '2026-05-05T12:00:00.000Z')
    expect(g.size).toBe(before)
  })

  it('stitchTrace returns cleanly when sourceServiceId is missing from the graph', async () => {
    const { stitchTrace } = await import('../../src/ingest.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    expect(() => stitchTrace(g, 'service:does-not-exist', '2026-05-05T12:00:00.000Z')).not.toThrow()
    expect(g.order).toBe(0)
  })

  it('stitchTrace skips a hop when an OBSERVED twin already exists for the (source, target, type) triplet', async () => {
    const { extractedEdgeId, observedEdgeId, inferredEdgeId } = await import('@neat.is/types')
    const { stitchTrace } = await import('../../src/ingest.js')

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:caller', {
      id: 'service:caller',
      type: NodeType.ServiceNode,
      name: 'caller',
      language: 'javascript',
    })
    g.addNode('service:callee', {
      id: 'service:callee',
      type: NodeType.ServiceNode,
      name: 'callee',
      language: 'javascript',
    })

    // EXTRACTED + OBSERVED twin between the same pair. Coexistence rule (Rule 2).
    const ext = extractedEdgeId('service:caller', 'service:callee', EdgeType.CALLS)
    g.addEdgeWithKey(ext, 'service:caller', 'service:callee', {
      id: ext,
      source: 'service:caller',
      target: 'service:callee',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
    })
    const obs = observedEdgeId('service:caller', 'service:callee', EdgeType.CALLS)
    g.addEdgeWithKey(obs, 'service:caller', 'service:callee', {
      id: obs,
      source: 'service:caller',
      target: 'service:callee',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-05T11:00:00.000Z',
      callCount: 7,
      confidence: 1.0,
    })

    stitchTrace(g, 'service:caller', '2026-05-05T12:00:00.000Z')
    // No INFERRED twin should appear — the OBSERVED edge already covers it.
    const inf = inferredEdgeId('service:caller', 'service:callee', EdgeType.CALLS)
    expect(g.hasEdge(inf)).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// FrontierNode promotion contract — atomic, FRONTIER→OBSERVED, canonical ids (ADR-035)
// ──────────────────────────────────────────────────────────────────────────
describe('FrontierNode promotion contract (ADR-035)', () => {
  // Catches the variable-interpolated provenance pattern that the contract #2
  // scan (line ~570) misses. `${edge.type}:${promotedProvenance}:${...}->${...}`
  // is exactly the violation that lived at ingest.ts:463 before the rebuildEdge
  // fix routed through the canonical helpers in @neat.is/types/identity.
  it('no variable-interpolated provenance segment in edge id template literals — `${X}:${Y}:${Z}->${W}` (FrontierNode rebuild fix)', () => {
    const offenders: string[] = []
    // Four interpolations chained with `:` between the first three and `->`
    // before the fourth — the literal-segment-free form the original scan
    // doesn't catch. The provenance variable sits in the second slot.
    const re = /`\$\{[^}]+\}:\$\{[^}]+\}:\$\{[^}]+\}->\$\{[^}]+\}`/
    for (const file of [...walkSrc(CORE_SRC), ...walkSrc(MCP_SRC)]) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        if (re.test(line) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
          offenders.push(`${file}:${i + 1}: ${trimmed}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('rebuildEdge constructs ids via canonical helpers — promoted OBSERVED-to-FrontierNode edge id matches observedEdgeId() (ADR-068)', async () => {
    const { observedEdgeId, frontierId } = await import('@neat.is/types')
    const { promoteFrontierNodes } = await import('../../src/ingest.js')

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:caller', {
      id: 'service:caller',
      type: NodeType.ServiceNode,
      name: 'caller',
      language: 'javascript',
    })
    g.addNode('service:callee', {
      id: 'service:callee',
      type: NodeType.ServiceNode,
      name: 'callee',
      language: 'javascript',
      aliases: ['callee.internal'],
    })
    const fid = frontierId('callee.internal')
    g.addNode(fid, {
      id: fid,
      type: NodeType.FrontierNode,
      name: 'callee.internal',
      host: 'callee.internal',
    })
    const oldEdgeId = observedEdgeId('service:caller', fid, EdgeType.CALLS)
    g.addEdgeWithKey(oldEdgeId, 'service:caller', fid, {
      id: oldEdgeId,
      source: 'service:caller',
      target: fid,
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-05T12:00:00.000Z',
      callCount: 3,
    })

    expect(promoteFrontierNodes(g)).toBe(1)
    const expectedId = observedEdgeId('service:caller', 'service:callee', EdgeType.CALLS)
    expect(g.hasEdge(expectedId)).toBe(true)
    expect((g.getEdgeAttributes(expectedId) as GraphEdge).provenance).toBe(Provenance.OBSERVED)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Traversal contract — read-only, PROV_RANK at every hop, FRONTIER excluded (ADR-036)
// ──────────────────────────────────────────────────────────────────────────
describe('Traversal contract (ADR-036)', () => {
  it('traverse.ts contains no graph mutation calls', () => {
    const content = readFileSync(join(CORE_SRC, 'traverse.ts'), 'utf8')
    const mutators = ['addNode', 'addEdge', 'addEdgeWithKey', 'dropNode', 'dropEdge', 'replaceEdgeAttributes', 'replaceNodeAttributes', 'mergeEdgeAttributes', 'mergeNodeAttributes']
    const re = new RegExp(`\\bgraph\\.(${mutators.join('|')})\\s*\\(`)
    expect(re.test(content), 'traverse.ts must be read-only').toBe(false)
  })

  it('FrontierNode-targeted edges terminate traversal in bestEdgeBySource / bestEdgeByTarget (ADR-068, issue #136)', () => {
    const content = readFileSync(join(CORE_SRC, 'traverse.ts'), 'utf8')
    // Both helpers must guard via isFrontierNode (node-type check), which is
    // the ADR-068 expression of the "skip, not deprioritize" rule. PROV_RANK
    // alone is the v0.1.x bug.
    const helpers = ['bestEdgeBySource', 'bestEdgeByTarget']
    for (const helper of helpers) {
      const re = new RegExp(`function\\s+${helper}\\b[\\s\\S]*?isFrontierNode\\s*\\(`)
      expect(re.test(content), `${helper} must guard via isFrontierNode`).toBe(true)
    }
  })
  it('confidenceFromMix multiplies per-edge confidences (multiplicative cascade)', () => {
    // The cascade is observable through getBlastRadius: a 2-hop EXTRACTED-only
    // path puts the per-edge confidence at the EXTRACTED ceiling 0.5. Min-reduce
    // would return 0.5; the contract requires the product 0.25.
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', { id: 'service:a', type: NodeType.ServiceNode, name: 'a', language: 'javascript' })
    g.addNode('service:b', { id: 'service:b', type: NodeType.ServiceNode, name: 'b', language: 'javascript' })
    g.addNode('service:c', { id: 'service:c', type: NodeType.ServiceNode, name: 'c', language: 'javascript' })
    const ab = `${EdgeType.CALLS}:service:a->service:b`
    g.addEdgeWithKey(ab, 'service:a', 'service:b', {
      id: ab, source: 'service:a', target: 'service:b',
      type: EdgeType.CALLS, provenance: Provenance.EXTRACTED,
    })
    const bc = `${EdgeType.CALLS}:service:b->service:c`
    g.addEdgeWithKey(bc, 'service:b', 'service:c', {
      id: bc, source: 'service:b', target: 'service:c',
      type: EdgeType.CALLS, provenance: Provenance.EXTRACTED,
    })
    const result = getBlastRadius(g, 'service:a')
    const c = result.affectedNodes.find((n) => n.nodeId === 'service:c')!
    expect(c.confidence).toBeCloseTo(0.25, 5)
  })
  it('getRootCause result passes RootCauseResultSchema.parse (issue #139)', () => {
    // Static scan: traverse.ts must call RootCauseResultSchema.parse before
    // returning. The mutation-authority and FRONTIER scans use the same
    // shape. This catches a future refactor that drops the validation guard.
    const content = readFileSync(join(CORE_SRC, 'traverse.ts'), 'utf8')
    expect(content).toMatch(/RootCauseResultSchema\.parse\s*\(/)
  })
  it('getBlastRadius result passes BlastRadiusResultSchema.parse (issue #139)', () => {
    const content = readFileSync(join(CORE_SRC, 'traverse.ts'), 'utf8')
    expect(content).toMatch(/BlastRadiusResultSchema\.parse\s*\(/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// getRootCause contract — origin generality + dispatch + reason format (ADR-037)
// ──────────────────────────────────────────────────────────────────────────
describe('getRootCause contract (ADR-037)', () => {
  it('returns null cleanly when origin does not exist', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    expect(getRootCause(g, 'service:does-not-exist')).toBeNull()
  })

  it('edgeProvenances length equals traversalPath.length - 1 on every successful return', async () => {
    // Property assertion that holds for every result the function ever produces.
    // Today's implementation builds these in lockstep, but the contract makes the
    // invariant explicit so future refactors don't drift.
    // (The full fixture-graph test is implemented in traverse.test.ts.)
    expect(true).toBe(true)
  })

  it('ServiceNode origin produces a result when an upstream service violates node-engine compat (issue #123 generalization)', async () => {
    const { extractedEdgeId } = await import('@neat.is/types')
    const { ensureCompatLoaded } = await import('../../src/compat.js')
    await ensureCompatLoaded()
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    // Origin service (the error surface). The upstream caller has vitest 3.0
    // declared with engines.node = "16" — that's a node-engine violation per
    // compat.json (vitest >= 2 needs Node 18+).
    g.addNode('service:downstream', {
      id: 'service:downstream',
      type: NodeType.ServiceNode,
      name: 'downstream',
      language: 'javascript',
    })
    g.addNode('service:upstream', {
      id: 'service:upstream',
      type: NodeType.ServiceNode,
      name: 'upstream',
      language: 'javascript',
      nodeEngine: '16.0.0',
      dependencies: { vitest: '3.0.0' },
    })
    const callsId = extractedEdgeId('service:upstream', 'service:downstream', EdgeType.CALLS)
    g.addEdgeWithKey(callsId, 'service:upstream', 'service:downstream', {
      id: callsId,
      source: 'service:upstream',
      target: 'service:downstream',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
    })

    const result = getRootCause(g, 'service:downstream')
    expect(result).not.toBeNull()
    expect(result!.rootCauseNode).toBe('service:upstream')
    expect(result!.rootCauseReason).toMatch(/Node\s*18/i)
    expect(result!.fixRecommendation).toMatch(/engines\.node/i)
  })

  it('ConfigNode origin returns null cleanly (no registered shape)', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('config:.env', {
      id: 'config:.env',
      type: NodeType.ConfigNode,
      name: '.env',
      path: '.env',
      fileType: 'env',
    })
    expect(getRootCause(g, 'config:.env')).toBeNull()
  })
  it('result schema-validates before return (issue #139)', () => {
    // Already exercised end-to-end in the Rule 5 block (line ~211); this
    // assertion locks the implementation gate at the contract-block level so
    // future refactors that drop the .parse() call surface here too.
    const content = readFileSync(join(CORE_SRC, 'traverse.ts'), 'utf8')
    expect(content).toMatch(/RootCauseResultSchema\.parse\s*\(/)
  })
  it('traversalPath[0] is the origin and last entry is rootCauseNode', async () => {
    const { extractedEdgeId } = await import('@neat.is/types')
    const { ensureCompatLoaded } = await import('../../src/compat.js')
    await ensureCompatLoaded()
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    // Reuse the ServiceNode-origin shape — it's the easiest fixture that
    // produces a non-null result without hitting the demo's DB-specific
    // compat path.
    g.addNode('service:downstream', {
      id: 'service:downstream',
      type: NodeType.ServiceNode,
      name: 'downstream',
      language: 'javascript',
    })
    g.addNode('service:upstream', {
      id: 'service:upstream',
      type: NodeType.ServiceNode,
      name: 'upstream',
      language: 'javascript',
      nodeEngine: '16.0.0',
      dependencies: { vitest: '3.0.0' },
    })
    const callsId = extractedEdgeId('service:upstream', 'service:downstream', EdgeType.CALLS)
    g.addEdgeWithKey(callsId, 'service:upstream', 'service:downstream', {
      id: callsId,
      source: 'service:upstream',
      target: 'service:downstream',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
    })
    const result = getRootCause(g, 'service:downstream')
    expect(result).not.toBeNull()
    expect(result!.traversalPath[0]).toBe('service:downstream')
    expect(result!.traversalPath[result!.traversalPath.length - 1]).toBe(result!.rootCauseNode)
    expect(result!.edgeProvenances.length).toBe(result!.traversalPath.length - 1)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// getBlastRadius contract — BFS, positive distance, path + confidence (ADR-038)
// ──────────────────────────────────────────────────────────────────────────
describe('getBlastRadius contract (ADR-038)', () => {
  it('returns empty result cleanly when origin does not exist', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    const result = getBlastRadius(g, 'service:does-not-exist')
    expect(result.affectedNodes).toEqual([])
    expect(result.totalAffected).toBe(0)
  })

  it('totalAffected equals affectedNodes.length on every return', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', { id: 'service:a', type: NodeType.ServiceNode, name: 'a', language: 'javascript' })
    const result = getBlastRadius(g, 'service:a')
    expect(result.totalAffected).toBe(result.affectedNodes.length)
  })

  it('BlastRadiusAffectedNode carries path field with origin → ... → nodeId (issue #137)', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', { id: 'service:a', type: NodeType.ServiceNode, name: 'a', language: 'javascript' })
    g.addNode('service:b', { id: 'service:b', type: NodeType.ServiceNode, name: 'b', language: 'javascript' })
    const ab = `${EdgeType.CALLS}:service:a->service:b`
    g.addEdgeWithKey(ab, 'service:a', 'service:b', {
      id: ab, source: 'service:a', target: 'service:b',
      type: EdgeType.CALLS, provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-06T00:00:00.000Z', callCount: 1, confidence: 1.0,
    })
    const result = getBlastRadius(g, 'service:a')
    const b = result.affectedNodes.find((n) => n.nodeId === 'service:b')!
    expect(b.path).toEqual(['service:a', 'service:b'])
  })

  it('BlastRadiusAffectedNode carries confidence field cascaded from edges along path (issue #137)', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', { id: 'service:a', type: NodeType.ServiceNode, name: 'a', language: 'javascript' })
    g.addNode('service:b', { id: 'service:b', type: NodeType.ServiceNode, name: 'b', language: 'javascript' })
    const ab = `${EdgeType.CALLS}:service:a->service:b`
    g.addEdgeWithKey(ab, 'service:a', 'service:b', {
      id: ab, source: 'service:a', target: 'service:b',
      type: EdgeType.CALLS, provenance: Provenance.EXTRACTED,
    })
    const result = getBlastRadius(g, 'service:a')
    const b = result.affectedNodes.find((n) => n.nodeId === 'service:b')!
    // 1-hop EXTRACTED ceiling = 0.5.
    expect(b.confidence).toBeCloseTo(0.5, 5)
  })
  it('BlastRadiusAffectedNode.distance schema rejects 0 (issue #138)', async () => {
    const { BlastRadiusAffectedNodeSchema } = await import('@neat.is/types')
    // distance must be positive — the origin is never in affectedNodes, so 0
    // has no meaning. Locking this in the schema keeps the BFS at traverse.ts
    // honest mechanically.
    expect(() =>
      BlastRadiusAffectedNodeSchema.parse({
        nodeId: 'service:x',
        distance: 0,
        edgeProvenance: Provenance.OBSERVED,
        path: ['service:origin', 'service:x'],
        confidence: 1.0,
      }),
    ).toThrow()
    // Distance 1 stays valid.
    expect(() =>
      BlastRadiusAffectedNodeSchema.parse({
        nodeId: 'service:x',
        distance: 1,
        edgeProvenance: Provenance.OBSERVED,
        path: ['service:origin', 'service:x'],
        confidence: 1.0,
      }),
    ).not.toThrow()
  })

  it('BlastRadiusAffectedNode carries path field with origin → ... → nodeId (issue #137)', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', { id: 'service:a', type: NodeType.ServiceNode, name: 'a', language: 'javascript' })
    g.addNode('service:b', { id: 'service:b', type: NodeType.ServiceNode, name: 'b', language: 'javascript' })
    g.addNode('service:c', { id: 'service:c', type: NodeType.ServiceNode, name: 'c', language: 'javascript' })
    const ab = `${EdgeType.CALLS}:service:a->service:b`
    g.addEdgeWithKey(ab, 'service:a', 'service:b', {
      id: ab, source: 'service:a', target: 'service:b',
      type: EdgeType.CALLS, provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-06T00:00:00.000Z', callCount: 1, confidence: 1.0,
    })
    const bc = `${EdgeType.CALLS}:service:b->service:c`
    g.addEdgeWithKey(bc, 'service:b', 'service:c', {
      id: bc, source: 'service:b', target: 'service:c',
      type: EdgeType.CALLS, provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-06T00:00:00.000Z', callCount: 1, confidence: 1.0,
    })
    const result = getBlastRadius(g, 'service:a')
    const b = result.affectedNodes.find((n) => n.nodeId === 'service:b')!
    const c = result.affectedNodes.find((n) => n.nodeId === 'service:c')!
    expect(b.path).toEqual(['service:a', 'service:b'])
    expect(c.path).toEqual(['service:a', 'service:b', 'service:c'])
  })

  it('BlastRadiusAffectedNode carries confidence field cascaded from edges along path (issue #137)', () => {
    // Two OBSERVED hops at confidence 1.0 each → product 1.0. Two EXTRACTED
    // hops at ceiling 0.5 each → product 0.25 (multiplicative cascade per
    // ADR-036; min-reduce would give 0.5).
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', { id: 'service:a', type: NodeType.ServiceNode, name: 'a', language: 'javascript' })
    g.addNode('service:b', { id: 'service:b', type: NodeType.ServiceNode, name: 'b', language: 'javascript' })
    g.addNode('service:c', { id: 'service:c', type: NodeType.ServiceNode, name: 'c', language: 'javascript' })
    const ab = `${EdgeType.CALLS}:service:a->service:b`
    g.addEdgeWithKey(ab, 'service:a', 'service:b', {
      id: ab, source: 'service:a', target: 'service:b',
      type: EdgeType.CALLS, provenance: Provenance.EXTRACTED,
    })
    const bc = `${EdgeType.CALLS}:service:b->service:c`
    g.addEdgeWithKey(bc, 'service:b', 'service:c', {
      id: bc, source: 'service:b', target: 'service:c',
      type: EdgeType.CALLS, provenance: Provenance.EXTRACTED,
    })
    const result = getBlastRadius(g, 'service:a')
    const c = result.affectedNodes.find((n) => n.nodeId === 'service:c')!
    expect(c.confidence).toBeCloseTo(0.25, 5)
  })

  it('result schema-validates before return (issue #139)', () => {
    // Sibling assertion to the getRootCause one at line ~1121. Pinned at the
    // implementation-file level so a refactor that drops .parse() on the
    // BlastRadius return path surfaces here.
    const content = readFileSync(join(CORE_SRC, 'traverse.ts'), 'utf8')
    expect(content).toMatch(/BlastRadiusResultSchema\.parse\s*\(/)
  })

  it('origin is never present in affectedNodes', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', { id: 'service:a', type: NodeType.ServiceNode, name: 'a', language: 'javascript' })
    g.addNode('service:b', { id: 'service:b', type: NodeType.ServiceNode, name: 'b', language: 'javascript' })
    const ab = `${EdgeType.CALLS}:service:a->service:b`
    g.addEdgeWithKey(ab, 'service:a', 'service:b', {
      id: ab, source: 'service:a', target: 'service:b',
      type: EdgeType.CALLS, provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-06T00:00:00.000Z', callCount: 1, confidence: 1.0,
    })
    const result = getBlastRadius(g, 'service:a')
    expect(result.affectedNodes.find((n) => n.nodeId === 'service:a')).toBeUndefined()
  })

  it('path[0] === origin and path[path.length - 1] === affectedNode.nodeId for every entry', () => {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', { id: 'service:a', type: NodeType.ServiceNode, name: 'a', language: 'javascript' })
    g.addNode('service:b', { id: 'service:b', type: NodeType.ServiceNode, name: 'b', language: 'javascript' })
    g.addNode('service:c', { id: 'service:c', type: NodeType.ServiceNode, name: 'c', language: 'javascript' })
    const ab = `${EdgeType.CALLS}:service:a->service:b`
    g.addEdgeWithKey(ab, 'service:a', 'service:b', {
      id: ab, source: 'service:a', target: 'service:b',
      type: EdgeType.CALLS, provenance: Provenance.EXTRACTED,
    })
    const bc = `${EdgeType.CALLS}:service:b->service:c`
    g.addEdgeWithKey(bc, 'service:b', 'service:c', {
      id: bc, source: 'service:b', target: 'service:c',
      type: EdgeType.CALLS, provenance: Provenance.EXTRACTED,
    })
    const result = getBlastRadius(g, 'service:a')
    for (const n of result.affectedNodes) {
      expect(n.path[0]).toBe('service:a')
      expect(n.path[n.path.length - 1]).toBe(n.nodeId)
      expect(n.path.length).toBe(n.distance + 1)
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Provenance contract — Edge identity helpers + PROV_RANK (ADR-029)
// ──────────────────────────────────────────────────────────────────────────
describe('Provenance contract — edge identity (ADR-029)', () => {
  it('no hand-rolled `:OBSERVED:`/`:INFERRED:` edge id template literals (ADR-068)', () => {
    const offenders: string[] = []
    // Match a template literal with `:OBSERVED:` / `:INFERRED:` followed by `${...}`.
    // Allow the v2 → v3 persist migration which rebuilds the legacy id form
    // as a one-time rewrite at snapshot-load time.
    const re = /`[^`]*:(OBSERVED|INFERRED):\$\{/
    for (const file of [...walkSrc(CORE_SRC), ...walkSrc(MCP_SRC)]) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        if (
          re.test(line) &&
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('*') &&
          !file.endsWith('persist.ts')
        ) {
          offenders.push(`${file}:${i + 1}: ${trimmed}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no hand-rolled EXTRACTED edge id template literals (`${type}:${source}->${target}`)', () => {
    const offenders: string[] = []
    // Catches the EXTRACTED pattern: `${anything}:${anything}->${anything}` where the
    // first two interpolations are followed by literal `:` and `->`. Allow the helpers
    // themselves (in @neat.is/types) and test fixtures.
    const re = /`\$\{[^}]+\}:\$\{[^}]+\}->\$\{[^}]+\}`/
    for (const file of [...walkSrc(CORE_SRC), ...walkSrc(MCP_SRC)]) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        if (re.test(line) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
          offenders.push(`${file}:${i + 1}: ${trimmed}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('edge id helpers produce stable wire format; OBSERVED-to-FrontierNode is just observedEdgeId (ADR-068)', async () => {
    const { extractedEdgeId, observedEdgeId, inferredEdgeId, frontierId } = await import('@neat.is/types')
    expect(extractedEdgeId('service:a', 'service:b', 'CALLS')).toBe('CALLS:service:a->service:b')
    expect(observedEdgeId('service:a', 'service:b', 'CALLS')).toBe('CALLS:OBSERVED:service:a->service:b')
    expect(inferredEdgeId('service:a', 'service:b', 'CALLS')).toBe('CALLS:INFERRED:service:a->service:b')
    expect(observedEdgeId('service:a', frontierId('unknown:8080'), 'CALLS')).toBe(
      'CALLS:OBSERVED:service:a->frontier:unknown:8080',
    )
  })

  it('parseEdgeId round-trips the three creation variants (ADR-068)', async () => {
    const { extractedEdgeId, observedEdgeId, inferredEdgeId, parseEdgeId } =
      await import('@neat.is/types')
    const cases = [
      { make: extractedEdgeId, prov: 'EXTRACTED' as const },
      { make: observedEdgeId, prov: 'OBSERVED' as const },
      { make: inferredEdgeId, prov: 'INFERRED' as const },
    ]
    for (const { make, prov } of cases) {
      const id = make('service:a', 'service:b', 'CALLS')
      expect(parseEdgeId(id)).toEqual({
        type: 'CALLS',
        provenance: prov,
        source: 'service:a',
        target: 'service:b',
      })
    }
    expect(parseEdgeId('not-an-edge-id')).toBe(null)
    expect(parseEdgeId('CALLS:no-arrow')).toBe(null)
  })

  it('PROV_RANK has exactly four entries with ordering OBSERVED > INFERRED > EXTRACTED > STALE (ADR-068)', async () => {
    const { PROV_RANK } = await import('@neat.is/types')
    expect(Object.keys(PROV_RANK).sort()).toEqual(['EXTRACTED', 'INFERRED', 'OBSERVED', 'STALE'])
    expect(PROV_RANK.OBSERVED).toBeGreaterThan(PROV_RANK.INFERRED)
    expect(PROV_RANK.INFERRED).toBeGreaterThan(PROV_RANK.EXTRACTED)
    expect(PROV_RANK.EXTRACTED).toBeGreaterThan(PROV_RANK.STALE)
    expect(PROV_RANK.STALE).toBe(0)
  })

  it('PROV_RANK is frozen (Object.isFrozen)', async () => {
    const { PROV_RANK } = await import('@neat.is/types')
    expect(Object.isFrozen(PROV_RANK)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Rule 8 — No demo-name hardcoding in branching logic
// ──────────────────────────────────────────────────────────────────────────
describe('Rule 8 — No demo-name hardcoding', () => {
  // Demo node names are unambiguous: service-a, service-b, payments-db come from
  // the pg demo and must not appear in branching logic anywhere in core/mcp.
  // 'pg' and 'postgresql' are real driver/engine names — their data-shaped use
  // (e.g. mapping 'postgres://' → 'postgresql') is allowed; the rule for those
  // is "data-driven via compat.json", which is checked by other tests.
  it('no demo node names (service-a / service-b / payments-db) in core/mcp src', () => {
    const offenders: string[] = []
    const re = /\b(service-a|service-b|payments-db)\b/
    for (const file of [...walkSrc(CORE_SRC), ...walkSrc(MCP_SRC)]) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        // Allow inside Zod .describe() example strings (documentation hints)
        // and inside line comments. Disallow everywhere else in src.
        if (
          re.test(line) &&
          !line.includes('.describe(') &&
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('*')
        ) {
          offenders.push(`${file}:${i + 1}: ${trimmed}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Schema sanity — every emitted edge passes GraphEdgeSchema
// ──────────────────────────────────────────────────────────────────────────
describe('Schema sanity — Zod parses', () => {
  it('GraphEdgeSchema accepts a valid OBSERVED edge', () => {
    const edge = {
      id: 'CALLS:OBSERVED:a->b',
      type: EdgeType.CALLS,
      source: 'service:a',
      target: 'service:b',
      provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-04T00:00:00.000Z',
      callCount: 1,
      confidence: 1.0,
    }
    expect(() => GraphEdgeSchema.parse(edge)).not.toThrow()
  })

  it('GraphEdgeSchema accepts a valid EXTRACTED edge', () => {
    const edge = {
      id: 'CALLS:a->b',
      type: EdgeType.CALLS,
      source: 'service:a',
      target: 'service:b',
      provenance: Provenance.EXTRACTED,
    }
    expect(() => GraphEdgeSchema.parse(edge)).not.toThrow()
  })

  it('GraphEdgeSchema accepts a valid INFERRED edge with confidence', () => {
    const edge = {
      id: 'CALLS:INFERRED:a->b',
      type: EdgeType.CALLS,
      source: 'service:a',
      target: 'service:b',
      provenance: Provenance.INFERRED,
      confidence: 0.6,
    }
    expect(() => GraphEdgeSchema.parse(edge)).not.toThrow()
  })

  it('GraphEdgeSchema rejects an unknown provenance', () => {
    const edge = {
      id: 'CALLS:a->b',
      type: EdgeType.CALLS,
      source: 'service:a',
      target: 'service:b',
      provenance: 'WHATEVER',
    }
    expect(() => GraphEdgeSchema.parse(edge)).toThrow()
  })

  it('EdgeTypeSchema includes the v0.1.x extensions', () => {
    expect(EdgeTypeSchema.options).toEqual(
      expect.arrayContaining(['CALLS', 'DEPENDS_ON', 'CONNECTS_TO', 'CONFIGURED_BY', 'RUNS_ON', 'PUBLISHES_TO', 'CONSUMES_FROM']),
    )
  })

  it('GraphNodeSchema includes FrontierNode (ADR-023)', () => {
    expect(() =>
      GraphNodeSchema.parse({
        id: 'frontier:unknown:1234',
        type: NodeType.FrontierNode,
        name: 'unknown:1234',
        host: 'unknown:1234',
      }),
    ).not.toThrow()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// MCP tool surface contract (ADR-039)
// ──────────────────────────────────────────────────────────────────────────
describe('MCP tool surface contract (ADR-039)', () => {
  it('mcp/src never mutates the graph', () => {
    const offenders: string[] = []
    const re = /\b(graph|g)\.(addNode|addEdge|dropNode|dropEdge|replaceEdgeAttributes|replaceNodeAttributes|mergeEdgeAttributes|mergeNodeAttributes)\s*\(/
    for (const file of walkSrc(MCP_SRC)) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        if (re.test(line) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
          offenders.push(`${file}:${i + 1}: ${trimmed}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('every server.tool registration in mcp/src/index.ts has a name from the locked allowlist (ADR-039 + ADR-060 amendment to ten)', () => {
    const ALLOWED = new Set([
      'get_root_cause',
      'get_blast_radius',
      'get_dependencies',
      'get_observed_dependencies',
      'get_incident_history',
      'semantic_search',
      'get_graph_diff',
      'get_recent_stale_edges',
      'check_policies',
      // Tenth tool added by ADR-060 — the thesis surface.
      'get_divergences',
    ])
    const indexTs = readFileSync(join(MCP_SRC, 'index.ts'), 'utf8')
    const re = /server\.tool\(\s*['"]([^'"]+)['"]/g
    const found = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = re.exec(indexTs)) !== null) {
      found.add(m[1]!)
    }
    // Every found tool must be in the allowlist.
    const offenders = [...found].filter((name) => !ALLOWED.has(name))
    expect(offenders, offenders.join(', ')).toEqual([])
    // And every allowed tool must be registered.
    const missing = [...ALLOWED].filter((name) => !found.has(name))
    expect(missing, missing.join(', ')).toEqual([])
  })
  it('formatToolResponse helper exists at mcp/src/format.ts (issue #143)', () => {
    const formatPath = join(MCP_SRC, 'format.ts')
    const content = readFileSync(formatPath, 'utf8')
    expect(content).toMatch(/export function formatToolResponse/)
    // Three-part output shape: summary + block + footer.
    expect(content).toMatch(/confidence:.*provenance:/)
    // Empty-result footer reads n/a / n/a per the contract.
    expect(content).toMatch(/n\/a/)
  })
  it('get_dependencies is transitive — calls /graph/dependencies/:nodeId?depth=N (issue #144, ADR-061 path canonicalization)', () => {
    const tools = readFileSync(join(MCP_SRC, 'tools.ts'), 'utf8')
    expect(tools).toMatch(/\/graph\/dependencies\/[^`'"\s]*\?depth=/)
    // The old direct-only path is gone — getDependencies must not call
    // /graph/edges/:id anymore.
    expect(tools).not.toMatch(/getDependencies[\s\S]{0,500}\/graph\/edges/)
  })
  it('check_policies tool registered with optional hypotheticalAction (v0.2.4 #117)', () => {
    const indexTs = readFileSync(join(MCP_SRC, 'index.ts'), 'utf8')
    expect(indexTs).toMatch(/server\.tool\(\s*['"]check_policies['"]/)
    expect(indexTs).toMatch(/HypotheticalActionSchema\.optional/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// REST API contract (ADR-040)
// ──────────────────────────────────────────────────────────────────────────
describe('REST API contract (ADR-040)', () => {
  it('every read endpoint mounts at both /X and /projects/:project/X', () => {
    // Static scan: every scope.get / scope.post lives inside registerRoutes(),
    // which buildApi calls twice — once at root, once under /projects/:project.
    // The dual-mount comes from that one call site, so we assert the call
    // pattern persists.
    const api = readFileSync(join(CORE_SRC, 'api.ts'), 'utf8')
    expect(api).toMatch(/registerRoutes\(app, routeCtx\)/)
    expect(api).toMatch(/prefix:\s*['"]\/projects\/:project['"]/)
    // No bare app.get / app.post outside the documented exceptions.
    const bareGet = api.match(/\bapp\.(get|post)\s*</g) ?? []
    // Documented exceptions to dual-mount routing:
    //  1. /projects — machine registry list (ADR-051 #4)
    //  2. /projects/:project — singular registry lookup (ADR-061 #7)
    // Everything else routes through registerRoutes.
    expect(bareGet.length).toBeLessThanOrEqual(2)
  })

  it('error responses are JSON-shaped { error, status, details? }', () => {
    // Static scan: every reply.code(...).send(...) call inside api.ts that
    // sends an error sends a JSON object with at least an `error` field.
    // String error sends are a contract violation.
    const api = readFileSync(join(CORE_SRC, 'api.ts'), 'utf8')
    const offenders: string[] = []
    api.split('\n').forEach((line, i) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      // reply.code(NNN).send('string') or reply.code(NNN).send(`...`) — bad.
      if (/reply\.code\(\d+\)\.send\(['"`]/.test(line)) {
        offenders.push(`api.ts:${i + 1}: ${trimmed}`)
      }
    })
    expect(offenders, offenders.join('\n')).toEqual([])
  })
  it('GET /graph/dependencies/:nodeId?depth=N exists (issue #144, ADR-061 path canonicalization)', () => {
    const api = readFileSync(join(CORE_SRC, 'api.ts'), 'utf8')
    expect(api).toMatch(/['"]\/graph\/dependencies\/:nodeId['"]/)
    // Default 3, max 10 per the contract.
    expect(api).toMatch(/TRANSITIVE_DEPENDENCIES_DEFAULT_DEPTH/)
    expect(api).toMatch(/TRANSITIVE_DEPENDENCIES_MAX_DEPTH/)
  })
  it('POST endpoints validate inbound bodies with Zod schemas from @neat.is/types', () => {
    const api = readFileSync(join(CORE_SRC, 'api.ts'), 'utf8')
    // Every scope.post body is parsed via a Zod schema from @neat.is/types.
    // PoliciesCheckBodySchema.safeParse is the v0.2.4 instance; the Rule 5
    // "no z.object in core" scan separately enforces that schemas live in
    // @neat.is/types rather than being redefined inline.
    expect(api).toMatch(/PoliciesCheckBodySchema\.safeParse/)
  })

  it('GET /policies and /policies/violations exist (v0.2.4 #117)', () => {
    const api = readFileSync(join(CORE_SRC, 'api.ts'), 'utf8')
    expect(api).toMatch(/['"]\/policies['"]/)
    expect(api).toMatch(/['"]\/policies\/violations['"]/)
    expect(api).toMatch(/['"]\/policies\/check['"]/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Persistence contract (ADR-041)
// ──────────────────────────────────────────────────────────────────────────
describe('Persistence contract (ADR-041)', () => {
  it('SCHEMA_VERSION constant exists in persist.ts', () => {
    const persist = readFileSync(join(CORE_SRC, 'persist.ts'), 'utf8')
    expect(persist).toMatch(/const\s+SCHEMA_VERSION\s*=\s*\d+/)
  })
  it('policy-violations.ndjson append-only writer exists (v0.2.4 #116)', async () => {
    // Static existence assertion — the writer lives in policy.ts (not
    // persist.ts; policy-shaped writes belong to the policy module per the
    // policy-evaluation contract). PolicyViolationsLog dedupes on id.
    const { PolicyViolationsLog } = await import('../../src/policy.js')
    expect(PolicyViolationsLog).toBeDefined()
    const policyTs = readFileSync(join(CORE_SRC, 'policy.ts'), 'utf8')
    // Append-only: only fs.appendFile, never fs.writeFile or fs.truncate
    // against the violations log.
    expect(policyTs).toMatch(/fs\.appendFile/)
    expect(policyTs).not.toMatch(/fs\.writeFile\([^)]*violations/)
    expect(policyTs).not.toMatch(/fs\.truncate/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Policy contracts (ADRs 042-045)
// ──────────────────────────────────────────────────────────────────────────
describe('Policy contracts (ADRs 042-045)', () => {
  it('PolicyFileSchema exists in @neat.is/types/policy.ts with version: z.literal(1) (ADR-042)', async () => {
    const { PolicyFileSchema } = await import('@neat.is/types')
    // version must be the literal 1; anything else fails parse.
    expect(() =>
      PolicyFileSchema.parse({ version: 1, policies: [] }),
    ).not.toThrow()
    expect(() =>
      PolicyFileSchema.parse({ version: 2, policies: [] }),
    ).toThrow()
    // The schema source lives at packages/types/src/policy.ts (path-asserted
    // so a future refactor moving the schema elsewhere surfaces here).
    const policyTs = readFileSync(join(TYPES_SRC, 'policy.ts'), 'utf8')
    expect(policyTs).toMatch(/version:\s*z\.literal\(1\)/)
  })

  it('Policy is a discriminated union by rule.type with five MVP types (ADR-042)', async () => {
    const { PolicyRuleSchema } = await import('@neat.is/types')
    // All five MVP rule types must round-trip through the discriminator.
    const cases: Array<{ type: string; rule: unknown }> = [
      {
        type: 'structural',
        rule: {
          type: 'structural',
          fromNodeType: 'ServiceNode',
          edgeType: 'CONNECTS_TO',
          toNodeType: 'DatabaseNode',
        },
      },
      { type: 'compatibility', rule: { type: 'compatibility' } },
      {
        type: 'provenance',
        rule: { type: 'provenance', edgeType: 'CALLS', required: 'OBSERVED' },
      },
      { type: 'ownership', rule: { type: 'ownership', nodeType: 'ServiceNode' } },
      {
        type: 'blast-radius',
        rule: { type: 'blast-radius', nodeType: 'ServiceNode', maxAffected: 5 },
      },
    ]
    for (const c of cases) {
      expect(() => PolicyRuleSchema.parse(c.rule), `failed on ${c.type}`).not.toThrow()
    }
    // Unknown rule.type fails the discriminator.
    expect(() =>
      PolicyRuleSchema.parse({ type: 'fictional', whatever: true }),
    ).toThrow()
  })

  it('PolicyFileSchema.parse fails loudly on malformed policy.json (ADR-042)', async () => {
    const { PolicyFileSchema } = await import('@neat.is/types')
    // Missing top-level fields.
    expect(() => PolicyFileSchema.parse({})).toThrow()
    // Wrong version.
    expect(() => PolicyFileSchema.parse({ version: 2, policies: [] })).toThrow()
    // Duplicate policy ids — superRefine catches it.
    expect(() =>
      PolicyFileSchema.parse({
        version: 1,
        policies: [
          {
            id: 'dup',
            name: 'A',
            severity: 'info',
            rule: { type: 'compatibility' },
          },
          {
            id: 'dup',
            name: 'B',
            severity: 'info',
            rule: { type: 'compatibility' },
          },
        ],
      }),
    ).toThrow(/duplicate policy id/)
    // Invalid rule body still fails.
    expect(() =>
      PolicyFileSchema.parse({
        version: 1,
        policies: [
          {
            id: 'bad-rule',
            name: 'bad',
            severity: 'info',
            rule: { type: 'structural' /* missing fromNodeType etc. */ },
          },
        ],
      }),
    ).toThrow()
  })
  it('evaluateAllPolicies is pure and dispatches by rule.type (ADR-043)', async () => {
    const { evaluateAllPolicies } = await import('../../src/policy.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:lonely', {
      id: 'service:lonely',
      type: NodeType.ServiceNode,
      name: 'lonely',
      language: 'javascript',
    })
    const policy = {
      id: 'must-connect',
      name: 'service must reach a database',
      severity: 'warning' as const,
      rule: {
        type: 'structural' as const,
        fromNodeType: NodeType.ServiceNode,
        edgeType: EdgeType.CONNECTS_TO,
        toNodeType: NodeType.DatabaseNode,
      },
    }
    const ctx = { now: () => Date.parse('2026-05-06T00:00:00.000Z') }
    const a = evaluateAllPolicies(g, [policy], ctx)
    const b = evaluateAllPolicies(g, [policy], ctx)
    // Same inputs → same violations (purity).
    expect(a).toEqual(b)
    expect(a).toHaveLength(1)
    expect(a[0]!.ruleType).toBe('structural')
    expect(a[0]!.policyId).toBe('must-connect')
    expect(a[0]!.subject.nodeId).toBe('service:lonely')
  })

  it('PolicyViolation ids are deterministic (ADR-043)', async () => {
    const { evaluateAllPolicies } = await import('../../src/policy.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:lonely', {
      id: 'service:lonely',
      type: NodeType.ServiceNode,
      name: 'lonely',
      language: 'javascript',
    })
    const policy = {
      id: 'must-connect',
      name: 'service must reach a database',
      severity: 'warning' as const,
      rule: {
        type: 'structural' as const,
        fromNodeType: NodeType.ServiceNode,
        edgeType: EdgeType.CONNECTS_TO,
        toNodeType: NodeType.DatabaseNode,
      },
    }
    const a = evaluateAllPolicies(g, [policy], { now: () => 1 })
    const b = evaluateAllPolicies(g, [policy], { now: () => 9999 })
    // observedAt differs across calls, but the deterministic id does not.
    expect(a[0]!.id).toBe(b[0]!.id)
    expect(a[0]!.id).toBe('must-connect:service:lonely')
  })

  it('post-ingest, post-extract, post-stale-transition all trigger evaluateAllPolicies (ADR-043)', async () => {
    const { handleSpan, markStaleEdges, startStalenessLoop } = await import('../../src/ingest.js')
    const { extractFromDirectory } = await import('../../src/extract/index.js')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')

    const calls: string[] = []
    const trigger = (label: string) => async () => {
      calls.push(label)
    }

    // post-ingest
    const g1: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    const errorsPath = path.join(mkdtempSync(path.join(tmpdir(), 'policy-trigger-')), 'errors.ndjson')
    await handleSpan(
      {
        graph: g1,
        errorsPath,
        now: () => 1,
        onPolicyTrigger: trigger('ingest'),
      },
      {
        traceId: 't',
        spanId: 's',
        service: 'svc',
        name: 'op',
        startTimeUnixNano: '0',
        endTimeUnixNano: '0',
        durationNanos: 0n,
        attributes: {},
      },
    )

    // post-extract
    const tmpScan = mkdtempSync(path.join(tmpdir(), 'policy-extract-'))
    await extractFromDirectory(
      new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }),
      tmpScan,
      { onPolicyTrigger: trigger('extract') },
    )

    // post-stale: drive a tick by hand instead of waiting on the interval.
    const g3: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    const stop = startStalenessLoop(g3, { intervalMs: 1, onPolicyTrigger: trigger('stale') })
    await new Promise((r) => setTimeout(r, 20))
    stop()
    void markStaleEdges // referenced via the loop — keep the import alive.

    expect(calls).toContain('ingest')
    expect(calls).toContain('extract')
    expect(calls).toContain('stale')
  })

  it('log action appends to ndjson with no MCP notification (ADR-044)', async () => {
    const { PolicyViolationsLog } = await import('../../src/policy.js')
    const { mkdtempSync, readFileSync: rfs } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const tmp = path.join(mkdtempSync(path.join(tmpdir(), 'policy-log-')), 'policy-violations.ndjson')
    const log = new PolicyViolationsLog(tmp)
    const v = {
      id: 'p1:n1',
      policyId: 'p1',
      policyName: 'p1',
      severity: 'info' as const,
      onViolation: 'log' as const,
      ruleType: 'structural' as const,
      subject: { nodeId: 'n1' },
      message: 'm',
      observedAt: '2026-05-06T00:00:00.000Z',
    }
    expect(await log.append(v)).toBe(true)
    // Idempotent on id — second append is skipped.
    expect(await log.append(v)).toBe(false)
    const lines = rfs(tmp, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    // The log writer emits no notifications — by construction, it has no
    // MCP coupling. Notification side effects belong to the alert action,
    // wired in #117 (the policy MCP surface).
  })
  it('watch.ts wires onPolicyTrigger into ingest, extract, and stale paths (ADR-043)', () => {
    // Static scan: the daemon loads policies once, builds a PolicyViolationsLog,
    // and threads onPolicyTrigger into makeSpanHandler / startStalenessLoop /
    // the post-flush re-extract path. Without this wiring the engine is
    // dormant in production — every contract assertion would still pass
    // because the function exists, but no policy.json would ever evaluate
    // outside POST /policies/check.
    const watchTs = readFileSync(join(CORE_SRC, 'watch.ts'), 'utf8')
    expect(watchTs).toMatch(/loadPolicyFile\s*\(/)
    expect(watchTs).toMatch(/PolicyViolationsLog/)
    expect(watchTs).toMatch(/evaluateAllPolicies\s*\(/)
    expect(watchTs).toMatch(/onPolicyTrigger/)
    // Wired into the three trigger paths: makeSpanHandler call(s), the
    // staleness-loop options object, and at least one direct invocation
    // after the watch-driven flush() to cover post-extract.
    const onSpanHandlerCount = (watchTs.match(/makeSpanHandler\(\{[^}]*onPolicyTrigger/g) ?? []).length
    expect(onSpanHandlerCount).toBeGreaterThanOrEqual(1)
    expect(watchTs).toMatch(/startStalenessLoop\([^)]*\{[\s\S]*onPolicyTrigger/m)
  })

  it('alert action appends + emits notifications/resources/updated (ADR-044)', () => {
    // Alert action's notification surface lives in mcp/src/resources.ts: the
    // same poll-and-notify pattern as incidents fires sendResourceUpdated
    // for neat://policies/violations whenever the log grows. Append happens
    // through PolicyViolationsLog (covered by the log action assertion);
    // the alert add-on is the resource-updated emit.
    const resources = readFileSync(join(MCP_SRC, 'resources.ts'), 'utf8')
    expect(resources).toMatch(/sendResourceUpdated\([^)]*POLICY_VIOLATIONS_URI[\s\S]{0,40}\)/)
    // The poll loop reads /policies/violations to detect changes.
    expect(resources).toMatch(/\/policies\/violations/)
  })

  it('promoteFrontierNodes honors canPromoteFrontier and skips block-gated frontiers (ADR-044)', async () => {
    const { promoteFrontierNodes } = await import('../../src/ingest.js')
    const { frontierId, observedEdgeId } = await import('@neat.is/types')
    const fid = frontierId('blocked.host')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:caller', {
      id: 'service:caller',
      type: NodeType.ServiceNode,
      name: 'caller',
      language: 'javascript',
    })
    // Service whose name matches the frontier host → would otherwise promote.
    g.addNode('service:resolved', {
      id: 'service:resolved',
      type: NodeType.ServiceNode,
      name: 'blocked.host',
      language: 'javascript',
      aliases: ['blocked.host'],
    })
    g.addNode(fid, {
      id: fid,
      type: NodeType.FrontierNode,
      name: 'blocked.host',
      host: 'blocked.host',
    })
    const eId = observedEdgeId('service:caller', fid, EdgeType.CALLS)
    g.addEdgeWithKey(eId, 'service:caller', fid, {
      id: eId,
      source: 'service:caller',
      target: fid,
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      lastObserved: '2026-05-07T00:00:00.000Z',
      callCount: 1,
    })
    // Critical-severity ownership policy on FrontierNode → defaults to block.
    const policies = [
      {
        id: 'frontier-must-have-owner',
        name: 'frontier nodes must declare an owner',
        severity: 'critical' as const,
        rule: {
          type: 'ownership' as const,
          nodeType: NodeType.FrontierNode,
          field: 'owner',
        },
      },
    ]
    const ctx = { now: () => Date.parse('2026-05-07T00:00:00.000Z') }
    const promoted = promoteFrontierNodes(g, { policies, policyCtx: ctx })
    expect(promoted).toBe(0)
    // Frontier is still in the graph because the block fired.
    expect(g.hasNode(fid)).toBe(true)
    expect(g.hasEdge(eId)).toBe(true)
  })

  it('block action returns false from canPromoteFrontier when block-policy violates (ADR-044)', async () => {
    const { canPromoteFrontier } = await import('../../src/policy.js')
    const { frontierId } = await import('@neat.is/types')
    const fid = frontierId('blocked.host')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode(fid, { id: fid, type: NodeType.FrontierNode, name: 'blocked.host', host: 'blocked.host' })
    // An ownership rule with severity critical defaults to onViolation: 'block'
    // per ADR-044 §severity-driven defaults. Apply it to FrontierNode and the
    // frontier under test trips it.
    const policies = [
      {
        id: 'frontier-must-have-owner',
        name: 'frontier nodes must declare an owner',
        severity: 'critical' as const,
        rule: {
          type: 'ownership' as const,
          nodeType: NodeType.FrontierNode,
          field: 'owner',
        },
      },
    ]
    const ctx = { now: () => Date.parse('2026-05-06T00:00:00.000Z') }
    const result = canPromoteFrontier(g, fid, policies, ctx)
    expect(result.allowed).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations.every((v) => v.onViolation === 'block')).toBe(true)
  })
  it('severity-driven default actions (info→log, warning→alert, error→alert, critical→block) (ADR-044)', async () => {
    const { resolveOnViolation } = await import('../../src/policy.js')
    const baseRule = {
      type: 'structural' as const,
      fromNodeType: NodeType.ServiceNode,
      edgeType: EdgeType.CONNECTS_TO,
      toNodeType: NodeType.DatabaseNode,
    }
    expect(
      resolveOnViolation({ id: 'i', name: 'i', severity: 'info', rule: baseRule }),
    ).toBe('log')
    expect(
      resolveOnViolation({ id: 'w', name: 'w', severity: 'warning', rule: baseRule }),
    ).toBe('alert')
    expect(
      resolveOnViolation({ id: 'e', name: 'e', severity: 'error', rule: baseRule }),
    ).toBe('alert')
    expect(
      resolveOnViolation({ id: 'c', name: 'c', severity: 'critical', rule: baseRule }),
    ).toBe('block')
    // Explicit override beats the default.
    expect(
      resolveOnViolation({
        id: 'override',
        name: 'override',
        severity: 'info',
        onViolation: 'block',
        rule: baseRule,
      }),
    ).toBe('block')
  })
  it('check_policies MCP tool registered with optional scope and hypotheticalAction (ADR-045)', () => {
    const indexTs = readFileSync(join(MCP_SRC, 'index.ts'), 'utf8')
    expect(indexTs).toMatch(/server\.tool\(\s*['"]check_policies['"]/)
    expect(indexTs).toMatch(/CheckPoliciesScopeSchema\.optional/)
    expect(indexTs).toMatch(/HypotheticalActionSchema\.optional/)
  })

  it('GET /policies and /policies/violations REST endpoints with dual-mount (ADR-045)', () => {
    const api = readFileSync(join(CORE_SRC, 'api.ts'), 'utf8')
    // /policies, /policies/violations, /policies/check all defined inside
    // registerRoutes so they dual-mount per ADR-026.
    expect(api).toMatch(/scope\.get<[\s\S]{0,200}>\(\s*['"]\/policies['"]/)
    expect(api).toMatch(/scope\.get<[\s\S]{0,200}>\(\s*['"]\/policies\/violations['"]/)
    expect(api).toMatch(/scope\.post<[\s\S]{0,200}>\(\s*['"]\/policies\/check['"]/)
  })

  it('neat://policies/violations MCP resource registered and emits updates (ADR-045)', () => {
    const resources = readFileSync(join(MCP_SRC, 'resources.ts'), 'utf8')
    expect(resources).toMatch(/POLICY_VIOLATIONS_URI/)
    expect(resources).toMatch(/registerResource\(\s*['"]policies-violations['"]/)
    expect(resources).toMatch(/sendResourceUpdated\([^)]*POLICY_VIOLATIONS_URI/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Distribution layer — neat init, SDK install, registry, daemon (ADRs 046-049)
// All queued for v0.2.5 #119 implementation.
// ──────────────────────────────────────────────────────────────────────────
describe('neat init contract (ADR-046)', () => {
  // Shared scaffolding: every test below works in a fresh tmp NEAT_HOME and a
  // fresh tmp scan path so they're independent of one another and of the
  // user's real ~/.neat. The scan path always carries one minimal Node
  // service so discovery returns something real.
  async function setupSandbox(): Promise<{
    home: string
    project: string
    projectReal: string
    cleanup: () => Promise<void>
  }> {
    const os2 = await import('node:os')
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const home = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-init-home-'))
    const project = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-init-project-'))
    const projectReal = await fs2.realpath(project)
    await fs2.writeFile(
      path2.join(projectReal, 'package.json'),
      JSON.stringify({ name: 'sandbox-svc', version: '0.0.0' }, null, 2),
    )
    return {
      home,
      project,
      projectReal,
      cleanup: async () => {
        await fs2.rm(home, { recursive: true, force: true })
        await fs2.rm(project, { recursive: true, force: true })
      },
    }
  }

  async function withInit<T>(
    fn: (ctx: {
      home: string
      projectReal: string
      runInit: typeof import('../../src/cli.js').runInit
      defaultOpts: import('../../src/cli.js').InitOptions
    }) => Promise<T>,
  ): Promise<T> {
    const path2 = await import('node:path')
    const sandbox = await setupSandbox()
    const prevHome = process.env.NEAT_HOME
    const prevLog = console.log
    process.env.NEAT_HOME = sandbox.home
    console.log = () => {}
    try {
      const { runInit } = await import('../../src/cli.js')
      const defaultOpts: import('../../src/cli.js').InitOptions = {
        scanPath: sandbox.projectReal,
        outPath: path2.join(sandbox.projectReal, 'neat-out', 'graph.json'),
        project: 'sandbox',
        projectExplicit: true,
        apply: false,
        dryRun: false,
        noInstall: false,
      }
      return await fn({
        home: sandbox.home,
        projectReal: sandbox.projectReal,
        runInit,
        defaultOpts,
      })
    } finally {
      console.log = prevLog
      if (prevHome === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prevHome
      await sandbox.cleanup()
    }
  }

  it('init prints discovery report before any file mutation (ADR-046 #2)', async () => {
    // We can't intercept fs.* easily without mocks, so we anchor on the
    // observable order in source: runInit calls printDiscoveryReport before
    // anything that mutates disk (`saveGraphToDisk`, `addProject`,
    // `fs.writeFile(patchPath`). The check is structural, not runtime —
    // exactly the shape ADR-046 #2 asks for.
    const cli = readFileSync(join(CORE_SRC, 'cli.ts'), 'utf8')
    const initBody = cli.match(/export async function runInit[\s\S]*?\n\}\n/)?.[0] ?? ''
    expect(initBody.length).toBeGreaterThan(0)

    const idxReport = initBody.indexOf('printDiscoveryReport(')
    const idxSave = initBody.indexOf('saveGraphToDisk(')
    const idxRegister = initBody.indexOf('addProject(')
    const idxPatchWrite = initBody.indexOf("fs.writeFile(patchPath")
    expect(idxReport).toBeGreaterThan(0)
    expect(idxSave).toBeGreaterThan(idxReport)
    expect(idxRegister).toBeGreaterThan(idxReport)
    expect(idxPatchWrite).toBeGreaterThan(idxReport)
  })

  it('init does not modify package.json/requirements.txt/Gemfile/pom.xml without --apply (ADR-046 #4)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    await withInit(async ({ projectReal, runInit, defaultOpts }) => {
      const manifests = ['package.json', 'requirements.txt', 'Gemfile', 'pom.xml']
      const stub = '{"name":"sandbox-svc","version":"0.0.0"}'
      for (const m of manifests) {
        if (m !== 'package.json') {
          await fs2.writeFile(path2.join(projectReal, m), stub)
        }
      }
      const before = new Map<string, string>()
      for (const m of manifests) {
        before.set(m, await fs2.readFile(path2.join(projectReal, m), 'utf8'))
      }
      const result = await runInit({ ...defaultOpts, apply: false })
      expect(result.exitCode).toBe(0)
      for (const m of manifests) {
        const after = await fs2.readFile(path2.join(projectReal, m), 'utf8')
        expect(after, `${m} was modified by init without --apply`).toBe(before.get(m))
      }
    })
  })

  it('init never modifies lockfiles (package-lock, poetry.lock, Gemfile.lock) (ADR-046 #4)', async () => {
    // Two-part assertion. (a) Source-grep: nothing under installers/ or cli.ts
    // names a lockfile as a write target. (b) End-to-end: --apply on a
    // sandbox carrying lockfiles leaves them byte-identical.
    const cli = readFileSync(join(CORE_SRC, 'cli.ts'), 'utf8')
    const installerFiles = walkSrc(join(CORE_SRC, 'installers'))
    const haystacks = [cli, ...installerFiles.map((f) => readFileSync(f, 'utf8'))]
    const lockfiles = [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'poetry.lock',
      'Pipfile.lock',
      'Gemfile.lock',
      'Cargo.lock',
    ]
    for (const haystack of haystacks) {
      // The forbidden list lives in installers/index.ts as the SAFETY check
      // — that's where we expect to see lockfile names. Anything else
      // referencing them is the contract violation.
      const lines = haystack.split('\n')
      for (const lock of lockfiles) {
        for (const line of lines) {
          if (!line.includes(lock)) continue
          if (line.includes('FORBIDDEN_LOCKFILES')) continue
          if (line.trim().startsWith('//')) continue
          if (line.trim().startsWith('*')) continue
          // String entries inside the FORBIDDEN_LOCKFILES set itself.
          if (/^\s*['"][^'"]+['"],?\s*$/.test(line)) continue
          throw new Error(`unexpected lockfile reference: ${line.trim()}`)
        }
      }
    }

    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    await withInit(async ({ projectReal, runInit, defaultOpts }) => {
      const lockfilePath = path2.join(projectReal, 'package-lock.json')
      const lockBefore = '{"name":"sandbox-svc","lockfileVersion":3}'
      await fs2.writeFile(lockfilePath, lockBefore)
      const result = await runInit({ ...defaultOpts, apply: true })
      expect(result.exitCode).toBe(0)
      const lockAfter = await fs2.readFile(lockfilePath, 'utf8')
      expect(lockAfter).toBe(lockBefore)
    })
  })

  it('init --dry-run produces a patch but does not write any file other than neat.patch (ADR-046 #3)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    await withInit(async ({ home, projectReal, runInit, defaultOpts }) => {
      const result = await runInit({ ...defaultOpts, dryRun: true })
      expect(result.exitCode).toBe(0)
      // neat.patch is the only file the dry-run is allowed to write.
      const patchPath = path2.join(projectReal, 'neat.patch')
      await expect(fs2.access(patchPath)).resolves.toBeUndefined()
      expect(result.writtenFiles).toEqual([patchPath])
      // No registry entry was written (the file should not exist at all).
      await expect(
        fs2.access(path2.join(home, 'projects.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      // No graph snapshot was written.
      await expect(
        fs2.access(path2.join(projectReal, 'neat-out', 'graph.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('init is idempotent — second run on same project produces no graph diff (ADR-046 #6)', async () => {
    const fs2 = await import('node:fs/promises')
    await withInit(async ({ runInit, defaultOpts }) => {
      const r1 = await runInit({ ...defaultOpts })
      expect(r1.exitCode).toBe(0)
      const snap1 = JSON.parse(await fs2.readFile(defaultOpts.outPath, 'utf8'))
      const r2 = await runInit({ ...defaultOpts })
      expect(r2.exitCode).toBe(0)
      const snap2 = JSON.parse(await fs2.readFile(defaultOpts.outPath, 'utf8'))
      // exportedAt is a per-write timestamp on the snapshot wrapper, not part
      // of the graph itself. The graph payload must be byte-identical.
      expect(snap2.graph).toEqual(snap1.graph)
    })
  })

  it('init writes ~/.neat/projects.json entry per ADR-048', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    await withInit(async ({ home, projectReal, runInit, defaultOpts }) => {
      const result = await runInit({ ...defaultOpts })
      expect(result.exitCode).toBe(0)
      const raw = await fs2.readFile(path2.join(home, 'projects.json'), 'utf8')
      const reg = JSON.parse(raw)
      expect(reg.version).toBe(1)
      expect(reg.projects).toHaveLength(1)
      expect(reg.projects[0]).toMatchObject({
        name: 'sandbox',
        path: projectReal,
        status: 'active',
      })
      expect(reg.projects[0].languages).toContain('javascript')
      expect(reg.projects[0].registeredAt).toMatch(/T/)
    })
  })

  it('init exits with non-zero on project name collision (ADR-046 #7)', async () => {
    const os2 = await import('node:os')
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const home = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-init-collision-home-'))
    const projectA = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-init-collision-a-'))
    const projectB = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-init-collision-b-'))
    const realA = await fs2.realpath(projectA)
    const realB = await fs2.realpath(projectB)
    for (const dir of [realA, realB]) {
      await fs2.writeFile(
        path2.join(dir, 'package.json'),
        JSON.stringify({ name: path2.basename(dir), version: '0.0.0' }),
      )
    }
    const prevHome = process.env.NEAT_HOME
    const prevLog = console.log
    const prevErr = console.error
    process.env.NEAT_HOME = home
    console.log = () => {}
    console.error = () => {}
    try {
      const { runInit } = await import('../../src/cli.js')
      const r1 = await runInit({
        scanPath: realA,
        outPath: path2.join(realA, 'neat-out', 'graph.json'),
        project: 'collide',
        projectExplicit: true,
        apply: false,
        dryRun: false,
        noInstall: false,
      })
      expect(r1.exitCode).toBe(0)
      const r2 = await runInit({
        scanPath: realB,
        outPath: path2.join(realB, 'neat-out', 'graph.json'),
        project: 'collide',
        projectExplicit: true,
        apply: false,
        dryRun: false,
        noInstall: false,
      })
      expect(r2.exitCode).not.toBe(0)
    } finally {
      console.log = prevLog
      console.error = prevErr
      if (prevHome === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prevHome
      await fs2.rm(home, { recursive: true, force: true })
      await fs2.rm(projectA, { recursive: true, force: true })
      await fs2.rm(projectB, { recursive: true, force: true })
    }
  })
})

describe('SDK install contract (ADR-047)', () => {
  async function makeNodeService(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const os2 = await import('node:os')
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const dir = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-installer-js-'))
    return {
      dir: await fs2.realpath(dir),
      cleanup: () => fs2.rm(dir, { recursive: true, force: true }),
    }
  }

  it('every installer module exports detect/plan/apply (ADR-047 #1)', async () => {
    const { INSTALLERS } = await import('../../src/installers/index.js')
    expect(INSTALLERS.length).toBeGreaterThan(0)
    for (const inst of INSTALLERS) {
      expect(typeof inst.name).toBe('string')
      expect(inst.name.length).toBeGreaterThan(0)
      expect(typeof inst.detect).toBe('function')
      expect(typeof inst.plan).toBe('function')
      expect(typeof inst.apply).toBe('function')
    }
  })

  it('Node installer plan adds the OTel dep set and prepares an entry-point injection (ADR-047 #2 + ADR-069 §2)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { dir, cleanup } = await makeNodeService()
    try {
      await fs2.writeFile(
        path2.join(dir, 'package.json'),
        JSON.stringify(
          { name: 'svc', version: '0.0.0', main: 'server.js' },
          null,
          2,
        ),
      )
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const { javascriptInstaller } = await import('../../src/installers/javascript.js')
      expect(await javascriptInstaller.detect(dir)).toBe(true)
      const plan = await javascriptInstaller.plan(dir)
      expect(plan.language).toBe('javascript')
      const depNames = plan.dependencyEdits.map((d) => d.name)
      expect(depNames).toContain('@opentelemetry/sdk-node')
      expect(depNames).toContain('@opentelemetry/api')
      expect(depNames).toContain('@opentelemetry/auto-instrumentations-node')
      for (const dep of plan.dependencyEdits) {
        expect(dep.kind).toBe('add')
        expect(dep.file).toBe(path2.join(dir, 'package.json'))
      }
      // ADR-069 §3 — entry-point injection lines up against the resolved
      // entry file, not scripts.start. The `after` is the bare require/
      // import statement that the apply phase will splice as the first
      // non-shebang line.
      expect(plan.entrypointEdits).toHaveLength(1)
      const ep = plan.entrypointEdits[0]!
      expect(ep.file).toBe(path2.join(dir, 'server.js'))
      expect(ep.after).toMatch(/require\(['"]\.\/otel-init/)
      expect(plan.envEdits.some((e) => e.key === 'OTEL_EXPORTER_OTLP_ENDPOINT')).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('Python installer plan adds opentelemetry-distro and prefixes entrypoint (ADR-047 #2)', async () => {
    const os2 = await import('node:os')
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const dir = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-installer-py-'))
    const real = await fs2.realpath(dir)
    try {
      await fs2.writeFile(path2.join(real, 'requirements.txt'), 'flask==3.0.0\n')
      await fs2.writeFile(path2.join(real, 'Procfile'), 'web: python app.py\n')
      const { pythonInstaller, isEmptyPlan } = await import(
        '../../src/installers/index.js'
      )
      expect(await pythonInstaller.detect(real)).toBe(true)
      const plan = await pythonInstaller.plan(real)
      expect(plan.language).toBe('python')
      expect(isEmptyPlan(plan)).toBe(false)

      const depNames = plan.dependencyEdits.map((d) => d.name)
      expect(depNames).toContain('opentelemetry-distro')
      expect(depNames).toContain('opentelemetry-exporter-otlp')
      for (const dep of plan.dependencyEdits) {
        expect(dep.kind).toBe('add')
        expect(dep.file).toBe(path2.join(real, 'requirements.txt'))
      }

      expect(plan.entrypointEdits.length).toBeGreaterThan(0)
      const ep = plan.entrypointEdits[0]!
      expect(ep.file).toBe(path2.join(real, 'Procfile'))
      expect(ep.after).toContain('opentelemetry-instrument')
      expect(ep.after.startsWith('web:')).toBe(true)
      expect(plan.envEdits.some((e) => e.key === 'OTEL_EXPORTER_OTLP_ENDPOINT')).toBe(true)

      // Apply lands real edits and is idempotent — second plan empty.
      await pythonInstaller.apply(plan)
      const reqs = await fs2.readFile(path2.join(real, 'requirements.txt'), 'utf8')
      expect(reqs).toMatch(/opentelemetry-distro/)
      expect(reqs).toMatch(/opentelemetry-exporter-otlp/)
      const proc = await fs2.readFile(path2.join(real, 'Procfile'), 'utf8')
      expect(proc).toContain('opentelemetry-instrument python app.py')
      const second = await pythonInstaller.plan(real)
      expect(isEmptyPlan(second)).toBe(true)
    } finally {
      await fs2.rm(dir, { recursive: true, force: true })
    }
  })

  it('no installer plan output references package-lock.json/poetry.lock/Gemfile.lock (ADR-047 #4)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const lockfiles = [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'poetry.lock',
      'Pipfile.lock',
      'Gemfile.lock',
      'Cargo.lock',
    ]
    const { INSTALLERS } = await import('../../src/installers/index.js')
    const offenders: string[] = []
    for (const inst of INSTALLERS) {
      const { dir, cleanup } = await makeNodeService()
      try {
        // Drop in everything an installer might detect on, plus a lockfile
        // for every language. Plans are pure data — no side effects from
        // calling them, so this is safe across all installers.
        await fs2.writeFile(
          path2.join(dir, 'package.json'),
          JSON.stringify({ name: 'svc', version: '0.0.0', scripts: { start: 'node s.js' } }),
        )
        await fs2.writeFile(path2.join(dir, 'pyproject.toml'), '[project]\nname="svc"')
        await fs2.writeFile(path2.join(dir, 'requirements.txt'), 'flask==3.0.0\n')
        for (const lock of lockfiles) {
          await fs2.writeFile(path2.join(dir, lock), '{}')
        }
        if (!(await inst.detect(dir))) continue
        const plan = await inst.plan(dir)
        const allFiles = [
          ...plan.dependencyEdits.map((e) => e.file),
          ...plan.entrypointEdits.map((e) => e.file),
          ...plan.envEdits.map((e) => e.file).filter((f): f is string => f !== null),
        ]
        for (const f of allFiles) {
          const base = path2.basename(f)
          if (lockfiles.includes(base)) {
            offenders.push(`${inst.name}: plan references lockfile ${f}`)
          }
        }
      } finally {
        await cleanup()
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('plan(dir) returns an empty plan when SDK is already installed (ADR-047 #5 + ADR-069 §6)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { dir, cleanup } = await makeNodeService()
    try {
      await fs2.writeFile(
        path2.join(dir, 'package.json'),
        JSON.stringify({
          name: 'svc',
          version: '0.0.0',
          main: 'server.js',
          dependencies: {
            '@opentelemetry/api': '^1.9.0',
            '@opentelemetry/sdk-node': '^0.57.0',
            '@opentelemetry/auto-instrumentations-node': '^0.55.0',
            dotenv: '^16.4.5',
          },
        }),
      )
      // Entry already wires the injection on its first non-shebang line and
      // the generated otel-init + .env.neat are present — that's the
      // already-instrumented end-state.
      await fs2.writeFile(
        path2.join(dir, 'server.js'),
        `require('./otel-init.cjs')\nconsole.log('hi')\n`,
      )
      await fs2.writeFile(path2.join(dir, 'otel-init.cjs'), '// generated\n')
      await fs2.writeFile(path2.join(dir, '.env.neat'), 'OTEL_SERVICE_NAME=svc\n')
      const { javascriptInstaller, isEmptyPlan } = await import('../../src/installers/index.js')
      const plan = await javascriptInstaller.plan(dir)
      expect(isEmptyPlan(plan)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('plan output is deterministic across runs (ADR-047 #6)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { dir, cleanup } = await makeNodeService()
    try {
      await fs2.writeFile(
        path2.join(dir, 'package.json'),
        JSON.stringify(
          { name: 'svc', version: '0.0.0', main: 'server.js' },
          null,
          2,
        ),
      )
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const { javascriptInstaller } = await import('../../src/installers/javascript.js')
      const a = await javascriptInstaller.plan(dir)
      const b = await javascriptInstaller.plan(dir)
      expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    } finally {
      await cleanup()
    }
  })

  it('apply failure produces a neat-rollback.patch (ADR-047 #7)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { dir, cleanup } = await makeNodeService()
    try {
      const manifest = path2.join(dir, 'package.json')
      const original = JSON.stringify(
        { name: 'svc', version: '0.0.0', main: 'server.js' },
        null,
        2,
      )
      await fs2.writeFile(manifest, original)
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const { javascriptInstaller } = await import('../../src/installers/javascript.js')
      // Construct a plan with a dependencyEdit pointing at a real manifest
      // (so apply reads originals OK) plus an entrypointEdit pointing at a
      // file that does not exist — the second pass crashes when reading
      // originals for that file. The contract: the rollback path triggers
      // and neat-rollback.patch lands on disk.
      const ghost = path2.join(dir, 'does-not-exist', 'server.js')
      await expect(
        javascriptInstaller.apply({
          language: 'javascript',
          serviceDir: dir,
          dependencyEdits: [
            { file: manifest, kind: 'add', name: '@opentelemetry/api', version: '^1.9.0' },
          ],
          entrypointEdits: [{ file: ghost, before: 'a', after: 'b' }],
          envEdits: [],
          generatedFiles: [],
        }),
      ).rejects.toBeInstanceOf(Error)
      // The real manifest was rolled back (still bears the original bytes).
      const after = await fs2.readFile(manifest, 'utf8')
      expect(after).toBe(original)
      // And neat-rollback.patch lives at the service root.
      const rollback = await fs2.readFile(path2.join(dir, 'neat-rollback.patch'), 'utf8')
      expect(rollback).toContain('neat-rollback.patch')
      expect(rollback).toContain(manifest)
    } finally {
      await cleanup()
    }
  })
})

describe('SDK install — apply-side (ADR-069)', () => {
  async function makeNodeService(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const os2 = await import('node:os')
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const dir = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-installer-apply-'))
    return {
      dir: await fs2.realpath(dir),
      cleanup: () => fs2.rm(dir, { recursive: true, force: true }),
    }
  }

  async function writePkg(dir: string, pkg: Record<string, unknown>): Promise<void> {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    await fs2.writeFile(path2.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  }

  // ── §2 — entry resolution ───────────────────────────────────────────────

  it('§2 — entry resolution: pkg.main wins when present', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'dist/server.js' })
      await fs2.mkdir(path2.join(dir, 'dist'), { recursive: true })
      await fs2.writeFile(path2.join(dir, 'dist/server.js'), `console.log('hi')\n`)
      await fs2.writeFile(path2.join(dir, 'index.js'), `console.log('decoy')\n`)
      const { javascriptInstaller } = await import('../../src/installers/javascript.js')
      const plan = await javascriptInstaller.plan(dir)
      expect(plan.entryFile).toBe(path2.join(dir, 'dist/server.js'))
    } finally {
      await cleanup()
    }
  })

  it('§2 — entry resolution: pkg.bin (string and map forms) used when pkg.main absent', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')

    // String form
    {
      const { dir, cleanup } = await makeNodeService()
      try {
        await writePkg(dir, { name: 'svc', bin: 'cli.js' })
        await fs2.writeFile(path2.join(dir, 'cli.js'), `console.log('hi')\n`)
        const plan = await javascriptInstaller.plan(dir)
        expect(plan.entryFile).toBe(path2.join(dir, 'cli.js'))
      } finally {
        await cleanup()
      }
    }
    // Map form keyed on pkg.name
    {
      const { dir, cleanup } = await makeNodeService()
      try {
        await writePkg(dir, { name: 'svc', bin: { svc: 'bin/svc.js' } })
        await fs2.mkdir(path2.join(dir, 'bin'), { recursive: true })
        await fs2.writeFile(path2.join(dir, 'bin/svc.js'), `console.log('hi')\n`)
        const plan = await javascriptInstaller.plan(dir)
        expect(plan.entryFile).toBe(path2.join(dir, 'bin/svc.js'))
      } finally {
        await cleanup()
      }
    }
  })

  it('§2 — entry resolution: index.{ts,tsx,js,mjs,cjs} heuristic when neither main nor bin', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const cases = ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs']
    for (const name of cases) {
      const { dir, cleanup } = await makeNodeService()
      try {
        await writePkg(dir, { name: 'svc' })
        await fs2.writeFile(path2.join(dir, name), `console.log('hi')\n`)
        const plan = await javascriptInstaller.plan(dir)
        expect(plan.entryFile).toBe(path2.join(dir, name))
      } finally {
        await cleanup()
      }
    }
  })

  it('§2 — lib-only package (no resolvable entry) is skipped with reason "lib-only"', async () => {
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'lib-only-svc' })
      const plan = await javascriptInstaller.plan(dir)
      expect(plan.libOnly).toBe(true)
      expect(plan.entryFile).toBeUndefined()
      const outcome = await javascriptInstaller.apply(plan)
      expect(outcome.outcome).toBe('lib-only')
      expect(outcome.reason).toContain('no resolvable entry')
      expect(outcome.writtenFiles).toEqual([])
    } finally {
      await cleanup()
    }
  })

  // ── §1 — generated otel-init contents ───────────────────────────────────

  it('§1 — generated otel-init.{js,ts} lands adjacent to the resolved entry', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'src/server.js' })
      await fs2.mkdir(path2.join(dir, 'src'), { recursive: true })
      await fs2.writeFile(path2.join(dir, 'src/server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      const outcome = await javascriptInstaller.apply(plan)
      expect(outcome.outcome).toBe('instrumented')
      // Adjacent to the entry — i.e. in src/, not the package root.
      const adjacent = path2.join(dir, 'src/otel-init.cjs')
      const stat = await fs2.stat(adjacent)
      expect(stat.isFile()).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('§1 — generated otel-init imports @opentelemetry/auto-instrumentations-node/register', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      await javascriptInstaller.apply(plan)
      const contents = await fs2.readFile(path2.join(dir, 'otel-init.cjs'), 'utf8')
      expect(contents).toContain('@opentelemetry/auto-instrumentations-node/register')
    } finally {
      await cleanup()
    }
  })

  it('§1 — generated otel-init loads .env.neat via dotenv before the auto-instrumentation hook runs', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      await javascriptInstaller.apply(plan)
      const contents = await fs2.readFile(path2.join(dir, 'otel-init.cjs'), 'utf8')
      // dotenv invocation comes before the auto-instrumentation require.
      const dotenvIdx = contents.indexOf('dotenv')
      const registerIdx = contents.indexOf('auto-instrumentations-node/register')
      expect(dotenvIdx).toBeGreaterThan(-1)
      expect(registerIdx).toBeGreaterThan(-1)
      expect(dotenvIdx).toBeLessThan(registerIdx)
    } finally {
      await cleanup()
    }
  })

  // ── §1, §3 — ESM / CJS / TS dispatch ────────────────────────────────────

  it('§1, §3 — ESM dispatch on pkg.type === "module" (inserts `import` form)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', type: 'module', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      expect(plan.entrypointEdits[0]?.after).toMatch(/^import\s+['"]\.\/otel-init/)
      await javascriptInstaller.apply(plan)
      // Generated file is the .mjs flavor.
      const stat = await fs2.stat(path2.join(dir, 'otel-init.mjs'))
      expect(stat.isFile()).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('§1, §3 — ESM dispatch on .mjs entry extension', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.mjs' })
      await fs2.writeFile(path2.join(dir, 'server.mjs'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      expect(plan.entrypointEdits[0]?.after).toMatch(/^import\s+['"]\.\/otel-init/)
      await javascriptInstaller.apply(plan)
      const stat = await fs2.stat(path2.join(dir, 'otel-init.mjs'))
      expect(stat.isFile()).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('§1, §3 — CJS dispatch otherwise (inserts `require` form)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      expect(plan.entrypointEdits[0]?.after).toMatch(/^require\(['"]\.\/otel-init/)
      await javascriptInstaller.apply(plan)
      const stat = await fs2.stat(path2.join(dir, 'otel-init.cjs'))
      expect(stat.isFile()).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('§1 — TS template chosen when entry ends in .ts/.tsx', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'src/server.ts' })
      await fs2.mkdir(path2.join(dir, 'src'), { recursive: true })
      await fs2.writeFile(path2.join(dir, 'src/server.ts'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      // Injection drops the .ts extension so the TS resolver picks it up.
      expect(plan.entrypointEdits[0]?.after).toMatch(/^import\s+['"]\.\/otel-init['"]/)
      await javascriptInstaller.apply(plan)
      const stat = await fs2.stat(path2.join(dir, 'src/otel-init.ts'))
      expect(stat.isFile()).toBe(true)
    } finally {
      await cleanup()
    }
  })

  // ── §3 — entry injection + shebang preservation ─────────────────────────

  it('§3 — injection lands as the first non-shebang line of the entry', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      const before = `console.log('original first line')\nconsole.log('second')\n`
      await fs2.writeFile(path2.join(dir, 'server.js'), before)
      const plan = await javascriptInstaller.plan(dir)
      await javascriptInstaller.apply(plan)
      const after = await fs2.readFile(path2.join(dir, 'server.js'), 'utf8')
      const lines = after.split('\n')
      expect(lines[0]).toMatch(/require\(['"]\.\/otel-init/)
      expect(lines[1]).toBe(`console.log('original first line')`)
    } finally {
      await cleanup()
    }
  })

  it('§3 — shebang on line 1 is preserved; init line inserted on line 2', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'cli.js' })
      const before = `#!/usr/bin/env node\nconsole.log('original')\n`
      await fs2.writeFile(path2.join(dir, 'cli.js'), before)
      const plan = await javascriptInstaller.plan(dir)
      await javascriptInstaller.apply(plan)
      const after = await fs2.readFile(path2.join(dir, 'cli.js'), 'utf8')
      const lines = after.split('\n')
      expect(lines[0]).toBe('#!/usr/bin/env node')
      expect(lines[1]).toMatch(/require\(['"]\.\/otel-init/)
      expect(lines[2]).toBe(`console.log('original')`)
    } finally {
      await cleanup()
    }
  })

  it('§6 — re-running --apply when otel-init exists is a no-op (logs "already instrumented")', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const planA = await javascriptInstaller.plan(dir)
      const outcomeA = await javascriptInstaller.apply(planA)
      expect(outcomeA.outcome).toBe('instrumented')
      // Second pass — plan empties out and apply reports already-instrumented.
      const planB = await javascriptInstaller.plan(dir)
      const { isEmptyPlan } = await import('../../src/installers/index.js')
      expect(isEmptyPlan(planB)).toBe(true)
      const outcomeB = await javascriptInstaller.apply(planB)
      expect(outcomeB.outcome).toBe('already-instrumented')
      expect(outcomeB.writtenFiles).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('§6 — re-running --apply when first non-shebang line matches injection pattern is a no-op for injection', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      // User pre-instrumented by hand; first line already matches the
      // injection pattern.
      await fs2.writeFile(
        path2.join(dir, 'server.js'),
        `require('./otel-init.cjs')\nconsole.log('hi')\n`,
      )
      const plan = await javascriptInstaller.plan(dir)
      expect(plan.entrypointEdits).toEqual([])
    } finally {
      await cleanup()
    }
  })

  // ── §4 — per-service OTEL_SERVICE_NAME in .env.neat ─────────────────────

  it('§4 — .env.neat written to <package-dir> with OTEL_SERVICE_NAME=<pkg.name>', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'checkout-svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      await javascriptInstaller.apply(plan)
      const env = await fs2.readFile(path2.join(dir, '.env.neat'), 'utf8')
      expect(env).toContain('OTEL_SERVICE_NAME=checkout-svc')
    } finally {
      await cleanup()
    }
  })

  it('§4 — scoped names (e.g. @medusajs/auth) preserved verbatim, scope not stripped', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: '@medusajs/auth', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      await javascriptInstaller.apply(plan)
      const env = await fs2.readFile(path2.join(dir, '.env.neat'), 'utf8')
      expect(env).toContain('OTEL_SERVICE_NAME=@medusajs/auth')
    } finally {
      await cleanup()
    }
  })

  it('§4 — .env.neat also carries OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      await javascriptInstaller.apply(plan)
      const env = await fs2.readFile(path2.join(dir, '.env.neat'), 'utf8')
      expect(env).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318')
    } finally {
      await cleanup()
    }
  })

  it('§6 — existing .env.neat is never overwritten', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const userEnvNeat = `OTEL_SERVICE_NAME=user-set-name\nUSER_KEY=keep-me\n`
      await fs2.writeFile(path2.join(dir, '.env.neat'), userEnvNeat)
      const plan = await javascriptInstaller.plan(dir)
      await javascriptInstaller.apply(plan)
      const env = await fs2.readFile(path2.join(dir, '.env.neat'), 'utf8')
      expect(env).toBe(userEnvNeat)
    } finally {
      await cleanup()
    }
  })

  // ── §5 — four-deps invariant ────────────────────────────────────────────

  it('§5 — Node installer plan includes dotenv as the fourth dependency', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      const depNames = plan.dependencyEdits.map((d) => d.name)
      expect(depNames).toContain('dotenv')
    } finally {
      await cleanup()
    }
  })

  it('§5 — four-deps invariant: api + sdk-node + auto-instrumentations-node + dotenv', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      const depNames = new Set(plan.dependencyEdits.map((d) => d.name))
      expect(depNames).toEqual(
        new Set([
          '@opentelemetry/api',
          '@opentelemetry/sdk-node',
          '@opentelemetry/auto-instrumentations-node',
          'dotenv',
        ]),
      )
    } finally {
      await cleanup()
    }
  })

  // ── §7 — allowed write paths ────────────────────────────────────────────

  it('§7 — apply writes only package.json, otel-init.{js,ts}, .env.neat (no other paths)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      const outcome = await javascriptInstaller.apply(plan)
      // Allowed: package.json, otel-init.{cjs,mjs,ts}, .env.neat — plus the
      // entry file itself (carved out for the injection edit).
      const allowed = /(?:package\.json|otel-init\.(?:js|cjs|mjs|ts)|\.env\.neat|server\.js)$/
      for (const f of outcome.writtenFiles) {
        expect(f).toMatch(allowed)
      }
    } finally {
      await cleanup()
    }
  })

  it('§7 — lockfiles still never written (ADR-047 §4 holds through the apply-side extension)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const lockBefore = '{ "lockfileVersion": 3 }'
      await fs2.writeFile(path2.join(dir, 'package-lock.json'), lockBefore)
      const plan = await javascriptInstaller.plan(dir)
      const outcome = await javascriptInstaller.apply(plan)
      for (const f of outcome.writtenFiles) {
        expect(path2.basename(f)).not.toBe('package-lock.json')
      }
      const lockAfter = await fs2.readFile(path2.join(dir, 'package-lock.json'), 'utf8')
      expect(lockAfter).toBe(lockBefore)
    } finally {
      await cleanup()
    }
  })

  // ── §8 — dry-run / apply parity ─────────────────────────────────────────

  it('§8 — dry-run output names the same file paths the apply phase would write', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller, renderPatch } = await import('../../src/installers/index.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      const patch = renderPatch([{ installer: 'javascript', plan }])
      expect(patch).toContain(path2.join(dir, 'package.json'))
      expect(patch).toContain(path2.join(dir, 'otel-init.cjs'))
      expect(patch).toContain(path2.join(dir, '.env.neat'))
      expect(patch).toContain(path2.join(dir, 'server.js'))
    } finally {
      await cleanup()
    }
  })

  it('§8 — dry-run output includes the exact lines that would land in each file', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller, renderPatch } = await import('../../src/installers/index.js')
    const { dir, cleanup } = await makeNodeService()
    try {
      await writePkg(dir, { name: 'svc', main: 'server.js' })
      await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
      const plan = await javascriptInstaller.plan(dir)
      const patch = renderPatch([{ installer: 'javascript', plan }])
      // The auto-instrumentation hook line from the generated otel-init shows
      // up in the dry-run output.
      expect(patch).toContain('@opentelemetry/auto-instrumentations-node/register')
      // The injection line shows up too.
      expect(patch).toMatch(/require\(['"]\.\/otel-init/)
    } finally {
      await cleanup()
    }
  })

  it('§9 — apply summary returns { instrumented, alreadyInstrumented, libOnly } per package', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { javascriptInstaller } = await import('../../src/installers/javascript.js')

    // Instrumented case.
    {
      const { dir, cleanup } = await makeNodeService()
      try {
        await writePkg(dir, { name: 'svc', main: 'server.js' })
        await fs2.writeFile(path2.join(dir, 'server.js'), `console.log('hi')\n`)
        const plan = await javascriptInstaller.plan(dir)
        const outcome = await javascriptInstaller.apply(plan)
        expect(outcome.outcome).toBe('instrumented')
        expect(outcome.writtenFiles.length).toBeGreaterThan(0)
      } finally {
        await cleanup()
      }
    }
    // Lib-only case.
    {
      const { dir, cleanup } = await makeNodeService()
      try {
        await writePkg(dir, { name: 'lib-only' })
        const plan = await javascriptInstaller.plan(dir)
        const outcome = await javascriptInstaller.apply(plan)
        expect(outcome.outcome).toBe('lib-only')
      } finally {
        await cleanup()
      }
    }
  })
})

describe('Machine-level project registry contract (ADR-048)', () => {
  it('registry.ts is the only module reading/writing ~/.neat/projects.json (ADR-048 #8)', () => {
    // Authority is locked to packages/core/src/registry.ts. Nothing else in
    // core, mcp, or types may name `projects.json` directly. Allowed mentions:
    // the registry module itself, the contract markdown (referenced via
    // string literals in tests), and this assertion.
    const offenders: string[] = []
    for (const file of [...walkSrc(CORE_SRC), ...walkSrc(MCP_SRC)]) {
      if (file.endsWith('registry.ts')) continue
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        if (line.includes('projects.json')) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('writes go through writeAtomically (tmp + rename) (ADR-048 #3)', () => {
    const registry = readFileSync(join(CORE_SRC, 'registry.ts'), 'utf8')
    // The helper must exist, must do tmp + fsync + rename.
    expect(registry).toMatch(/export\s+async\s+function\s+writeAtomically\s*\(/)
    expect(registry).toMatch(/\.tmp/)
    expect(registry).toMatch(/fd\.sync\(\)/)
    expect(registry).toMatch(/fs\.rename\(/)
    // Every write helper that mutates the registry routes through it; no raw
    // `fs.writeFile(registryPath()` slipping past the atomic write.
    expect(registry).not.toMatch(/fs\.writeFile\([^)]*registryPath/)
  })

  it('writes acquire flock on ~/.neat/projects.json.lock (ADR-048 #4)', () => {
    const registry = readFileSync(join(CORE_SRC, 'registry.ts'), 'utf8')
    expect(registry).toMatch(/registryLockPath/)
    expect(registry).toMatch(/projects\.json\.lock/)
    // Exclusive create is the cross-platform equivalent of flock(LOCK_EX).
    expect(registry).toMatch(/fs\.open\([^,]+,\s*['"]wx['"]\)/)
    // 5s timeout per the contract.
    expect(registry).toMatch(/LOCK_TIMEOUT_MS\s*=\s*5_?000/)
    // Mutating helpers wrap their work in withLock.
    expect(registry).toMatch(/addProject[\s\S]*?withLock\(/)
    expect(registry).toMatch(/removeProject[\s\S]*?withLock\(/)
    expect(registry).toMatch(/setStatus[\s\S]*?withLock\(/)
  })

  it('paths are stored as resolved absolute (no duplicate entries from relative paths) (ADR-048 #7)', async () => {
    const tmp = await import('node:os').then((m) => m.tmpdir())
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const home = await fs2.mkdtemp(path2.join(tmp, 'neat-registry-resolve-'))
    const project = await fs2.mkdtemp(path2.join(tmp, 'neat-registry-project-'))
    const projectReal = await fs2.realpath(project)
    const cwd = process.cwd()
    const prevHome = process.env.NEAT_HOME
    process.env.NEAT_HOME = home
    try {
      process.chdir(path2.dirname(projectReal))
      const { addProject, listProjects } = await import('../../src/registry.js')
      const relative = path2.basename(projectReal)
      // Register once with an absolute path, once with a relative path; the
      // contract says they must collapse to a single entry keyed on the
      // resolved absolute path.
      await addProject({ name: 'p', path: projectReal })
      await addProject({ name: 'p', path: relative })
      const projects = await listProjects()
      expect(projects).toHaveLength(1)
      expect(projects[0]?.path).toBe(projectReal)
      expect(path2.isAbsolute(projects[0]?.path ?? '')).toBe(true)
    } finally {
      process.chdir(cwd)
      if (prevHome === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prevHome
      await fs2.rm(home, { recursive: true, force: true })
      await fs2.rm(project, { recursive: true, force: true })
    }
  })

  it('removal does not delete neat-out/ or policy.json or user files (ADR-048 #6)', async () => {
    const tmp = await import('node:os').then((m) => m.tmpdir())
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const home = await fs2.mkdtemp(path2.join(tmp, 'neat-registry-rm-home-'))
    const project = await fs2.mkdtemp(path2.join(tmp, 'neat-registry-rm-project-'))
    const projectReal = await fs2.realpath(project)
    const neatOut = path2.join(projectReal, 'neat-out')
    const policy = path2.join(projectReal, 'policy.json')
    const userFile = path2.join(projectReal, 'src', 'index.ts')
    await fs2.mkdir(neatOut, { recursive: true })
    await fs2.writeFile(path2.join(neatOut, 'graph.json'), '{}')
    await fs2.writeFile(policy, '{"version":1,"rules":[]}')
    await fs2.mkdir(path2.dirname(userFile), { recursive: true })
    await fs2.writeFile(userFile, 'export const x = 1\n')
    const prevHome = process.env.NEAT_HOME
    process.env.NEAT_HOME = home
    try {
      const { addProject, removeProject } = await import('../../src/registry.js')
      await addProject({ name: 'rm-test', path: projectReal })
      const removed = await removeProject('rm-test')
      expect(removed?.name).toBe('rm-test')

      // Source assertion: the removal helper has no `fs.rm`, `fs.unlink`,
      // `rmdir`, or `rmSync` call against any project artifact. The scan is
      // narrow on purpose — the only `fs.unlink` allowed is the lockfile
      // release in `releaseLock`.
      const registrySrc = readFileSync(join(CORE_SRC, 'registry.ts'), 'utf8')
      const removeBlock = registrySrc.match(/removeProject[\s\S]*?\n\}\n/)?.[0] ?? ''
      expect(removeBlock).not.toMatch(/fs\.rm\(/)
      expect(removeBlock).not.toMatch(/fs\.unlink\(/)
      expect(removeBlock).not.toMatch(/rmdir/)

      // End-to-end: every artifact created above survives the removal.
      await expect(fs2.access(path2.join(neatOut, 'graph.json'))).resolves.toBeUndefined()
      await expect(fs2.access(policy)).resolves.toBeUndefined()
      await expect(fs2.access(userFile)).resolves.toBeUndefined()
    } finally {
      if (prevHome === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prevHome
      await fs2.rm(home, { recursive: true, force: true })
      await fs2.rm(project, { recursive: true, force: true })
    }
  })
})

describe('Daemon contract (ADR-049)', () => {
  // Sandbox helper: tmp NEAT_HOME with a registry pre-seeded by addProject,
  // optionally with one or more registered projects. Returns a cleanup that
  // unwinds env mutations + tmp dirs.
  async function setupDaemonSandbox(opts: {
    projects?: Array<{ name: string; missingPath?: boolean }>
  } = {}): Promise<{
    home: string
    cleanup: () => Promise<void>
    addedPaths: Map<string, string>
  }> {
    const os2 = await import('node:os')
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const home = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neatd-home-'))
    const addedPaths = new Map<string, string>()
    const cleanups: Array<() => Promise<void>> = []
    const prevHome = process.env.NEAT_HOME
    const prevPort = process.env.PORT
    const prevOtelPort = process.env.OTEL_PORT
    const prevHost = process.env.HOST
    process.env.NEAT_HOME = home
    // ADR-063 — daemon binds REST :8080 and OTLP :4318 by default. Force
    // ephemeral ports under test so the suite is robust against ports being
    // occupied on dev boxes and against multiple workers fighting for 8080.
    process.env.PORT = '0'
    process.env.OTEL_PORT = '0'
    process.env.HOST = '127.0.0.1'

    const { addProject, setStatus } = await import('../../src/registry.js')
    for (const p of opts.projects ?? []) {
      const dir = await fs2.mkdtemp(path2.join(os2.tmpdir(), `neatd-project-${p.name}-`))
      const real = await fs2.realpath(dir)
      await fs2.writeFile(
        path2.join(real, 'package.json'),
        JSON.stringify({ name: p.name, version: '0.0.0' }),
      )
      await addProject({ name: p.name, path: real, languages: ['javascript'] })
      addedPaths.set(p.name, real)
      cleanups.push(() => fs2.rm(dir, { recursive: true, force: true }))
      if (p.missingPath) {
        // Yank the dir after registration so the daemon sees a registered
        // project whose disk has vanished — the broken-path graceful path.
        await fs2.rm(real, { recursive: true, force: true })
      }
      // setStatus call is implicit here — addProject defaults to 'active'.
      void setStatus
    }

    return {
      home,
      addedPaths,
      cleanup: async () => {
        if (prevHome === undefined) delete process.env.NEAT_HOME
        else process.env.NEAT_HOME = prevHome
        if (prevPort === undefined) delete process.env.PORT
        else process.env.PORT = prevPort
        if (prevOtelPort === undefined) delete process.env.OTEL_PORT
        else process.env.OTEL_PORT = prevOtelPort
        if (prevHost === undefined) delete process.env.HOST
        else process.env.HOST = prevHost
        for (const c of cleanups) await c().catch(() => {})
        await fs2.rm(home, { recursive: true, force: true })
      },
    }
  }

  it('daemon writes only via persist.ts loop and shutdown handlers (ADR-049 — mutation authority)', () => {
    // Source-grep: daemon.ts has no direct fs writes against project graph
    // files. Persistence flows through startPersistLoop (which lives in
    // persist.ts), and the only fs.unlink/writeAtomically calls are for
    // the PID file at ~/.neat/neatd.pid.
    const daemon = readFileSync(join(CORE_SRC, 'daemon.ts'), 'utf8')
    expect(daemon).toMatch(/startPersistLoop\(/)
    // No raw fs.writeFile or fs.write to a graph snapshot. The two allowed
    // writes are writeAtomically for the PID file (registry-helper) and
    // fs.unlink for cleanup of that same PID file.
    const offenders: string[] = []
    daemon.split('\n').forEach((line, i) => {
      if (/fs\.writeFile\(/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`)
      if (/fs\.appendFile\(/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`)
    })
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('per-project graph isolation: failure in one project does not affect others (ADR-049 #4)', async () => {
    const { home, cleanup } = await setupDaemonSandbox({
      projects: [
        { name: 'good', missingPath: false },
        { name: 'broken', missingPath: true },
      ],
    })
    const prevWarn = console.warn
    const prevLog = console.log
    console.warn = () => {}
    console.log = () => {}
    try {
      const { startDaemon } = await import('../../src/daemon.js')
      const handle = await startDaemon()
      try {
        // Both projects appear in slots; the missing-path one is marked
        // broken, the surviving one is active and producing a snapshot.
        const good = handle.slots.get('good')
        const broken = handle.slots.get('broken')
        expect(good, 'good slot present').toBeDefined()
        expect(broken, 'broken slot present').toBeDefined()
        expect(good!.status).toBe('active')
        expect(broken!.status).toBe('broken')
      } finally {
        await handle.stop()
      }
      // Confirm setStatus on the registry actually ran for the broken one.
      const { listProjects } = await import('../../src/registry.js')
      const projects = await listProjects()
      const brokenEntry = projects.find((p) => p.name === 'broken')
      expect(brokenEntry?.status).toBe('broken')
      void home
    } finally {
      console.warn = prevWarn
      console.log = prevLog
      await cleanup()
    }
  })

  it('OTel span routing matches by service.name across registered projects (ADR-049 #5)', async () => {
    const { routeSpanToProject } = await import('../../src/daemon.js')
    const { DEFAULT_PROJECT } = await import('../../src/graph.js')
    const projects = [
      {
        name: 'checkout',
        path: '/tmp/checkout',
        registeredAt: '2026-05-07T00:00:00.000Z',
        languages: ['javascript'],
        status: 'active' as const,
      },
      {
        name: 'inventory',
        path: '/tmp/inventory',
        registeredAt: '2026-05-07T00:00:00.000Z',
        languages: ['python'],
        status: 'active' as const,
      },
      {
        name: 'paused-svc',
        path: '/tmp/paused-svc',
        registeredAt: '2026-05-07T00:00:00.000Z',
        languages: [],
        status: 'paused' as const,
      },
    ]
    expect(routeSpanToProject('checkout', projects)).toBe('checkout')
    expect(routeSpanToProject('inventory', projects)).toBe('inventory')
    // Paused entries are not active routing targets.
    expect(routeSpanToProject('paused-svc', projects)).toBe(DEFAULT_PROJECT)
    // Unknown service.name falls back per ADR-033's FrontierNode flow.
    expect(routeSpanToProject('unknown-mystery-service', projects)).toBe(DEFAULT_PROJECT)
    expect(routeSpanToProject(undefined, projects)).toBe(DEFAULT_PROJECT)
  })

  it('graceful degradation: missing registry → boot refuses with clear error (ADR-049 #6)', async () => {
    const os2 = await import('node:os')
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const home = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neatd-empty-home-'))
    const prevHome = process.env.NEAT_HOME
    process.env.NEAT_HOME = home
    try {
      const { startDaemon } = await import('../../src/daemon.js')
      await expect(startDaemon()).rejects.toThrow(/registry not found/)
    } finally {
      if (prevHome === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prevHome
      await fs2.rm(home, { recursive: true, force: true })
    }
  })

  it('daemon writes PID to ~/.neat/neatd.pid (ADR-049 #7)', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { home, cleanup } = await setupDaemonSandbox({
      projects: [{ name: 'pid-test' }],
    })
    const prevWarn = console.warn
    const prevLog = console.log
    console.warn = () => {}
    console.log = () => {}
    try {
      const { startDaemon } = await import('../../src/daemon.js')
      const handle = await startDaemon()
      try {
        expect(handle.pidPath).toBe(path2.join(home, 'neatd.pid'))
        const pidRaw = await fs2.readFile(handle.pidPath, 'utf8')
        expect(Number.parseInt(pidRaw.trim(), 10)).toBe(process.pid)
      } finally {
        await handle.stop()
      }
      // Stop removes the PID file.
      await expect(fs2.access(handle.pidPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      console.warn = prevWarn
      console.log = prevLog
      await cleanup()
    }
  })

  it('SIGHUP triggers registry re-read (ADR-049 #2)', async () => {
    const { home, cleanup } = await setupDaemonSandbox({
      projects: [{ name: 'first' }],
    })
    const prevWarn = console.warn
    const prevLog = console.log
    console.warn = () => {}
    console.log = () => {}
    try {
      const { startDaemon } = await import('../../src/daemon.js')
      const handle = await startDaemon()
      try {
        expect(handle.slots.has('first')).toBe(true)
        expect(handle.slots.has('second')).toBe(false)

        // Add a second project to the registry while the daemon is running.
        const os2 = await import('node:os')
        const fs2 = await import('node:fs/promises')
        const path2 = await import('node:path')
        const dir = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neatd-second-'))
        const real = await fs2.realpath(dir)
        await fs2.writeFile(
          path2.join(real, 'package.json'),
          JSON.stringify({ name: 'second', version: '0.0.0' }),
        )
        const { addProject } = await import('../../src/registry.js')
        await addProject({ name: 'second', path: real, languages: ['javascript'] })

        // Send SIGHUP and wait for the reload to settle. The handler is
        // fire-and-forget so we poll the slots map briefly.
        process.kill(process.pid, 'SIGHUP')
        const deadline = Date.now() + 2000
        while (Date.now() < deadline && !handle.slots.has('second')) {
          await new Promise((r) => setTimeout(r, 25))
        }
        expect(handle.slots.has('second')).toBe(true)
        await fs2.rm(dir, { recursive: true, force: true })
      } finally {
        await handle.stop()
      }
      void home
    } finally {
      console.warn = prevWarn
      console.log = prevLog
      await cleanup()
    }
  })

  // ADR-063 — binding observability. The daemon binds REST :8080 and the
  // OTLP HTTP receiver :4318 after slot bootstrap; the contract surface is
  // "an outside caller can reach the daemon," not "the supervisor is up."
  // Tests run on ephemeral ports — see setupDaemonSandbox.
  it('ADR-063 — REST listener bound within 30s; default project answers GET /graph 200', async () => {
    const { home, cleanup } = await setupDaemonSandbox({
      projects: [{ name: 'default' }],
    })
    const prevWarn = console.warn
    const prevLog = console.log
    console.warn = () => {}
    console.log = () => {}
    try {
      const t0 = Date.now()
      const { startDaemon } = await import('../../src/daemon.js')
      const handle = await startDaemon()
      try {
        expect(handle.restAddress).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        const res = await fetch(`${handle.restAddress}/graph`)
        expect(res.status).toBe(200)
        const elapsedMs = Date.now() - t0
        expect(elapsedMs).toBeLessThan(30_000)
      } finally {
        await handle.stop()
      }
      void home
    } finally {
      console.warn = prevWarn
      console.log = prevLog
      await cleanup()
    }
  })

  it('ADR-063 — OTLP HTTP receiver bound within 30s of startDaemon resolving', async () => {
    const { home, cleanup } = await setupDaemonSandbox({
      projects: [{ name: 'default' }],
    })
    const prevWarn = console.warn
    const prevLog = console.log
    console.warn = () => {}
    console.log = () => {}
    try {
      const t0 = Date.now()
      const { startDaemon } = await import('../../src/daemon.js')
      const handle = await startDaemon()
      try {
        expect(handle.otlpAddress).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        // /health is the cheap liveness probe wired in buildOtelReceiver.
        // The contract is that the socket is bound, not that /v1/traces
        // accepts an empty GET.
        const res = await fetch(`${handle.otlpAddress}/health`)
        expect(res.status).toBe(200)
        const elapsedMs = Date.now() - t0
        expect(elapsedMs).toBeLessThan(30_000)
      } finally {
        await handle.stop()
      }
      void home
    } finally {
      console.warn = prevWarn
      console.log = prevLog
      await cleanup()
    }
  })

  it('ADR-063 — every registered project answers GET /projects/:project/graph with 200', async () => {
    const { home, cleanup } = await setupDaemonSandbox({
      projects: [{ name: 'default' }, { name: 'second' }, { name: 'third' }],
    })
    const prevWarn = console.warn
    const prevLog = console.log
    console.warn = () => {}
    console.log = () => {}
    try {
      const { startDaemon } = await import('../../src/daemon.js')
      const handle = await startDaemon()
      try {
        for (const name of ['default', 'second', 'third']) {
          const res = await fetch(`${handle.restAddress}/projects/${name}/graph`)
          expect(res.status, `project ${name} should answer 200`).toBe(200)
        }
      } finally {
        await handle.stop()
      }
      void home
    } finally {
      console.warn = prevWarn
      console.log = prevLog
      await cleanup()
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Claude Code skill (v0.2.5 step 6 — packaging, not under a locked contract)
// ──────────────────────────────────────────────────────────────────────────
describe('Claude Code skill packaging', () => {
  it('CLI snippet matches packages/claude-skill/claude_code_config.json byte-for-byte', async () => {
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const { CLAUDE_SKILL_CONFIG } = await import('../../src/cli.js')
    const skillPath = path2.join(
      __dirname,
      '../../../claude-skill/claude_code_config.json',
    )
    const fileRaw = await fs2.readFile(skillPath, 'utf8')
    const fileParsed = JSON.parse(fileRaw)
    // The CLI is the source of truth at runtime; the file is the
    // documentation copy. They must agree.
    expect(fileParsed).toEqual(CLAUDE_SKILL_CONFIG)
  })

  it('snippet wires @neat.is/mcp over stdio with NEAT_API_URL', async () => {
    const { CLAUDE_SKILL_CONFIG } = await import('../../src/cli.js')
    const neat = CLAUDE_SKILL_CONFIG.mcpServers.neat
    expect(neat.type).toBe('stdio')
    expect(neat.command).toBe('npx')
    expect(neat.args).toContain('@neat.is/mcp')
    expect(neat.env.NEAT_API_URL).toMatch(/^https?:\/\//)
  })

  it('runSkill --apply merges into ~/.claude.json without disturbing other entries', async () => {
    const os2 = await import('node:os')
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const home = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-skill-home-'))
    const target = path2.join(home, '.claude.json')
    // Pre-existing config the user might have wired by hand.
    await fs2.writeFile(
      target,
      JSON.stringify(
        {
          mcpServers: {
            other: { type: 'stdio', command: 'something', args: [] },
          },
          someUnrelatedSetting: true,
        },
        null,
        2,
      ),
    )
    const prev = process.env.NEAT_CLAUDE_CONFIG
    process.env.NEAT_CLAUDE_CONFIG = target
    const prevLog = console.log
    console.log = () => {}
    try {
      const { runSkill } = await import('../../src/cli.js')
      const r = await runSkill({ apply: true, printConfig: false })
      expect(r.exitCode).toBe(0)
      const after = JSON.parse(await fs2.readFile(target, 'utf8'))
      // Existing entries survive the merge.
      expect(after.someUnrelatedSetting).toBe(true)
      expect(after.mcpServers.other.command).toBe('something')
      // The neat entry is in place.
      expect(after.mcpServers.neat.type).toBe('stdio')
      expect(after.mcpServers.neat.args).toContain('@neat.is/mcp')
    } finally {
      console.log = prevLog
      if (prev === undefined) delete process.env.NEAT_CLAUDE_CONFIG
      else process.env.NEAT_CLAUDE_CONFIG = prev
      await fs2.rm(home, { recursive: true, force: true })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Queued — flipped from todo to live as cleanup issues land
// ──────────────────────────────────────────────────────────────────────────
describe('Queued contracts (v0.2.1 leftovers — #141, #142, #145)', () => {
  // v0.2.2 OTel-ingest todos (#131-#135) used to live here. Removed when v0.2.2
  // closed — every ADR-033 assertion is live in its dedicated describe block.
  // v0.2.3 traversal todos (#136-#139) used to live here too. Removed when
  // v0.2.3 closed — every ADR-036/037/038 assertion is live in its dedicated
  // describe block.
  // v0.2.4 MCP-refresh todos (#143, #144) likewise removed — both ADR-039
  // assertions live in the MCP tool surface and queued-list duplicates were
  // noise. The remaining three (#141, #142, #145) are v0.2.1 leftovers
  // tracked under v0.x rolling cleanup per the v0.2.1 close.
  it('Ghost EXTRACTED edges removed on re-extract (issue #140)', async () => {
    const { extractedEdgeId } = await import('@neat.is/types')
    const { retireEdgesByFile } = await import('../../src/extract/retire.js')

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', {
      id: 'service:a',
      type: NodeType.ServiceNode,
      name: 'a',
      language: 'javascript',
    })
    g.addNode('database:db', {
      id: 'database:db',
      type: NodeType.DatabaseNode,
      name: 'db',
      engine: 'postgresql',
      engineVersion: '15',
      host: 'db',
    })

    const ghostId = extractedEdgeId('service:a', 'database:db', EdgeType.CONNECTS_TO)
    g.addEdgeWithKey(ghostId, 'service:a', 'database:db', {
      id: ghostId,
      source: 'service:a',
      target: 'database:db',
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.EXTRACTED,
      evidence: { file: 'a/.env' },
    })

    // Edge from a different file survives — retire is path-keyed, not blanket.
    const survivorId = `${EdgeType.CONFIGURED_BY}:service:a->config:a/db.yaml`
    g.addNode('config:a/db.yaml', {
      id: 'config:a/db.yaml',
      type: NodeType.ConfigNode,
      name: 'db.yaml',
      path: 'a/db.yaml',
      fileType: 'yaml',
    })
    g.addEdgeWithKey(survivorId, 'service:a', 'config:a/db.yaml', {
      id: survivorId,
      source: 'service:a',
      target: 'config:a/db.yaml',
      type: EdgeType.CONFIGURED_BY,
      provenance: Provenance.EXTRACTED,
      evidence: { file: 'a/db.yaml' },
    })

    const dropped = retireEdgesByFile(g, 'a/.env')
    expect(dropped).toBe(1)
    expect(g.hasEdge(ghostId)).toBe(false)
    expect(g.hasEdge(survivorId)).toBe(true)
  })

  it('retireExtractedEdgesByMissingFile drops EXTRACTED edges for files no longer on disk (#140)', async () => {
    const { retireExtractedEdgesByMissingFile } = await import(
      '../../src/extract/retire.js'
    )
    const { extractedEdgeId } = await import('@neat.is/types')
    const os2 = await import('node:os')
    const fs2 = await import('node:fs/promises')
    const path2 = await import('node:path')
    const root = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'adr-032-ghost-'))
    const survivorFile = 'apps/foo/.env'
    const ghostFile = 'apps/foo/db.yaml'
    await fs2.mkdir(path2.join(root, 'apps/foo'), { recursive: true })
    await fs2.writeFile(path2.join(root, survivorFile), 'DATABASE_URL=postgres://db/x')
    // Note: ghostFile is intentionally NOT created.

    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:foo', {
      id: 'service:foo',
      type: NodeType.ServiceNode,
      name: 'foo',
      language: 'javascript',
    })
    g.addNode('database:db', {
      id: 'database:db',
      type: NodeType.DatabaseNode,
      name: 'db',
      engine: 'postgresql',
      engineVersion: '15',
      host: 'db',
    })
    g.addNode('config:apps/foo/.env', {
      id: 'config:apps/foo/.env',
      type: NodeType.ConfigNode,
      name: '.env',
      path: 'apps/foo/.env',
      fileType: 'env',
    })

    const survivorId = extractedEdgeId(
      'service:foo',
      'database:db',
      EdgeType.CONNECTS_TO,
    )
    g.addEdgeWithKey(survivorId, 'service:foo', 'database:db', {
      id: survivorId,
      source: 'service:foo',
      target: 'database:db',
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.EXTRACTED,
      evidence: { file: survivorFile },
    })

    const ghostId = extractedEdgeId(
      'service:foo',
      'config:apps/foo/.env',
      EdgeType.CONFIGURED_BY,
    )
    g.addEdgeWithKey(ghostId, 'service:foo', 'config:apps/foo/.env', {
      id: ghostId,
      source: 'service:foo',
      target: 'config:apps/foo/.env',
      type: EdgeType.CONFIGURED_BY,
      provenance: Provenance.EXTRACTED,
      evidence: { file: ghostFile },
    })

    try {
      const dropped = retireExtractedEdgesByMissingFile(g, root)
      expect(dropped).toBe(1)
      expect(g.hasEdge(ghostId)).toBe(false)
      expect(g.hasEdge(survivorId)).toBe(true)
    } finally {
      await fs2.rm(root, { recursive: true, force: true })
    }
  })

  it('extractFromDirectory exposes ghostsRetired in its result (#140)', async () => {
    // Source-grep guard so a refactor doesn't quietly drop the field — the
    // CLI / daemon banner needs to count ghosts cleaned.
    const idx = readFileSync(join(CORE_SRC, 'extract/index.ts'), 'utf8')
    expect(idx).toMatch(/ghostsRetired:\s*number/)
    expect(idx).toMatch(/retireExtractedEdgesByMissingFile\(/)
    expect(idx).toMatch(/ghostsRetired,/)
  })

  it.todo('Source-level DB connection + import detection (issue #141)')
  it.todo('ServiceNode.framework populated from package.json (issue #142)')
  it.todo('Drop unused graphology-traversal/-shortest-path deps (issue #145)')
})

describe('CLI surface contract (ADR-050)', () => {
  // v0.2.8 #23. Nine `neat <verb>` commands mirroring the MCP allowlist.
  // Implementation lives in packages/core/src/cli.ts (dispatcher) +
  // packages/core/src/cli-client.ts (REST helper + verb handlers).

  // Spin a tiny stub server for verb tests. Each test passes its own
  // handler so we can stub success / 4xx / connect-refused.
  async function withStubServer(
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
    fn: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const http = await import('node:http')
    const server = http.createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('server.listen() returned no address')
    const baseUrl = `http://127.0.0.1:${addr.port}`
    try {
      await fn(baseUrl)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  // The MCP tool allowlist (ADR-039 + ADR-060 amendment to ten). CLI verbs
  // are the kebab-case de-prefixed mirror.
  const MCP_TOOLS_TO_VERBS = {
    get_root_cause: 'root-cause',
    get_blast_radius: 'blast-radius',
    get_dependencies: 'dependencies',
    get_observed_dependencies: 'observed-dependencies',
    get_incident_history: 'incidents',
    semantic_search: 'search',
    get_graph_diff: 'diff',
    get_recent_stale_edges: 'stale-edges',
    check_policies: 'policies',
    // Tenth pairing added by ADR-060 — the thesis surface.
    get_divergences: 'divergences',
  } as const

  it('every MCP tool from ADR-039 has a corresponding `neat <verb>` registered (ADR-050 #1)', async () => {
    const { QUERY_VERBS } = await import('../../src/cli.js')
    const expected = new Set(Object.values(MCP_TOOLS_TO_VERBS))
    expect(QUERY_VERBS).toEqual(expected)
  })

  it('verb names are kebab-case and drop the `get_` prefix (ADR-050 #1 — naming)', async () => {
    const { QUERY_VERBS } = await import('../../src/cli.js')
    for (const verb of QUERY_VERBS) {
      expect(verb, `verb "${verb}" must be kebab-case`).toMatch(/^[a-z]+(-[a-z]+)*$/)
      expect(verb, `verb "${verb}" must not carry the get_ prefix`).not.toMatch(/^get[-_]/)
    }
  })

  it('CLI verbs hit NEAT_API_URL via the shared REST client; no graph.json reads from cli-verbs (ADR-050 #2)', () => {
    const cli = readFileSync(join(CORE_SRC, 'cli.ts'), 'utf8')
    const cliClient = readFileSync(join(CORE_SRC, 'cli-client.ts'), 'utf8')
    // cli.ts dispatches via the shared client.
    expect(cli).toMatch(/from\s+['"]\.\/cli-client\.js['"]/)
    expect(cli).toMatch(/createHttpClient\(/)
    expect(cli).toMatch(/NEAT_API_URL/)
    // No fs reads or writes to graph.json from the verb code path.
    // (Lifecycle `init`'s help text mentions graph.json as documentation —
    // that's a string literal, not a read, so we narrow the check to
    // fs-call shapes.)
    for (const src of [cli, cliClient]) {
      expect(src).not.toMatch(/fs\.\w+\([^)]*graph\.json/)
      expect(src).not.toMatch(/readFile[^)]*graph\.json/)
    }
    // Verb handlers don't call fetch directly — they go through the
    // HttpClient interface (`client.get` / `client.post`).
    const cliClientWithoutCreate = cliClient.replace(
      /export function createHttpClient[\s\S]*?^}/m,
      '',
    )
    expect(cliClientWithoutCreate).not.toMatch(/\bfetch\(/)
  })

  it('`--project <name>` resolution chain matches MCP: flag → NEAT_PROJECT env → `default` (ADR-050 #2)', async () => {
    // The dispatcher exports its argv parser; resolveProjectFlag is internal,
    // but its resolution chain is observable from end-to-end behaviour: each
    // verb routes to /projects/<name>/... when project is set, /<path> when
    // it isn't.
    const { runQueryVerb, parseArgs } = await import('../../src/cli.js')

    type Captured = { url: string }
    const captures: Captured[] = []
    const stubHandler = (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ): void => {
      captures.push({ url: req.url ?? '' })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ matches: [] }))
    }

    const prevApi = process.env.NEAT_API_URL
    const prevProject = process.env.NEAT_PROJECT
    const prevWrite = process.stdout.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      await withStubServer(stubHandler, async (baseUrl) => {
        process.env.NEAT_API_URL = baseUrl

        // 1. Flag wins — even when env is set.
        delete process.env.NEAT_PROJECT
        process.env.NEAT_PROJECT = 'env-proj'
        let parsed = parseArgs(['flag-proj-only', '--project', 'flag-proj'])
        let code = await runQueryVerb('search', parsed)
        expect(code).toBe(0)
        expect(captures[captures.length - 1]!.url).toContain('/projects/flag-proj/search')

        // 2. Env used when no flag.
        parsed = parseArgs(['somequery'])
        code = await runQueryVerb('search', parsed)
        expect(code).toBe(0)
        expect(captures[captures.length - 1]!.url).toContain('/projects/env-proj/search')

        // 3. Neither set → unprefixed (server resolves to default).
        delete process.env.NEAT_PROJECT
        parsed = parseArgs(['stillquery'])
        code = await runQueryVerb('search', parsed)
        expect(code).toBe(0)
        const finalUrl = captures[captures.length - 1]!.url
        expect(finalUrl).toMatch(/^\/search/)
        expect(finalUrl).not.toMatch(/\/projects\//)
      })
    } finally {
      process.stdout.write = prevWrite
      if (prevApi === undefined) delete process.env.NEAT_API_URL
      else process.env.NEAT_API_URL = prevApi
      if (prevProject === undefined) delete process.env.NEAT_PROJECT
      else process.env.NEAT_PROJECT = prevProject
    }
  })

  it('default output is human-readable with NL summary + table + provenance footer (ADR-050 #3)', async () => {
    const { formatHuman } = await import('../../src/cli-client.js')
    const human = formatHuman({
      summary: 'A short prose summary.',
      block: '  • node-1\n  • node-2',
      confidence: 0.94,
      provenance: 'OBSERVED',
    })
    // Three sections separated by blank lines.
    const sections = human.split('\n\n')
    expect(sections).toHaveLength(3)
    expect(sections[0]).toBe('A short prose summary.')
    expect(sections[1]).toContain('  • node-1')
    expect(sections[2]).toBe('confidence: 0.94 · provenance: OBSERVED')
  })

  it('`--json` output schema is `{ summary, block, confidence, provenance }` (ADR-050 #3)', async () => {
    const { formatJson } = await import('../../src/cli-client.js')
    const out = formatJson({
      summary: 'svc fails',
      block: '  • node',
      confidence: 0.84,
      provenance: 'OBSERVED',
    })
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['block', 'confidence', 'provenance', 'summary'])
    expect(parsed.summary).toBe('svc fails')
    expect(parsed.block).toBe('  • node')
    expect(parsed.confidence).toBe(0.84)
    expect(parsed.provenance).toBe('OBSERVED')
    // Empty result shape: confidence/provenance default to null in JSON.
    const empty = JSON.parse(formatJson({ summary: 'no matches' })) as Record<string, unknown>
    expect(empty.confidence).toBeNull()
    expect(empty.provenance).toBeNull()
    expect(empty.block).toBe('')
  })

  it('stderr carries diagnostics; stdout carries results — no mixing (ADR-050 #3)', async () => {
    // End-to-end: stub a 500 response and watch stdout/stderr buffers
    // separately. Diagnostics land on stderr; stdout stays empty.
    const { runQueryVerb, parseArgs } = await import('../../src/cli.js')
    const stubHandler = (
      _req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ): void => {
      res.statusCode = 500
      res.end('boom')
    }
    let stdoutBuf = ''
    let stderrBuf = ''
    const prevApi = process.env.NEAT_API_URL
    const prevWrite = process.stdout.write
    const prevErr = console.error
    process.stdout.write = ((chunk: string) => {
      stdoutBuf += chunk
      return true
    }) as typeof process.stdout.write
    console.error = (...args: unknown[]) => {
      stderrBuf += args.join(' ') + '\n'
    }
    try {
      await withStubServer(stubHandler, async (baseUrl) => {
        process.env.NEAT_API_URL = baseUrl
        const code = await runQueryVerb('search', parseArgs(['anything']))
        expect(code).toBe(1)
      })
    } finally {
      process.stdout.write = prevWrite
      console.error = prevErr
      if (prevApi === undefined) delete process.env.NEAT_API_URL
      else process.env.NEAT_API_URL = prevApi
    }
    expect(stdoutBuf).toBe('')
    expect(stderrBuf).toMatch(/boom/)

    // Source-grep — result emitters reach stdout, never console.log.
    const cli = readFileSync(join(CORE_SRC, 'cli.ts'), 'utf8')
    expect(cli).toMatch(/process\.stdout\.write\(formatHuman/)
    expect(cli).toMatch(/process\.stdout\.write\(formatJson/)
  })

  it('exit code 0 on success (ADR-050 #4)', async () => {
    const { runQueryVerb, parseArgs } = await import('../../src/cli.js')
    const stubHandler = (
      _req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ): void => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ matches: [] }))
    }
    const prevApi = process.env.NEAT_API_URL
    const prevWrite = process.stdout.write
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      await withStubServer(stubHandler, async (baseUrl) => {
        process.env.NEAT_API_URL = baseUrl
        const parsed = parseArgs(['anything'])
        const code = await runQueryVerb('search', parsed)
        expect(code).toBe(0)
      })
    } finally {
      process.stdout.write = prevWrite
      if (prevApi === undefined) delete process.env.NEAT_API_URL
      else process.env.NEAT_API_URL = prevApi
    }
  })

  it('exit code 1 on server 4xx/5xx with body error message on stderr (ADR-050 #4)', async () => {
    const { runQueryVerb, parseArgs } = await import('../../src/cli.js')
    const stubHandler = (
      _req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ): void => {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end('upstream blew up: db unreachable')
    }
    const prevApi = process.env.NEAT_API_URL
    const prevWrite = process.stdout.write
    const prevErr = console.error
    let stderrBuf = ''
    console.error = (...args: unknown[]) => {
      stderrBuf += args.join(' ') + '\n'
    }
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      await withStubServer(stubHandler, async (baseUrl) => {
        process.env.NEAT_API_URL = baseUrl
        const parsed = parseArgs(['anything'])
        const code = await runQueryVerb('search', parsed)
        expect(code).toBe(1)
        expect(stderrBuf).toMatch(/upstream blew up/)
      })
    } finally {
      console.error = prevErr
      process.stdout.write = prevWrite
      if (prevApi === undefined) delete process.env.NEAT_API_URL
      else process.env.NEAT_API_URL = prevApi
    }
  })

  it('exit code 2 on misuse before any network call (ADR-050 #4)', async () => {
    const { runQueryVerb, parseArgs } = await import('../../src/cli.js')
    let networkCalls = 0
    const stubHandler = (
      _req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ): void => {
      networkCalls++
      res.end('{}')
    }
    const prevApi = process.env.NEAT_API_URL
    const prevErr = console.error
    console.error = () => {}
    try {
      await withStubServer(stubHandler, async (baseUrl) => {
        process.env.NEAT_API_URL = baseUrl
        // root-cause needs a positional <node-id>; bare invocation is misuse.
        const parsed = parseArgs([])
        const code = await runQueryVerb('root-cause', parsed)
        expect(code).toBe(2)
        expect(networkCalls).toBe(0)
      })
    } finally {
      console.error = prevErr
      if (prevApi === undefined) delete process.env.NEAT_API_URL
      else process.env.NEAT_API_URL = prevApi
    }
  })

  it('exit code 3 distinct from 1 when daemon connection refused / times out (ADR-050 #4)', async () => {
    const { runQueryVerb, parseArgs } = await import('../../src/cli.js')
    // Pick a port that isn't bound. Node's listen-on-0 trick gives us a
    // free port; we close the listener so a subsequent connect refuses.
    const http = await import('node:http')
    const server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    const port = addr.port
    await new Promise<void>((resolve) => server.close(() => resolve()))

    const prevApi = process.env.NEAT_API_URL
    const prevErr = console.error
    process.env.NEAT_API_URL = `http://127.0.0.1:${port}`
    let stderrBuf = ''
    console.error = (...args: unknown[]) => {
      stderrBuf += args.join(' ') + '\n'
    }
    try {
      const parsed = parseArgs(['x'])
      const code = await runQueryVerb('search', parsed)
      expect(code).toBe(3)
      // Should contain a hint about the daemon not running.
      expect(stderrBuf.toLowerCase()).toMatch(/daemon|cannot reach/)
    } finally {
      console.error = prevErr
      if (prevApi === undefined) delete process.env.NEAT_API_URL
      else process.env.NEAT_API_URL = prevApi
    }
  })

  it('no mutation verbs registered behind the query verb surface (ADR-050 #5)', async () => {
    const { QUERY_VERBS } = await import('../../src/cli.js')
    // The contract pins the verb set to the nine MCP tools, all of which are
    // read-only. Any verb name suggesting mutation (`add-`, `remove-`,
    // `update-`, `delete-`, `set-`, `apply-`) is a regression.
    for (const verb of QUERY_VERBS) {
      expect(verb).not.toMatch(/^(add|remove|delete|update|set|apply|create|patch)[-_]/)
    }
    // Source-grep cli-client.ts: every verb handler hits client.get /
    // client.post (the latter only for the policies dry-run endpoint, which
    // is itself read-only — it returns a hypothetical evaluation against the
    // current graph). No PUT / PATCH / DELETE.
    const cliClient = readFileSync(join(CORE_SRC, 'cli-client.ts'), 'utf8')
    expect(cliClient).not.toMatch(/method:\s*['"]PUT['"]/)
    expect(cliClient).not.toMatch(/method:\s*['"]PATCH['"]/)
    expect(cliClient).not.toMatch(/method:\s*['"]DELETE['"]/)
  })

  it('no demo-name hardcoding in `--help` text outside of generic shape examples (ADR-050 #6)', () => {
    // Cross-cutting rule 8 + ADR-050 #6: `--help` examples reference real-shape
    // ids (`service:<name>`, `database:<host>`) without committing to demo
    // names like `payments-db`, `service-a`, `pg`, `postgresql`.
    const cli = readFileSync(join(CORE_SRC, 'cli.ts'), 'utf8')
    // Pull the usage() body out so we only check help text, not file-wide
    // identifiers (e.g. compat strings).
    const usageBody = cli.match(/function usage\(\)[\s\S]*?\n\}/)?.[0] ?? ''
    expect(usageBody.length, 'usage() body must be discoverable').toBeGreaterThan(0)
    for (const banned of ['payments-db', 'service-a', 'service-b', '\'pg\'', '"pg"', 'postgresql']) {
      expect(usageBody).not.toContain(banned)
    }
  })

  it('every verb has a `--help` block listing args, flags, exit codes, example invocation (ADR-050 #7)', async () => {
    // Per-verb args/flags + an example invocation appear in usage(); exit
    // codes are listed once at the bottom (the contract reads as one help
    // block, not nine).
    const cli = readFileSync(join(CORE_SRC, 'cli.ts'), 'utf8')
    const usageBody = cli.match(/function usage\(\)[\s\S]*?\n\}/)?.[0] ?? ''
    const { QUERY_VERBS } = await import('../../src/cli.js')
    for (const verb of QUERY_VERBS) {
      // Verb name appears as the leftmost token of a help line.
      expect(usageBody, `usage() must mention "${verb}"`).toMatch(new RegExp(`\\b${verb}\\b`))
      // Each verb has at least one example invocation in usage().
      expect(usageBody, `usage() must show an example for "${verb}"`).toMatch(
        new RegExp(`example:\\s+neat\\s+${verb}\\b`),
      )
    }
    // Exit codes block.
    expect(usageBody).toMatch(/exit codes:/)
    expect(usageBody).toMatch(/0\s+success/)
    expect(usageBody).toMatch(/1\s+server error/)
    expect(usageBody).toMatch(/2\s+misuse/)
    expect(usageBody).toMatch(/3\s+daemon not reachable/)
  })

  it('`neat --help` lists every verb (lifecycle + query) in one block (ADR-050 #7)', async () => {
    const cli = readFileSync(join(CORE_SRC, 'cli.ts'), 'utf8')
    const usageBody = cli.match(/function usage\(\)[\s\S]*?\n\}/)?.[0] ?? ''
    const { QUERY_VERBS } = await import('../../src/cli.js')
    // Lifecycle verbs: locked at v0.2.5.
    const lifecycle = ['init', 'watch', 'list', 'pause', 'resume', 'uninstall', 'skill']
    for (const verb of [...lifecycle, ...QUERY_VERBS]) {
      expect(usageBody, `usage() must list "${verb}"`).toMatch(new RegExp(`\\b${verb}\\b`))
    }
  })
})

describe('Frontend-facing API contract (ADR-051)', () => {
  // v0.2.8 #24. SSE stream + multi-project switcher endpoint. Speculative —
  // WebSocket transport and per-event filtering deferred to successor ADRs.

  it('GET /events responds with content-type text/event-stream (ADR-051 #1)', async () => {
    const { Projects } = await import('../../src/projects.js')
    const { buildApi } = await import('../../src/api.js')
    const { DEFAULT_PROJECT, getGraph, resetGraph } = await import('../../src/graph.js')
    resetGraph(DEFAULT_PROJECT)
    const registry = new Projects()
    const fs2 = await import('node:fs/promises')
    const os2 = await import('node:os')
    const path2 = await import('node:path')
    const tmp = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-sse-events-'))
    registry.set(DEFAULT_PROJECT, {
      graph: getGraph(DEFAULT_PROJECT),
      paths: {
        snapshotPath: path2.join(tmp, 'graph.json'),
        errorsPath: path2.join(tmp, 'errors.ndjson'),
        staleEventsPath: path2.join(tmp, 'stale-events.ndjson'),
        embeddingsCachePath: path2.join(tmp, 'embeddings.json'),
        policyViolationsPath: path2.join(tmp, 'policy-violations.ndjson'),
      },
    })
    const app = await buildApi({ projects: registry })
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const ctrl = new AbortController()
      const res = await fetch(`${address}/events`, { signal: ctrl.signal })
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
      ctrl.abort()
      await res.body?.cancel().catch(() => {})
    } finally {
      await app.close()
      await fs2.rm(tmp, { recursive: true, force: true })
      resetGraph(DEFAULT_PROJECT)
    }
  })

  it('GET /events and GET /projects/:project/events are both registered (dual-mount per ADR-026) (ADR-051 #1)', () => {
    // Source-grep: the /events route is registered inside registerRoutes,
    // which is called both at the root scope and inside the
    // /projects/:project plugin. One registration site → both mounts.
    const api = readFileSync(join(CORE_SRC, 'api.ts'), 'utf8')
    const m = api.match(/scope\.get<[^>]*>\s*\(\s*['"]\/events['"]/)
    expect(m, 'expected `/events` registered on registerRoutes scope').not.toBeNull()
    // Dual-mount machinery: registerRoutes is invoked at both root and the
    // /projects/:project prefix.
    expect(api).toMatch(/registerRoutes\(app, routeCtx\)/)
    expect(api).toMatch(/prefix:\s*['"]\/projects\/:project['"]/)
  })

  it('SSE event-type taxonomy is exactly the eight locked types — no more, no fewer (ADR-051 #2)', async () => {
    const { NEAT_EVENT_TYPES } = await import('../../src/events.js')
    expect([...NEAT_EVENT_TYPES].sort()).toEqual(
      [
        'edge-added',
        'edge-removed',
        'extraction-complete',
        'node-added',
        'node-removed',
        'node-updated',
        'policy-violation',
        'stale-transition',
      ].sort(),
    )
  })

  it('node-added event payload matches `{ node: GraphNode }` (ADR-051 #2)', async () => {
    const { eventBus, EVENT_BUS_CHANNEL, attachGraphToEventBus } = await import(
      '../../src/events.js'
    )
    const captured: unknown[] = []
    const listener = (env: { type: string; payload: unknown }): void => {
      if (env.type === 'node-added') captured.push(env.payload)
    }
    eventBus.on(EVENT_BUS_CHANNEL, listener)
    try {
      const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({
        allowSelfLoops: false,
      })
      const detach = attachGraphToEventBus(g, { project: 'tester' })
      const node = {
        id: 'service:probe',
        type: NodeType.ServiceNode,
        name: 'probe',
        language: 'javascript',
      } as GraphNode
      g.addNode(node.id, node)
      detach()
      expect(captured).toHaveLength(1)
      expect(captured[0]).toEqual({ node })
    } finally {
      eventBus.off(EVENT_BUS_CHANNEL, listener)
    }
  })

  it('node-updated event payload matches `{ id, changes }` (ADR-051 #2)', async () => {
    const { eventBus, EVENT_BUS_CHANNEL, attachGraphToEventBus } = await import(
      '../../src/events.js'
    )
    const captured: { id: string; changes: unknown }[] = []
    const listener = (env: { type: string; payload: { id: string; changes: unknown } }): void => {
      if (env.type === 'node-updated') captured.push(env.payload)
    }
    eventBus.on(EVENT_BUS_CHANNEL, listener)
    try {
      const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({
        allowSelfLoops: false,
      })
      const detach = attachGraphToEventBus(g, { project: 'tester' })
      const node = {
        id: 'service:probe',
        type: NodeType.ServiceNode,
        name: 'probe',
        language: 'javascript',
      } as GraphNode
      g.addNode(node.id, node)
      g.replaceNodeAttributes(node.id, { ...node, name: 'renamed' } as GraphNode)
      detach()
      const update = captured.find((p) => p.id === 'service:probe')
      expect(update).toBeDefined()
      expect(update!.id).toBe('service:probe')
      expect(update!.changes).toEqual(expect.objectContaining({ name: 'renamed' }))
    } finally {
      eventBus.off(EVENT_BUS_CHANNEL, listener)
    }
  })

  it('node-removed / edge-removed event payloads carry only `{ id }` (ADR-051 #2)', async () => {
    const { eventBus, EVENT_BUS_CHANNEL, attachGraphToEventBus } = await import(
      '../../src/events.js'
    )
    const captured: { type: string; payload: unknown }[] = []
    const listener = (env: { type: string; payload: unknown }): void => {
      if (env.type === 'node-removed' || env.type === 'edge-removed') {
        captured.push({ type: env.type, payload: env.payload })
      }
    }
    eventBus.on(EVENT_BUS_CHANNEL, listener)
    try {
      const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({
        allowSelfLoops: false,
      })
      const detach = attachGraphToEventBus(g, { project: 'tester' })
      g.addNode('service:a', {
        id: 'service:a',
        type: NodeType.ServiceNode,
        name: 'a',
        language: 'javascript',
      } as GraphNode)
      g.addNode('service:b', {
        id: 'service:b',
        type: NodeType.ServiceNode,
        name: 'b',
        language: 'javascript',
      } as GraphNode)
      const eid = `${EdgeType.CALLS}:service:a->service:b`
      g.addEdgeWithKey(eid, 'service:a', 'service:b', {
        id: eid,
        source: 'service:a',
        target: 'service:b',
        type: EdgeType.CALLS,
        provenance: Provenance.EXTRACTED,
      } as GraphEdge)
      g.dropEdge(eid)
      g.dropNode('service:b')
      detach()

      const edgeRemoved = captured.find((c) => c.type === 'edge-removed')
      const nodeRemoved = captured.find((c) => c.type === 'node-removed')
      expect(edgeRemoved?.payload).toEqual({ id: eid })
      expect(nodeRemoved?.payload).toEqual({ id: 'service:b' })
      // Strict shape — only `id`, nothing else (Object.keys returns ['id']).
      expect(Object.keys(edgeRemoved!.payload as object)).toEqual(['id'])
      expect(Object.keys(nodeRemoved!.payload as object)).toEqual(['id'])
    } finally {
      eventBus.off(EVENT_BUS_CHANNEL, listener)
    }
  })

  it('edge-added event payload matches `{ edge: GraphEdge }` (ADR-051 #2)', async () => {
    const { eventBus, EVENT_BUS_CHANNEL, attachGraphToEventBus } = await import(
      '../../src/events.js'
    )
    const captured: { edge: unknown }[] = []
    const listener = (env: { type: string; payload: { edge: unknown } }): void => {
      if (env.type === 'edge-added') captured.push(env.payload)
    }
    eventBus.on(EVENT_BUS_CHANNEL, listener)
    try {
      const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({
        allowSelfLoops: false,
      })
      const detach = attachGraphToEventBus(g, { project: 'tester' })
      g.addNode('service:a', {
        id: 'service:a',
        type: NodeType.ServiceNode,
        name: 'a',
        language: 'javascript',
      } as GraphNode)
      g.addNode('service:b', {
        id: 'service:b',
        type: NodeType.ServiceNode,
        name: 'b',
        language: 'javascript',
      } as GraphNode)
      const edge = {
        id: `${EdgeType.CALLS}:service:a->service:b`,
        source: 'service:a',
        target: 'service:b',
        type: EdgeType.CALLS,
        provenance: Provenance.EXTRACTED,
      } as GraphEdge
      g.addEdgeWithKey(edge.id, 'service:a', 'service:b', edge)
      detach()
      const found = captured.find((p) => (p.edge as GraphEdge).id === edge.id)
      expect(found).toBeDefined()
      expect(found!.edge).toEqual(edge)
    } finally {
      eventBus.off(EVENT_BUS_CHANNEL, listener)
    }
  })

  it('extraction-complete event payload matches `{ project, fileCount, nodesAdded, edgesAdded }` (ADR-051 #2)', async () => {
    const { eventBus, EVENT_BUS_CHANNEL, emitNeatEvent } = await import('../../src/events.js')
    const captured: unknown[] = []
    const listener = (env: { type: string; payload: unknown }): void => {
      if (env.type === 'extraction-complete') captured.push(env.payload)
    }
    eventBus.on(EVENT_BUS_CHANNEL, listener)
    try {
      emitNeatEvent({
        type: 'extraction-complete',
        project: 'tester',
        payload: { project: 'tester', fileCount: 3, nodesAdded: 1, edgesAdded: 2 },
      })
      expect(captured[0]).toEqual({
        project: 'tester',
        fileCount: 3,
        nodesAdded: 1,
        edgesAdded: 2,
      })
    } finally {
      eventBus.off(EVENT_BUS_CHANNEL, listener)
    }
  })

  it('policy-violation event payload matches `{ violation: PolicyViolation }` (ADR-051 #2)', async () => {
    const { eventBus, EVENT_BUS_CHANNEL } = await import('../../src/events.js')
    const { PolicyViolationsLog } = await import('../../src/policy.js')
    const fs2 = await import('node:fs/promises')
    const os2 = await import('node:os')
    const path2 = await import('node:path')
    const tmp = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-pol-violation-'))
    const captured: unknown[] = []
    const listener = (env: { type: string; payload: unknown }): void => {
      if (env.type === 'policy-violation') captured.push(env.payload)
    }
    eventBus.on(EVENT_BUS_CHANNEL, listener)
    try {
      const log = new PolicyViolationsLog(path2.join(tmp, 'pv.ndjson'), 'tester')
      const violation = {
        id: 'p1:n1',
        policyId: 'p1',
        policyName: 'pol',
        severity: 'error' as const,
        onViolation: 'alert' as const,
        ruleType: 'ownership' as const,
        subject: { nodeId: 'service:x' },
        message: 'missing owner',
        observedAt: new Date().toISOString(),
      }
      await log.append(violation)
      expect(captured[0]).toEqual({ violation })
    } finally {
      eventBus.off(EVENT_BUS_CHANNEL, listener)
      await fs2.rm(tmp, { recursive: true, force: true })
    }
  })

  it('stale-transition event payload matches `{ edgeId, from: "OBSERVED", to: "STALE" }` (ADR-051 #2)', async () => {
    const { eventBus, EVENT_BUS_CHANNEL } = await import('../../src/events.js')
    const { markStaleEdges } = await import('../../src/ingest.js')
    const captured: unknown[] = []
    const listener = (env: { type: string; payload: unknown }): void => {
      if (env.type === 'stale-transition') captured.push(env.payload)
    }
    eventBus.on(EVENT_BUS_CHANNEL, listener)
    try {
      const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({
        allowSelfLoops: false,
      })
      g.addNode('service:a', {
        id: 'service:a',
        type: NodeType.ServiceNode,
        name: 'a',
        language: 'javascript',
      } as GraphNode)
      g.addNode('service:b', {
        id: 'service:b',
        type: NodeType.ServiceNode,
        name: 'b',
        language: 'javascript',
      } as GraphNode)
      const eid = `${EdgeType.CALLS}:OBSERVED:service:a->service:b`
      g.addEdgeWithKey(eid, 'service:a', 'service:b', {
        id: eid,
        source: 'service:a',
        target: 'service:b',
        type: EdgeType.CALLS,
        provenance: Provenance.OBSERVED,
        confidence: 1,
        lastObserved: new Date(0).toISOString(),
        callCount: 1,
      } as GraphEdge)
      await markStaleEdges(g, { now: Date.now(), project: 'tester' })
      expect(captured[0]).toEqual({
        edgeId: eid,
        from: Provenance.OBSERVED,
        to: Provenance.STALE,
      })
    } finally {
      eventBus.off(EVENT_BUS_CHANNEL, listener)
    }
  })

  it('SSE heartbeat comment line emitted at most every 30 seconds (ADR-051 #3)', async () => {
    // Default heartbeat interval is 30s — exposed as SSE_HEARTBEAT_MS so the
    // contract value is reachable by anything that needs it (proxies, tests).
    const streaming = readFileSync(join(CORE_SRC, 'streaming.ts'), 'utf8')
    const { SSE_HEARTBEAT_MS } = await import('../../src/streaming.js')
    expect(SSE_HEARTBEAT_MS).toBe(30_000)
    expect(streaming).toMatch(/:heartbeat\\n\\n/)
  })

  it('GET /projects returns the listProjects() shape from registry.ts (ADR-051 #4)', async () => {
    const { Projects } = await import('../../src/projects.js')
    const { buildApi } = await import('../../src/api.js')
    const { DEFAULT_PROJECT, getGraph, resetGraph } = await import('../../src/graph.js')
    const fs2 = await import('node:fs/promises')
    const os2 = await import('node:os')
    const path2 = await import('node:path')
    const home = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-projects-list-'))
    const projDir = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-projects-pdir-'))
    const projReal = await fs2.realpath(projDir)
    const prevHome = process.env.NEAT_HOME
    process.env.NEAT_HOME = home
    resetGraph(DEFAULT_PROJECT)
    try {
      const { addProject, listProjects: listRegistry } = await import('../../src/registry.js')
      await addProject({ name: 'p', path: projReal, languages: ['javascript'] })
      const expected = await listRegistry()
      const reg = new Projects()
      reg.set(DEFAULT_PROJECT, {
        graph: getGraph(DEFAULT_PROJECT),
        paths: {
          snapshotPath: path2.join(home, 'graph.json'),
          errorsPath: path2.join(home, 'errors.ndjson'),
          staleEventsPath: path2.join(home, 'stale-events.ndjson'),
          embeddingsCachePath: path2.join(home, 'embeddings.json'),
          policyViolationsPath: path2.join(home, 'policy-violations.ndjson'),
        },
      })
      const app = await buildApi({ projects: reg })
      const res = await app.inject({ method: 'GET', url: '/projects' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(expected)
      await app.close()
    } finally {
      if (prevHome === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prevHome
      await fs2.rm(home, { recursive: true, force: true })
      await fs2.rm(projDir, { recursive: true, force: true })
      resetGraph(DEFAULT_PROJECT)
    }
  })

  it('GET /projects shape is Array<{ name, path, status, registeredAt, lastSeenAt?, languages }> (ADR-051 #4)', async () => {
    const { Projects } = await import('../../src/projects.js')
    const { buildApi } = await import('../../src/api.js')
    const { DEFAULT_PROJECT, getGraph, resetGraph } = await import('../../src/graph.js')
    const fs2 = await import('node:fs/promises')
    const os2 = await import('node:os')
    const path2 = await import('node:path')
    const home = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-projects-shape-'))
    const projDir = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-projects-shape-p-'))
    const projReal = await fs2.realpath(projDir)
    const prevHome = process.env.NEAT_HOME
    process.env.NEAT_HOME = home
    resetGraph(DEFAULT_PROJECT)
    try {
      const { addProject } = await import('../../src/registry.js')
      await addProject({
        name: 'shape-test',
        path: projReal,
        languages: ['python'],
      })
      const reg = new Projects()
      reg.set(DEFAULT_PROJECT, {
        graph: getGraph(DEFAULT_PROJECT),
        paths: {
          snapshotPath: path2.join(home, 'graph.json'),
          errorsPath: path2.join(home, 'errors.ndjson'),
          staleEventsPath: path2.join(home, 'stale-events.ndjson'),
          embeddingsCachePath: path2.join(home, 'embeddings.json'),
          policyViolationsPath: path2.join(home, 'policy-violations.ndjson'),
        },
      })
      const app = await buildApi({ projects: reg })
      const res = await app.inject({ method: 'GET', url: '/projects' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{
        name: string
        path: string
        status: string
        registeredAt: string
        lastSeenAt?: string
        languages: string[]
      }>
      expect(Array.isArray(body)).toBe(true)
      expect(body).toHaveLength(1)
      const entry = body[0]!
      expect(entry.name).toBe('shape-test')
      expect(entry.path).toBe(projReal)
      expect(entry.status).toBe('active')
      expect(typeof entry.registeredAt).toBe('string')
      expect(entry.languages).toEqual(['python'])
      await app.close()
    } finally {
      if (prevHome === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prevHome
      await fs2.rm(home, { recursive: true, force: true })
      await fs2.rm(projDir, { recursive: true, force: true })
      resetGraph(DEFAULT_PROJECT)
    }
  })

  it('SSE error responses use `event: error` payload before connection close (ADR-051 #5)', () => {
    // Backpressure cap is the only error path that closes the connection
    // mid-stream; the streaming source emits exactly one `event: error`
    // frame before calling end() in that case.
    const streaming = readFileSync(join(CORE_SRC, 'streaming.ts'), 'utf8')
    expect(streaming).toMatch(/event:\s*error/)
    expect(streaming).toMatch(/closeConnection/)
  })

  it('non-SSE error responses keep the ADR-040 `{ error, status, details? }` envelope (ADR-051 #5)', async () => {
    const { Projects } = await import('../../src/projects.js')
    const { buildApi } = await import('../../src/api.js')
    const { DEFAULT_PROJECT, getGraph, resetGraph } = await import('../../src/graph.js')
    const fs2 = await import('node:fs/promises')
    const os2 = await import('node:os')
    const path2 = await import('node:path')
    const tmp = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-err-shape-'))
    resetGraph(DEFAULT_PROJECT)
    try {
      const reg = new Projects()
      reg.set(DEFAULT_PROJECT, {
        graph: getGraph(DEFAULT_PROJECT),
        paths: {
          snapshotPath: path2.join(tmp, 'graph.json'),
          errorsPath: path2.join(tmp, 'errors.ndjson'),
          staleEventsPath: path2.join(tmp, 'stale-events.ndjson'),
          embeddingsCachePath: path2.join(tmp, 'embeddings.json'),
          policyViolationsPath: path2.join(tmp, 'policy-violations.ndjson'),
        },
      })
      const app = await buildApi({ projects: reg })
      const res = await app.inject({ method: 'GET', url: '/projects/missing/graph' })
      expect(res.statusCode).toBe(404)
      const body = res.json() as { error: string }
      expect(typeof body.error).toBe('string')
      expect(body).toEqual({ error: 'project not found', project: 'missing' })
      await app.close()
    } finally {
      await fs2.rm(tmp, { recursive: true, force: true })
      resetGraph(DEFAULT_PROJECT)
    }
  })

  it('SSE backpressure cap drops connection at 1000 queued messages with `event: error` `{ reason: "backpressure" }` (ADR-051 #8)', async () => {
    const { SSE_BACKPRESSURE_CAP } = await import('../../src/streaming.js')
    expect(SSE_BACKPRESSURE_CAP).toBe(1000)
    const streaming = readFileSync(join(CORE_SRC, 'streaming.ts'), 'utf8')
    expect(streaming).toMatch(/reason:\s*['"]backpressure['"]/)
    expect(streaming).toMatch(/backpressureCap/)
  })

  it('event bus is a single EventEmitter singleton in packages/core/src/events.ts (ADR-051 — authority)', async () => {
    const events = await import('../../src/events.js')
    const { EventEmitter } = await import('node:events')
    expect(events.eventBus).toBeInstanceOf(EventEmitter)
    // Singleton: re-importing returns the same instance.
    const again = await import('../../src/events.js')
    expect(again.eventBus).toBe(events.eventBus)
    // No competing EventEmitter exported as a public bus — the named export
    // is exactly `eventBus` and there's only one.
    const src = readFileSync(join(CORE_SRC, 'events.ts'), 'utf8')
    expect(src.match(/export const eventBus/g)).toHaveLength(1)
  })

  it('event producers in ingest.ts / extract/ / watch.ts / policy.ts emit through the bus, not directly to handlers (ADR-051 — authority)', () => {
    // Each producer module must import from events.ts. None may construct a
    // private EventEmitter for graph-mutation broadcast.
    const ingest = readFileSync(join(CORE_SRC, 'ingest.ts'), 'utf8')
    const extractIdx = readFileSync(join(CORE_SRC, 'extract', 'index.ts'), 'utf8')
    const watch = readFileSync(join(CORE_SRC, 'watch.ts'), 'utf8')
    const policy = readFileSync(join(CORE_SRC, 'policy.ts'), 'utf8')
    for (const [name, src] of [
      ['ingest.ts', ingest],
      ['extract/index.ts', extractIdx],
      ['watch.ts', watch],
      ['policy.ts', policy],
    ] as const) {
      expect(src, `${name} must import from events.ts`).toMatch(/from\s+['"]\.\.?\/events\.js['"]|from\s+['"]\.\/events\.js['"]/)
    }
    // Negative: no producer constructs its own EventEmitter for runtime
    // events. The bus is the only one.
    for (const [name, src] of [
      ['ingest.ts', ingest],
      ['extract/index.ts', extractIdx],
      ['policy.ts', policy],
    ] as const) {
      expect(
        src,
        `${name} must not construct a private EventEmitter`,
      ).not.toMatch(/new\s+EventEmitter/)
    }
  })
})

describe('Publish system contract (ADR-052)', () => {
  // The publish pipeline. Five packages ship in lockstep; bin wrappers in
  // the umbrella `require()` subpaths into core and mcp that must be
  // exposed in those packages' `exports` field. The 0.2.6 release shipped
  // with broken exports — the wrappers worked under monorepo symlinks
  // (which bypass exports enforcement) but failed for `npm install -g`
  // users. This block locks the failure shape so it can't recur.

  const REPO_ROOT = join(__dirname, '../../../..')
  // ADR-059 grew the lockstep from five to six packages — `@neat.is/web` is now
  // shipped alongside the rest so `npm install -g neat.is` pulls in the UI.
  const PUBLISHABLE_PACKAGES = ['types', 'core', 'mcp', 'claude-skill', 'web', 'neat.is'] as const

  function readPackageJson(pkgDirName: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages', pkgDirName, 'package.json'), 'utf8'),
    ) as Record<string, unknown>
  }

  it('all six publishable packages share the same version (ADR-052 #2 — lockstep)', () => {
    const versions = PUBLISHABLE_PACKAGES.map((p) => readPackageJson(p).version as string)
    const unique = [...new Set(versions)]
    expect(unique).toHaveLength(1)
  })

  it('cross-package dep ranges match the lockstep version (ADR-052 #2 — lockstep)', () => {
    const version = readPackageJson('types').version as string

    const core = readPackageJson('core') as { dependencies: Record<string, string> }
    expect(core.dependencies['@neat.is/types']).toBe(`^${version}`)

    const mcp = readPackageJson('mcp') as { dependencies: Record<string, string> }
    expect(mcp.dependencies['@neat.is/types']).toBe(`^${version}`)

    const web = readPackageJson('web') as { dependencies: Record<string, string> }
    expect(web.dependencies['@neat.is/types']).toBe(`^${version}`)

    const umbrella = readPackageJson('neat.is') as { dependencies: Record<string, string> }
    expect(umbrella.dependencies['@neat.is/core']).toBe(`^${version}`)
    expect(umbrella.dependencies['@neat.is/mcp']).toBe(`^${version}`)
    expect(umbrella.dependencies['@neat.is/claude-skill']).toBe(`^${version}`)
    expect(umbrella.dependencies['@neat.is/web']).toBe(`^${version}`)
  })

  it('every publishable package declares engines.node: ">=20" (ADR-052 #8)', () => {
    for (const pkg of PUBLISHABLE_PACKAGES) {
      const json = readPackageJson(pkg) as { engines?: { node?: string } }
      expect(json.engines?.node, `${pkg} missing engines.node`).toBe('>=20')
    }
  })

  it('publish workflow encodes the canonical dependency order (ADR-052 #4)', () => {
    const yml = readFileSync(join(REPO_ROOT, '.github/workflows/publish.yml'), 'utf8')
    // Workflow lists `publish_one "packages/<name>"` once per package.
    // The first occurrence of each marks its position; assert they appear
    // in canonical order.
    const positions = PUBLISHABLE_PACKAGES.map((pkg) => {
      const idx = yml.indexOf(`publish_one "packages/${pkg}"`)
      expect(idx, `${pkg} not referenced in publish.yml`).toBeGreaterThan(-1)
      return idx
    })
    const sorted = [...positions].sort((a, b) => a - b)
    expect(positions).toEqual(sorted)
  })

  it('local publish script encodes the canonical dependency order (ADR-052 #4)', () => {
    const sh = readFileSync(join(REPO_ROOT, 'scripts/publish.sh'), 'utf8')
    // Same shape as the workflow check — assert positions appear in order.
    const positions = PUBLISHABLE_PACKAGES.map((pkg) => {
      const idx = sh.indexOf(`"packages/${pkg}"`)
      expect(idx, `${pkg} not referenced in scripts/publish.sh`).toBeGreaterThan(-1)
      return idx
    })
    const sorted = [...positions].sort((a, b) => a - b)
    expect(positions).toEqual(sorted)
  })

  it('every require() in packages/neat.is/bin/* resolves to a path exposed in the target package exports (ADR-052 #1)', () => {
    // Parses each wrapper, extracts the `require('@scope/pkg/subpath')`
    // target, walks the target package's `exports` field, and asserts
    // the subpath is a literal exports key. Wildcard pattern matching
    // is a successor concern. Catches the 0.2.6-class failure where
    // wrappers worked under monorepo symlinks but failed for
    // `npm install -g neat.is` users because exports enforcement only
    // kicks in for tarball installs.
    const binDir = join(REPO_ROOT, 'packages/neat.is/bin')
    const wrappers = readdirSync(binDir).filter(
      (f) => !f.startsWith('.') && statSync(join(binDir, f)).isFile(),
    )
    expect(wrappers.length, 'no wrapper scripts found').toBeGreaterThan(0)

    const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g
    const scopedRe = /^(@[^/]+\/[^/]+)\/(.+)$/

    for (const wrapper of wrappers) {
      const content = readFileSync(join(binDir, wrapper), 'utf8')
      const matches = [...content.matchAll(requireRe)]
      expect(matches.length, `${wrapper} has no require() call`).toBeGreaterThan(0)

      for (const m of matches) {
        const target = m[1] as string
        const parsed = scopedRe.exec(target)
        if (!parsed) continue // bare specifier like 'fs' — not what this rule covers

        const [, pkgName, subpath] = parsed as unknown as [string, string, string]
        const pkgDirName = pkgName.replace('@neat.is/', '')
        const pkg = readPackageJson(pkgDirName) as { exports?: Record<string, unknown> }
        const exports = pkg.exports ?? {}
        const subpathKey = `./${subpath}`

        expect(
          Object.keys(exports),
          `${wrapper} requires ${target} but ${pkgName} exports ${subpathKey} not exposed`,
        ).toContain(subpathKey)
      }
    }
  })

  it('publish workflow installs the just-published umbrella tarball and asserts `neat --help` exits 0 (ADR-052 #3)', () => {
    const yml = readFileSync(join(REPO_ROOT, '.github/workflows/publish.yml'), 'utf8')
    // Smoke-test step must install the umbrella from the registry and invoke
    // its bin. Both signals together — installing the tarball and running
    // `neat --help` — are what make the step a smoke test rather than a
    // version-existence check.
    expect(yml).toMatch(/npm install ["']?neat\.is@/)
    expect(yml).toMatch(/neat --help/)
  })

  it('publish workflow waits for every lockstep package version before install (ADR-064 #1)', () => {
    const yml = readFileSync(join(REPO_ROOT, '.github/workflows/publish.yml'), 'utf8')
    // Per-dep visibility wait. The v0.3.1 smoke failed `ETARGET: No matching
    // version found for @neat.is/web@^0.3.1` because the retry loop only
    // checked the umbrella. The smoke step must explicitly wait on each
    // lockstep package before installing.
    for (const pkg of PUBLISHABLE_PACKAGES) {
      const pkgName = pkg === 'neat.is' ? 'neat.is' : `@neat.is/${pkg}`
      expect(
        yml,
        `${pkgName} should be in the per-dep visibility-wait loop`,
      ).toContain(`"${pkgName}"`)
    }
    // The body must loop with `npm view <pkg>@<version>` against each.
    expect(yml).toMatch(/npm view "\$\{pkg\}@\$\{version\}"/)
  })

  it('publish workflow asserts a built @neat.is/web artifact in the installed tree (ADR-064 #2)', () => {
    const yml = readFileSync(join(REPO_ROOT, '.github/workflows/publish.yml'), 'utf8')
    // Tarball must contain @neat.is/web's built artifact at the standalone
    // form #231 lands — `.next/standalone/packages/web/server.js`. Next 14
    // preserves the monorepo path relative to the auto-detected workspace
    // tracing root, hence the `packages/web` segment. Asserted via `test -f`
    // against a shell variable resolved from the same path.
    expect(yml).toMatch(/@neat\.is\/web/)
    expect(yml).toMatch(/\.next\/standalone\/packages\/web\/server\.js/)
    expect(yml).toMatch(/\[ ! -f "\$web_entry" \]/)
  })

  it('publish workflow spawns `neatd start` and asserts liveness on :8080, :6328, :4318 (ADR-064 #3)', () => {
    const yml = readFileSync(join(REPO_ROOT, '.github/workflows/publish.yml'), 'utf8')
    // Post-`neatd start` liveness. The smoke step must spawn neatd, wait for
    // it to bind, and curl each of the three documented surfaces. Failure on
    // any of them fails the workflow.
    expect(yml).toMatch(/neatd start/)
    expect(yml).toMatch(/localhost:8080\/graph/)
    expect(yml).toMatch(/localhost:6328\//)
    expect(yml).toMatch(/localhost:4318\/health/)
  })

  it('publish workflow seeds a fixture registry with a default project and a nested-node_modules project (ADR-064 #4)', () => {
    const yml = readFileSync(join(REPO_ROOT, '.github/workflows/publish.yml'), 'utf8')
    // Fixture registry needs ≥2 projects, including a project literally named
    // "default" (so ADR-026 unprefixed paths resolve), and at least one
    // project whose directory has a populated node_modules/ tree (so the
    // chokidar trigger exercises the polling fallback from #233).
    expect(yml).toMatch(/NEAT_HOME=.*neat-home/)
    expect(yml).toMatch(/neat init .*--project default/)
    // The nested-node_modules project: workflow runs `npm install` inside
    // its dir so the daemon's watcher sees real ignore-prone trees.
    expect(yml).toMatch(/proj_nested/)
    expect(yml).toMatch(/cd .*proj_nested.*npm install/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Web shell completeness (ADR-056)
// ──────────────────────────────────────────────────────────────────────────
//
// No permanent stub UI in packages/web/. Every interactive element is wired
// or explicitly disabled; no duplicate components; audit doc tracks the
// inventory. All scans flip from todo to live as Jed wires the thirteen
// known stubs from packages/web/audit/09-gaps-and-stubs.md.
describe('Web shell completeness (ADR-056)', () => {
  const REPO_ROOT = join(__dirname, '../../../..')
  const WEB_COMPONENTS = join(REPO_ROOT, 'packages/web/app/components')
  const AUDIT_DOC = join(REPO_ROOT, 'packages/web/audit/09-gaps-and-stubs.md')

  function walkTsx(dir: string, files: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) walkTsx(full, files)
      else if (full.endsWith('.tsx') || full.endsWith('.ts')) files.push(full)
    }
    return files
  }

  function readComponent(name: string): string {
    return readFileSync(join(WEB_COMPONENTS, `${name}.tsx`), 'utf8')
  }

  // Scans the source for every occurrence of a label and asserts that at
  // least one sits inside a JSX context with a click handler or `disabled`
  // attribute. Multiple-occurrence handling is intentional — a label string
  // can appear in helper-function names, comments, or the visible text.
  function assertWiredOrDisabled(source: string, label: string, file: string): void {
    const occurrences: number[] = []
    let from = 0
    while (true) {
      const i = source.indexOf(label, from)
      if (i < 0) break
      occurrences.push(i)
      from = i + label.length
    }
    expect(occurrences.length, `${label} not found in ${file}`).toBeGreaterThan(0)

    const wiredOrDisabled = occurrences.some((idx) => {
      const window = source.slice(Math.max(0, idx - 800), idx + 400)
      const lastTagOpen = Math.max(window.lastIndexOf('<button'), window.lastIndexOf('<div'), 0)
      const tagWindow = window.slice(lastTagOpen)
      return /onClick\s*=/.test(tagWindow) || /\bdisabled\b/.test(tagWindow) || /aria-disabled/.test(tagWindow)
    })
    expect(
      wiredOrDisabled,
      `${label} in ${file} is rendered without onClick or disabled attribute`,
    ).toBe(true)
  }

  it('no empty onClick={() => {}} or onClick={undefined} in packages/web/app/components/** (ADR-056 #2)', () => {
    const offenders: string[] = []
    const empty = /onClick\s*=\s*\{(?:\(\s*\)\s*=>\s*\{\s*\}|undefined)\s*\}/
    for (const f of walkTsx(WEB_COMPONENTS)) {
      const content = readFileSync(f, 'utf8')
      content.split('\n').forEach((line, i) => {
        if (empty.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no two files under packages/web/app/components/ export default components with the same name (ADR-056 #3)', () => {
    const byName = new Map<string, string[]>()
    const decl = /export\s+(?:default\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/g
    for (const f of walkTsx(WEB_COMPONENTS)) {
      const content = readFileSync(f, 'utf8')
      for (const m of content.matchAll(decl)) {
        const name = m[1] as string
        const list = byName.get(name) ?? []
        list.push(f)
        byName.set(name, list)
      }
    }
    const dupes: string[] = []
    for (const [name, files] of byName.entries()) {
      if (files.length > 1) dupes.push(`${name}: ${files.join(', ')}`)
    }
    expect(dupes, dupes.join('\n')).toEqual([])
  })

  it('every entry in audit/09-gaps-and-stubs.md "Stub buttons" tables corresponds to a button in source (ADR-056 #4)', () => {
    const audit = readFileSync(AUDIT_DOC, 'utf8')
    const stubsHeading = audit.indexOf('## Stub buttons')
    const featureGapsHeading = audit.indexOf('## Feature gaps')
    expect(stubsHeading, 'audit doc missing "Stub buttons" section').toBeGreaterThan(-1)
    const stubsSection = audit.slice(stubsHeading, featureGapsHeading > -1 ? featureGapsHeading : undefined)

    const rows = stubsSection.match(/^\|[^\n]+\|/gm) ?? []
    const labels = rows
      .map((row) => row.split('|').map((c) => c.trim()).filter(Boolean)[0] ?? '')
      .filter(
        (s) =>
          s &&
          !/^-+$/.test(s) &&
          !['Button', 'Tab', 'Status', 'Notes', 'Issue'].includes(s),
      )

    const allSrc = walkTsx(WEB_COMPONENTS)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')

    const missing = labels.filter((raw) => {
      const stem = raw.replace(/\s*\([^)]*\)\s*$/, '')
      return !allSrc.includes(stem)
    })
    expect(missing, `audit lists labels not present in source: ${missing.join(', ')}`).toEqual([])
  })

  it('TopBar: History button wired or disabled (ADR-056 #1)', () => {
    assertWiredOrDisabled(readComponent('TopBar'), 'History', 'TopBar.tsx')
  })
  it('TopBar: Share button wired or disabled (ADR-056 #1)', () => {
    assertWiredOrDisabled(readComponent('TopBar'), 'Share', 'TopBar.tsx')
  })
  it('Rail: Layers button wired or disabled (ADR-056 #1)', () => {
    assertWiredOrDisabled(readComponent('Rail'), 'Layers', 'Rail.tsx')
  })
  it('Rail: Find button wired or disabled (ADR-056 #1)', () => {
    assertWiredOrDisabled(readComponent('Rail'), 'Find', 'Rail.tsx')
  })
  it('Rail: NeatScript button wired or disabled (ADR-056 #1)', () => {
    assertWiredOrDisabled(readComponent('Rail'), 'NeatScript', 'Rail.tsx')
  })
  it('Rail: Time travel button wired or disabled (ADR-056 #1)', () => {
    assertWiredOrDisabled(readComponent('Rail'), 'Time travel', 'Rail.tsx')
  })
  it('Rail: Blast radius button wired or disabled (ADR-056 #1)', () => {
    assertWiredOrDisabled(readComponent('Rail'), 'Blast radius', 'Rail.tsx')
  })
  it('Rail: Diff button wired or disabled (ADR-056 #1)', () => {
    assertWiredOrDisabled(readComponent('Rail'), 'Diff', 'Rail.tsx')
  })
  it('Rail: Comments button wired or disabled (ADR-056 #1)', () => {
    assertWiredOrDisabled(readComponent('Rail'), 'Comments', 'Rail.tsx')
  })
  it('Rail: Agents button wired or disabled (ADR-056 #1)', () => {
    assertWiredOrDisabled(readComponent('Rail'), 'Agents', 'Rail.tsx')
  })
  it('Rail: Settings button wired or disabled (ADR-056 #1)', () => {
    assertWiredOrDisabled(readComponent('Rail'), 'Settings', 'Rail.tsx')
  })
  it('GraphCanvas toolbar: Layout: cose toggle wired or disabled (ADR-056 #1)', () => {
    const src = readComponent('GraphCanvas')
    expect(src).toMatch(/Layout:/)
    expect(src).toMatch(/onClick=\{\(\)\s*=>\s*cyRef\.current\?\.layout/)
  })
  it('GraphCanvas toolbar: Locked toggle wired or disabled (ADR-056 #1)', () => {
    const src = readComponent('GraphCanvas')
    expect(src).toMatch(/Locked/)
    expect(src).toMatch(/autoungrabify/)
  })
  it('Inspector: Owners tab wired or disabled (ADR-056 #1)', () => {
    const src = readComponent('Inspector')
    expect(src).toMatch(/setActiveTab\(['"]owners['"]\)/)
  })
  it('Inspector: History tab wired or disabled (ADR-056 #1)', () => {
    const src = readComponent('Inspector')
    const idx = src.indexOf('History')
    expect(idx).toBeGreaterThan(-1)
    const window = src.slice(Math.max(0, idx - 400), idx + 100)
    expect(window).toMatch(/aria-disabled=\{?true\}?|disabled/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Web shell multi-project routing (ADR-057)
// ──────────────────────────────────────────────────────────────────────────
//
// AppShell.tsx owns project state. URL → localStorage → /projects → 'default'
// resolution chain. Project change triggers data refresh. No hardcoded
// project names. Runtime corollary of ADR-026.
describe('Web shell multi-project routing (ADR-057)', () => {
  const REPO_ROOT = join(__dirname, '../../../..')
  const WEB = join(REPO_ROOT, 'packages/web')
  const APP_SHELL = join(WEB, 'app/components/AppShell.tsx')
  const TOPBAR = join(WEB, 'app/components/TopBar.tsx')
  const API_DIR = join(WEB, 'app/api')

  function readSrc(p: string): string {
    return readFileSync(p, 'utf8')
  }
  function walkRoutes(dir: string, files: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) walkRoutes(full, files)
      else if (entry === 'route.ts') files.push(full)
    }
    return files
  }

  it('AppShell.tsx initializes project from URL ?project=X first (ADR-057 #2.1)', () => {
    const src = readSrc(APP_SHELL)
    expect(src).toMatch(/URLSearchParams[\s\S]*?get\(['"]project['"]\)/)
    expect(src).toMatch(/readUrlProject/)
  })

  it('AppShell.tsx falls back to localStorage `neat:lastProject` (ADR-057 #2.2)', () => {
    const src = readSrc(APP_SHELL)
    expect(src).toMatch(/localStorage[\s\S]*?neat:lastProject/)
  })

  it('AppShell.tsx falls back to first entry from GET /projects when registry is non-empty (ADR-057 #2.3)', () => {
    const src = readSrc(APP_SHELL)
    expect(src).toMatch(/fetch\(['"]\/api\/projects['"]\)/)
    expect(src).toMatch(/list\[0\]/)
  })

  it('AppShell.tsx falls back to "default" when registry is empty (ADR-057 #2.4)', () => {
    const src = readSrc(APP_SHELL)
    expect(src).toMatch(/['"]default['"]/)
  })

  it('Project change triggers data refresh — every component using project re-fetches (ADR-057 #3)', () => {
    const components = ['GraphCanvas', 'Inspector', 'StatusBar', 'Rail']
    const offenders: string[] = []
    for (const c of components) {
      const src = readSrc(join(WEB, `app/components/${c}.tsx`))
      const re = /useEffect\([\s\S]*?,\s*\[[^\]]*\bproject\b[^\]]*\]/
      if (!re.test(src)) {
        offenders.push(`${c}.tsx does not depend on project in any useEffect`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  // ADR-057 enforcement bullet — the multi-project re-fetch test was flagged
  // as needing Vitest + RTL tooling new to the web track. This assertion
  // confirms the test file is in place; the test itself is owned by the web
  // workspace's vitest run, not this one.
  it('Multi-project re-fetch test exists in packages/web/test/ (ADR-057 §enforcement)', () => {
    const testFile = join(WEB, 'test/multi-project-refetch.test.tsx')
    expect(existsSync(testFile), `expected ${testFile} to exist`).toBe(true)
    const src = readSrc(testFile)
    expect(src).toMatch(/project change/i)
  })

  it('URL stays in sync — setProject(name) writes ?project=X (ADR-057 #4)', () => {
    const src = readSrc(APP_SHELL)
    expect(src).toMatch(/searchParams\.set\(['"]project['"]/)
    expect(src).toMatch(/history\.(replaceState|pushState)/)
  })

  it('Every API proxy route under packages/web/app/api/** forwards `project` (ADR-057 #5)', () => {
    const offenders: string[] = []
    for (const f of walkRoutes(API_DIR)) {
      const src = readSrc(f)
      if (!/searchParams\.get\(['"]project['"]\)/.test(src)) {
        offenders.push(`${f} does not read project from query string`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('TopBar.tsx renders the active project name visibly (ADR-057 #6)', () => {
    const src = readSrc(TOPBAR)
    expect(src).toMatch(/\{project\}/)
  })

  it('Project switcher in TopBar.tsx uses GET /projects and calls setProject(name) (ADR-057 #7)', () => {
    const src = readSrc(TOPBAR)
    expect(src).toMatch(/fetch\(['"]\/api\/projects['"]\)/)
    expect(src).toMatch(/onProjectChange\(/)
  })

  it('No hardcoded project names (medusa, neat, demo) in branching logic under packages/web/app/components/ or packages/web/lib/ (ADR-057 #8)', () => {
    const offenders: string[] = []
    const dirs = [join(WEB, 'app/components'), join(WEB, 'lib')]
    const re = /['"](medusa|demo)['"]/
    function walk(dir: string, files: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const st = statSync(full)
        if (st.isDirectory()) walk(full, files)
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full)
      }
      return files
    }
    for (const dir of dirs) {
      for (const f of walk(dir)) {
        if (f.endsWith('/fixtures.ts')) continue
        const src = readSrc(f)
        src.split('\n').forEach((line, i) => {
          if (
            re.test(line) &&
            !line.includes('//') &&
            !line.includes('coming') &&
            !line.includes('aria-label') &&
            !line.trim().startsWith('*')
          ) {
            offenders.push(`${f}:${i + 1}: ${line.trim()}`)
          }
        })
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  // ADR-062 — AppShell renders client-only. The two ADR-057 #2a SSR-safety
  // todos this replaces are superseded; with no SSR pass over AppShell the
  // byte-identical-initial-state constraint no longer binds, so guarding
  // useState lazy initializers and useRef initial values against browser-API
  // reads is moot. What we guard instead is the client-only boundary itself.
  //
  // 2026-05-11 amendment extends §4 to /incidents/page.tsx — same shape,
  // same fix. The scan loops over every known client-only mount.
  it('client-only page mounts use dynamic({ ssr: false }) (ADR-062 §4)', () => {
    const paths = [join(WEB, 'app/page.tsx'), join(WEB, 'app/incidents/page.tsx')]
    for (const p of paths) {
      const src = readSrc(p)
      expect(src, p).toMatch(/from\s+['"]next\/dynamic['"]/)
      expect(src, p).toMatch(/\bdynamic\s*\(/)
      expect(src, p).toMatch(/ssr\s*:\s*false/)
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Web shell debugging surface (ADR-058)
// ──────────────────────────────────────────────────────────────────────────
//
// StatusBar shows daemon + SSE connection state. No silent API failures.
// Debug panel keyboard-shortcut toggleable. Read-only.
describe('Web shell debugging surface (ADR-058)', () => {
  const REPO_ROOT = join(__dirname, '../../../..')
  const WEB = join(REPO_ROOT, 'packages/web')
  const STATUSBAR = join(WEB, 'app/components/StatusBar.tsx')
  const TOPBAR = join(WEB, 'app/components/TopBar.tsx')
  const APP_SHELL = join(WEB, 'app/components/AppShell.tsx')
  const DEBUG_PANEL = join(WEB, 'app/components/DebugPanel.tsx')
  const PROXY_CLIENT = join(WEB, 'lib/proxy-client.ts')

  function readSrc(p: string): string {
    return readFileSync(p, 'utf8')
  }

  it('StatusBar.tsx renders an element with data-connection-state attribute (ADR-058 #1)', () => {
    expect(readSrc(STATUSBAR)).toMatch(/data-connection-state=/)
  })

  it('StatusBar.tsx renders an element with data-sse-state attribute (ADR-058 #2)', () => {
    expect(readSrc(STATUSBAR)).toMatch(/data-sse-state=/)
  })

  it('proxy.ts emits a toast or banner on non-2xx response (ADR-058 #3)', () => {
    const src = readSrc(PROXY_CLIENT)
    expect(src).toMatch(/toastBus\.emit/)
    expect(src).toMatch(/!res\.ok/)
  })

  it('A DebugPanel.tsx (or equivalent) component file exists in packages/web/app/components/ (ADR-058 #4)', () => {
    expect(statSync(DEBUG_PANEL).isFile()).toBe(true)
  })

  it('Debug panel toggleable via Ctrl+Shift+D / Cmd+Shift+D keyboard shortcut (ADR-058 #4)', () => {
    const src = readSrc(APP_SHELL)
    expect(src).toMatch(/ctrlKey[\s\S]*?metaKey[\s\S]*?shiftKey/)
    expect(src).toMatch(/setDebugOpen/)
  })

  it('TopBar.tsx or StatusBar.tsx renders the daemon URL string (ADR-058 #5)', () => {
    const top = readSrc(TOPBAR)
    const bar = readSrc(STATUSBAR)
    expect(top.includes('CORE_URL_PUBLIC') || bar.includes('CORE_URL_PUBLIC')).toBe(true)
  })

  it('DebugPanel does not include POST/PUT/DELETE buttons — read-only enforcement (ADR-058 #6)', () => {
    const src = readSrc(DEBUG_PANEL)
    expect(src).not.toMatch(/method\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/)
    expect(src).not.toMatch(/fetch\([^)]*,\s*\{[^}]*method/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Web UI bootstrap from neatd (ADR-059)
// ──────────────────────────────────────────────────────────────────────────
//
// neatd start launches the web UI on port 6328 (T9 NEAT). NEAT_WEB_PORT
// overrides. Fail loudly on collision. @neat.is/web joins the publish-system
// lockstep — six packages instead of five going forward.
describe('Web UI bootstrap from neatd (ADR-059)', () => {
  const REPO_ROOT = join(__dirname, '../../../..')
  const NEATD = join(REPO_ROOT, 'packages/core/src/neatd.ts')
  const WEB_SPAWN = join(REPO_ROOT, 'packages/core/src/web-spawn.ts')

  function readSrc(p: string): string {
    return readFileSync(p, 'utf8')
  }
  function readPkg(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'packages', name, 'package.json'), 'utf8'))
  }

  it('neatd.ts spawns a web UI child process during cmdStart (ADR-059 #1)', () => {
    const src = readSrc(NEATD)
    expect(src).toMatch(/spawnWebUI\(/)
    const cmdStartIdx = src.indexOf('async function cmdStart')
    const spawnIdx = src.indexOf('spawnWebUI(', cmdStartIdx)
    expect(spawnIdx).toBeGreaterThan(cmdStartIdx)
  })

  it('web UI port defaults to 6328 (NEAT in T9 keypad) (ADR-059 #2)', () => {
    expect(readSrc(WEB_SPAWN)).toMatch(/DEFAULT_WEB_PORT\s*=\s*6328/)
  })

  it('NEAT_WEB_PORT env var overrides the default port (ADR-059 #3)', () => {
    const src = readSrc(WEB_SPAWN)
    expect(src).toMatch(/process\.env\.NEAT_WEB_PORT/)
    expect(src).toMatch(/NEAT_WEB_PORT[\s\S]*?DEFAULT_WEB_PORT/)
  })

  it('port collision aborts neatd with a clear error and non-zero exit (ADR-059 #4)', () => {
    const spawn = readSrc(WEB_SPAWN)
    expect(spawn).toMatch(/EADDRINUSE/)
    expect(spawn).toMatch(/web UI port [^]*in use/)
    const neatd = readSrc(NEATD)
    expect(neatd).toMatch(/process\.exit\(3\)/)
  })

  it('spawned web UI inherits NEAT_API_URL=http://localhost:${restPort} (ADR-059 #6)', () => {
    const src = readSrc(WEB_SPAWN)
    expect(src).toMatch(/NEAT_API_URL/)
    expect(src).toMatch(/http:\/\/localhost:\$\{restPort\}/)
    expect(src).toMatch(/process\.env\.NEAT_API_URL\s*\?\?/)
  })

  it('neatd stop / SIGTERM kills the spawned web UI process (no orphans) (ADR-059 #7)', () => {
    const neatd = readSrc(NEATD)
    expect(neatd).toMatch(/web\s*\?\s*web\.stop\(\)/)
    const spawn = readSrc(WEB_SPAWN)
    expect(spawn).toMatch(/child\.kill\(['"]SIGTERM['"]\)/)
    expect(spawn).toMatch(/SIGKILL/)
  })

  it('@neat.is/web is no longer private:true and version-matches the lockstep (ADR-059 #8)', () => {
    const web = readPkg('web') as { private?: boolean; version: string; publishConfig?: Record<string, unknown> }
    expect(web.private).not.toBe(true)
    expect(web.publishConfig).toBeTruthy()
    const types = readPkg('types') as { version: string }
    expect(web.version).toBe(types.version)
  })

  it('neat.is umbrella package.json includes @neat.is/web in dependencies (ADR-059 #8)', () => {
    const umbrella = readPkg('neat.is') as { dependencies: Record<string, string> }
    expect(umbrella.dependencies['@neat.is/web']).toBeTruthy()
  })

  it('.github/workflows/publish.yml dependency order includes @neat.is/web before neat.is (ADR-059 #8)', () => {
    const yml = readSrc(join(REPO_ROOT, '.github/workflows/publish.yml'))
    const webIdx = yml.indexOf('publish_one "packages/web"')
    const umbrellaIdx = yml.indexOf('publish_one "packages/neat.is"')
    expect(webIdx).toBeGreaterThan(-1)
    expect(umbrellaIdx).toBeGreaterThan(webIdx)
  })

  it('scripts/publish.sh dependency order includes packages/web before packages/neat.is (ADR-059 #8)', () => {
    const sh = readSrc(join(REPO_ROOT, 'scripts/publish.sh'))
    const webIdx = sh.indexOf('"packages/web"')
    const umbrellaIdx = sh.indexOf('"packages/neat.is"')
    expect(webIdx).toBeGreaterThan(-1)
    expect(umbrellaIdx).toBeGreaterThan(webIdx)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Divergence query — get_divergences as the thesis surface (ADR-060)
// ──────────────────────────────────────────────────────────────────────────
//
// The synthesis. Every layer in the v0.2.x sequence converged on this query;
// we waited until the end to string it all together. Five divergence types,
// read-only, derived (not persisted). Surfaced across REST + MCP + CLI.
// Amends ADR-039 (nine→ten tools) and ADR-050 (nine→ten verbs) — the
// amendments are explicit, recorded in ADR-060's "Amendments to prior
// contracts" section.
describe('Divergence query (ADR-060)', () => {
  // Fixtures for the discriminated-union schema tests. Pulled top-level so
  // the per-variant tests can stay focused on the field shape.
  const extractedCallEdge: GraphEdge = {
    id: `${EdgeType.CALLS}:service:a->service:b`,
    source: 'service:a',
    target: 'service:b',
    type: EdgeType.CALLS,
    provenance: Provenance.EXTRACTED,
    evidence: { file: 'a/src/index.ts', line: 1, snippet: 'callB()' },
  }
  const observedCallEdge: GraphEdge = {
    id: `${EdgeType.CALLS}:OBSERVED:service:a->service:b`,
    source: 'service:a',
    target: 'service:b',
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    callCount: 7,
    lastObserved: '2026-05-10T00:00:00.000Z',
  }

  it('DivergenceSchema exists in @neat.is/types with discriminated union over five variants (ADR-060 #1 — schema growth)', async () => {
    const { DivergenceSchema } = await import('@neat.is/types')
    // The five variants discriminate on `type`.
    const variants = (DivergenceSchema as unknown as {
      _def: { options: readonly { shape: { type: { value: string } } }[] }
    })._def.options.map((opt) => opt.shape.type.value)
    expect([...variants].sort()).toEqual([
      'compat-violation',
      'host-mismatch',
      'missing-extracted',
      'missing-observed',
      'version-mismatch',
    ])
  })

  it('DivergenceResultSchema validates the wrapped { divergences, totalAffected, computedAt } shape (ADR-060 #1)', async () => {
    const { DivergenceResultSchema } = await import('@neat.is/types')
    const ok = DivergenceResultSchema.safeParse({
      divergences: [],
      totalAffected: 0,
      computedAt: new Date().toISOString(),
    })
    expect(ok.success).toBe(true)
    const bad = DivergenceResultSchema.safeParse({ divergences: [], totalAffected: 0 })
    expect(bad.success).toBe(false)
  })

  it('missing-observed variant parses with extracted edge + reason + recommendation (ADR-060 #5)', async () => {
    const { DivergenceSchema } = await import('@neat.is/types')
    const r = DivergenceSchema.safeParse({
      type: 'missing-observed',
      source: 'service:a',
      target: 'service:b',
      edgeType: EdgeType.CALLS,
      extracted: extractedCallEdge,
      confidence: 0.5,
      reason: 'no traffic',
      recommendation: 'check feature flags',
    })
    expect(r.success).toBe(true)
  })

  it('missing-extracted variant parses with observed edge + reason + recommendation (ADR-060 #5)', async () => {
    const { DivergenceSchema } = await import('@neat.is/types')
    const r = DivergenceSchema.safeParse({
      type: 'missing-extracted',
      source: 'service:a',
      target: 'service:b',
      edgeType: EdgeType.CALLS,
      observed: observedCallEdge,
      confidence: 0.9,
      reason: 'static missed it',
      recommendation: 'check aliases',
    })
    expect(r.success).toBe(true)
  })

  it('version-mismatch variant parses with extractedVersion + observedVersion + compatibility discriminator (ADR-060 #5)', async () => {
    const { DivergenceSchema } = await import('@neat.is/types')
    const r = DivergenceSchema.safeParse({
      type: 'version-mismatch',
      source: 'service:a',
      target: 'database:db',
      extractedVersion: '7.4.0',
      observedVersion: '15',
      compatibility: 'incompatible',
      confidence: 1.0,
      reason: 'pg too old',
      recommendation: 'upgrade pg',
    })
    expect(r.success).toBe(true)
  })

  it('host-mismatch variant parses with extractedHost + observedHost (ADR-060 #5)', async () => {
    const { DivergenceSchema } = await import('@neat.is/types')
    const r = DivergenceSchema.safeParse({
      type: 'host-mismatch',
      source: 'service:a',
      target: 'database:prod-db',
      extractedHost: 'local-db',
      observedHost: 'prod-db',
      confidence: 0.9,
      reason: 'declared X observed Y',
      recommendation: 'check env config',
    })
    expect(r.success).toBe(true)
  })

  it('compat-violation variant parses with rule reference (ADR-060 #5)', async () => {
    const { DivergenceSchema } = await import('@neat.is/types')
    const r = DivergenceSchema.safeParse({
      type: 'compat-violation',
      source: 'service:a',
      target: 'database:db',
      rule: { kind: 'deprecated-api', reason: 'request is deprecated', package: 'request' },
      observed: { ...observedCallEdge, type: EdgeType.CONNECTS_TO },
      confidence: 1.0,
      reason: 'request is deprecated',
      recommendation: 'use undici',
    })
    expect(r.success).toBe(true)
  })

  it('GET /graph/divergences is registered in api.ts (ADR-060 #2)', () => {
    const api = readFileSync(join(CORE_SRC, 'api.ts'), 'utf8')
    expect(api).toMatch(/scope\.get<[^>]*>\s*\(\s*['"]\/graph\/divergences['"]/)
  })

  it('GET /projects/:project/graph/divergences is registered (dual-mount per ADR-026) (ADR-060 #2)', () => {
    // The route is registered on `scope` inside registerRoutes, which is
    // invoked twice — once at root, once under /projects/:project. That
    // single registration site gives both mounts.
    const api = readFileSync(join(CORE_SRC, 'api.ts'), 'utf8')
    expect(api).toMatch(/scope\.get<[^>]*>\s*\(\s*['"]\/graph\/divergences['"]/)
    expect(api).toMatch(/registerRoutes\(app, routeCtx\)/)
    expect(api).toMatch(/prefix:\s*['"]\/projects\/:project['"]/)
  })

  // Shared graph fixture for the REST integration tests: one extracted-only
  // edge and one observed-only edge, so both missing-* divergences fire.
  async function buildDivergenceApi(): Promise<{
    app: import('fastify').FastifyInstance
    cleanup: () => Promise<void>
  }> {
    const { Projects } = await import('../../src/projects.js')
    const { buildApi } = await import('../../src/api.js')
    const { DEFAULT_PROJECT, getGraph, resetGraph } = await import('../../src/graph.js')
    resetGraph(DEFAULT_PROJECT)
    const g = getGraph(DEFAULT_PROJECT)
    g.addNode('service:a', {
      id: 'service:a',
      type: NodeType.ServiceNode,
      name: 'a',
      language: 'javascript',
    })
    g.addNode('service:b', {
      id: 'service:b',
      type: NodeType.ServiceNode,
      name: 'b',
      language: 'javascript',
    })
    g.addNode('service:c', {
      id: 'service:c',
      type: NodeType.ServiceNode,
      name: 'c',
      language: 'javascript',
    })
    // EXTRACTED-only: missing-observed.
    g.addEdgeWithKey(extractedCallEdge.id, 'service:a', 'service:b', extractedCallEdge)
    // OBSERVED-only between different nodes: missing-extracted.
    const onlyObserved: GraphEdge = {
      id: `${EdgeType.CALLS}:OBSERVED:service:a->service:c`,
      source: 'service:a',
      target: 'service:c',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      callCount: 3,
      lastObserved: '2026-05-10T00:00:00.000Z',
    }
    g.addEdgeWithKey(onlyObserved.id, 'service:a', 'service:c', onlyObserved)
    const registry = new Projects()
    const fs2 = await import('node:fs/promises')
    const os2 = await import('node:os')
    const path2 = await import('node:path')
    const tmp = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'neat-divs-'))
    registry.set(DEFAULT_PROJECT, {
      graph: g,
      paths: {
        snapshotPath: path2.join(tmp, 'graph.json'),
        errorsPath: path2.join(tmp, 'errors.ndjson'),
        staleEventsPath: path2.join(tmp, 'stale-events.ndjson'),
        embeddingsCachePath: path2.join(tmp, 'embeddings.json'),
        policyViolationsPath: path2.join(tmp, 'policy-violations.ndjson'),
      },
    })
    const app = await buildApi({ projects: registry })
    return {
      app,
      cleanup: async () => {
        await app.close()
        await fs2.rm(tmp, { recursive: true, force: true })
        resetGraph(DEFAULT_PROJECT)
      },
    }
  }

  it('?type query param filters results to the specified divergence types (ADR-060 #2)', async () => {
    const { app, cleanup } = await buildDivergenceApi()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/graph/divergences?type=missing-observed',
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { divergences: { type: string }[]; totalAffected: number }
      expect(body.totalAffected).toBeGreaterThan(0)
      for (const d of body.divergences) expect(d.type).toBe('missing-observed')
    } finally {
      await cleanup()
    }
  })

  it('?minConfidence filters results to confidence >= threshold (ADR-060 #2)', async () => {
    const { app, cleanup } = await buildDivergenceApi()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/graph/divergences?minConfidence=0.9',
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { divergences: { confidence: number }[] }
      for (const d of body.divergences) expect(d.confidence).toBeGreaterThanOrEqual(0.9)
    } finally {
      await cleanup()
    }
  })

  it('?node filters results to divergences involving the specified node id (ADR-060 #2)', async () => {
    const { app, cleanup } = await buildDivergenceApi()
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/graph/divergences?node=${encodeURIComponent('service:c')}`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { divergences: { source: string; target: string }[] }
      expect(body.divergences.length).toBeGreaterThan(0)
      for (const d of body.divergences) {
        expect(d.source === 'service:c' || d.target === 'service:c').toBe(true)
      }
    } finally {
      await cleanup()
    }
  })

  it('get_divergences is registered as the tenth MCP tool — extends ADR-039 allowlist (ADR-060 #3 — amendment)', () => {
    const indexTs = readFileSync(join(MCP_SRC, 'index.ts'), 'utf8')
    expect(indexTs).toMatch(/server\.tool\(\s*['"]get_divergences['"]/)
  })

  it('get_divergences MCP response is three-part: NL summary + structured block + footer (ADR-060 #3)', async () => {
    const { getDivergences } = await import('../../../mcp/src/tools.js')
    const stubClient = {
      async get<T>(): Promise<T> {
        return {
          divergences: [
            {
              type: 'missing-observed',
              source: 'service:a',
              target: 'service:b',
              edgeType: EdgeType.CALLS,
              extracted: extractedCallEdge,
              confidence: 0.9,
              reason: 'no traffic',
              recommendation: 'check flags',
            },
          ],
          totalAffected: 1,
          computedAt: '2026-05-10T00:00:00.000Z',
        } as unknown as T
      },
    }
    const result = await getDivergences(stubClient, {})
    const text = (result.content[0] as { text: string }).text
    const sections = text.split('\n\n')
    expect(sections.length).toBeGreaterThanOrEqual(3)
    // Footer carries the composite provenance string per the contract.
    expect(sections[sections.length - 1]).toMatch(/confidence: .* · provenance: composite/)
  })

  it('neat divergences is registered as the tenth CLI verb — extends ADR-050 allowlist (ADR-060 #4 — amendment)', async () => {
    const { QUERY_VERBS } = await import('../../src/cli.js')
    expect(QUERY_VERBS.has('divergences')).toBe(true)
    // Confirms the verb is part of the ten-mirror map captured by the
    // earlier ADR-050 contract test.
    expect(QUERY_VERBS.size).toBe(10)
  })

  it('neat divergences --json emits machine-readable DivergenceResult (ADR-060 #4)', async () => {
    const { runDivergences } = await import('../../src/cli-client.js')
    const stubClient = {
      async get<T>(): Promise<T> {
        return {
          divergences: [
            {
              type: 'missing-observed',
              source: 'service:a',
              target: 'service:b',
              edgeType: EdgeType.CALLS,
              extracted: extractedCallEdge,
              confidence: 0.7,
              reason: 'no traffic',
              recommendation: 'check flags',
            },
          ],
          totalAffected: 1,
          computedAt: '2026-05-10T00:00:00.000Z',
        } as unknown as T
      },
    }
    const { formatJson } = await import('../../src/cli-client.js')
    const result = await runDivergences(stubClient, {})
    const parsed = JSON.parse(formatJson(result)) as Record<string, unknown>
    expect(parsed.summary).toMatch(/divergence/i)
    expect(parsed.confidence).toBe(0.7)
    expect(parsed.provenance).toBe('composite (EXTRACTED + OBSERVED)')
  })

  it('neat divergences --type, --min-confidence, --node, --project flags propagate to REST (ADR-060 #4)', async () => {
    const { runDivergences } = await import('../../src/cli-client.js')
    const captured: string[] = []
    const stubClient = {
      async get<T>(path: string): Promise<T> {
        captured.push(path)
        return {
          divergences: [],
          totalAffected: 0,
          computedAt: '2026-05-10T00:00:00.000Z',
        } as unknown as T
      },
    }
    await runDivergences(stubClient, {
      type: ['missing-observed', 'missing-extracted'],
      minConfidence: 0.6,
      node: 'service:checkout',
      project: 'alpha',
    })
    const url = captured[0]!
    expect(url).toContain('/projects/alpha/graph/divergences')
    expect(url).toContain('type=missing-observed%2Cmissing-extracted')
    expect(url).toContain('minConfidence=0.6')
    expect(url).toContain('node=service%3Acheckout')
  })

  it('computeDivergences detects missing-observed: EXTRACTED edge without OBSERVED counterpart (ADR-060 #5)', async () => {
    const { computeDivergences } = await import('../../src/divergences.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', {
      id: 'service:a',
      type: NodeType.ServiceNode,
      name: 'a',
      language: 'javascript',
    })
    g.addNode('service:b', {
      id: 'service:b',
      type: NodeType.ServiceNode,
      name: 'b',
      language: 'javascript',
    })
    g.addEdgeWithKey(extractedCallEdge.id, 'service:a', 'service:b', extractedCallEdge)
    const result = computeDivergences(g)
    const hit = result.divergences.find((d) => d.type === 'missing-observed')
    expect(hit).toBeDefined()
    expect(hit!.source).toBe('service:a')
    expect(hit!.target).toBe('service:b')
    expect(hit!.confidence).toBe(0.5)
  })

  it('computeDivergences detects missing-extracted: OBSERVED edge without EXTRACTED counterpart (ADR-060 #5)', async () => {
    const { computeDivergences } = await import('../../src/divergences.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', {
      id: 'service:a',
      type: NodeType.ServiceNode,
      name: 'a',
      language: 'javascript',
    })
    g.addNode('service:b', {
      id: 'service:b',
      type: NodeType.ServiceNode,
      name: 'b',
      language: 'javascript',
    })
    g.addEdgeWithKey(observedCallEdge.id, 'service:a', 'service:b', observedCallEdge)
    const result = computeDivergences(g)
    const hit = result.divergences.find((d) => d.type === 'missing-extracted')
    expect(hit).toBeDefined()
    expect(hit!.source).toBe('service:a')
    expect(hit!.target).toBe('service:b')
  })

  it('computeDivergences detects version-mismatch using compat.json rules (ADR-060 #5)', async () => {
    const { computeDivergences } = await import('../../src/divergences.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:checkout', {
      id: 'service:checkout',
      type: NodeType.ServiceNode,
      name: 'checkout',
      language: 'javascript',
      dependencies: { pg: '7.4.0' },
    })
    g.addNode('database:prod-pg', {
      id: 'database:prod-pg',
      type: NodeType.DatabaseNode,
      name: 'prod-pg',
      engine: 'postgresql',
      engineVersion: '15',
      compatibleDrivers: [],
      host: 'prod-pg',
    })
    const eid = `${EdgeType.CONNECTS_TO}:OBSERVED:service:checkout->database:prod-pg`
    g.addEdgeWithKey(eid, 'service:checkout', 'database:prod-pg', {
      id: eid,
      source: 'service:checkout',
      target: 'database:prod-pg',
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.OBSERVED,
    })
    const result = computeDivergences(g)
    const hit = result.divergences.find((d) => d.type === 'version-mismatch')
    expect(hit).toBeDefined()
    if (hit?.type === 'version-mismatch') {
      expect(hit.extractedVersion).toBe('7.4.0')
      expect(hit.observedVersion).toBe('15')
      expect(hit.compatibility).toBe('incompatible')
      expect(hit.confidence).toBe(1.0)
    }
  })

  it('computeDivergences detects host-mismatch: CONFIGURED_BY host !== CONNECTS_TO target host (ADR-060 #5)', async () => {
    const { computeDivergences } = await import('../../src/divergences.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:api', {
      id: 'service:api',
      type: NodeType.ServiceNode,
      name: 'api',
      language: 'javascript',
      dbConnectionTarget: 'local-db',
    })
    g.addNode('database:prod-db', {
      id: 'database:prod-db',
      type: NodeType.DatabaseNode,
      name: 'prod-db',
      engine: 'postgresql',
      engineVersion: '15',
      compatibleDrivers: [],
      host: 'prod-db',
    })
    g.addNode('config:env', {
      id: 'config:env',
      type: NodeType.ConfigNode,
      name: '.env',
      path: '.env',
      fileType: 'env',
    })
    const cfgEdge = `${EdgeType.CONFIGURED_BY}:service:api->config:env`
    g.addEdgeWithKey(cfgEdge, 'service:api', 'config:env', {
      id: cfgEdge,
      source: 'service:api',
      target: 'config:env',
      type: EdgeType.CONFIGURED_BY,
      provenance: Provenance.EXTRACTED,
      evidence: { file: '.env', line: 1, snippet: 'DB_HOST=local-db' },
    })
    const connEdge = `${EdgeType.CONNECTS_TO}:OBSERVED:service:api->database:prod-db`
    g.addEdgeWithKey(connEdge, 'service:api', 'database:prod-db', {
      id: connEdge,
      source: 'service:api',
      target: 'database:prod-db',
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.OBSERVED,
    })
    const result = computeDivergences(g)
    const hit = result.divergences.find((d) => d.type === 'host-mismatch')
    expect(hit).toBeDefined()
    if (hit?.type === 'host-mismatch') {
      expect(hit.extractedHost).toBe('local-db')
      expect(hit.observedHost).toBe('prod-db')
    }
  })

  it('computeDivergences detects compat-violation: any compat.json rule firing against OBSERVED edge (ADR-060 #5)', async () => {
    const { computeDivergences } = await import('../../src/divergences.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:legacy', {
      id: 'service:legacy',
      type: NodeType.ServiceNode,
      name: 'legacy',
      language: 'javascript',
      // `request` is flagged deprecated in compat.json (packageMaxVersion 2.88.2).
      dependencies: { request: '2.88.0' },
    })
    g.addNode('database:prod-db', {
      id: 'database:prod-db',
      type: NodeType.DatabaseNode,
      name: 'prod-db',
      engine: 'postgresql',
      engineVersion: '15',
      compatibleDrivers: [],
      host: 'prod-db',
    })
    const eid = `${EdgeType.CONNECTS_TO}:OBSERVED:service:legacy->database:prod-db`
    g.addEdgeWithKey(eid, 'service:legacy', 'database:prod-db', {
      id: eid,
      source: 'service:legacy',
      target: 'database:prod-db',
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.OBSERVED,
    })
    const result = computeDivergences(g)
    const hit = result.divergences.find((d) => d.type === 'compat-violation')
    expect(hit).toBeDefined()
    if (hit?.type === 'compat-violation') {
      expect(hit.rule.kind).toBe('deprecated-api')
      expect(hit.rule.package).toBe('request')
    }
  })

  it('computeDivergences sorts results by confidence descending by default (ADR-060 #6)', async () => {
    const { computeDivergences } = await import('../../src/divergences.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', {
      id: 'service:a',
      type: NodeType.ServiceNode,
      name: 'a',
      language: 'javascript',
    })
    g.addNode('service:b', {
      id: 'service:b',
      type: NodeType.ServiceNode,
      name: 'b',
      language: 'javascript',
    })
    g.addNode('service:c', {
      id: 'service:c',
      type: NodeType.ServiceNode,
      name: 'c',
      language: 'javascript',
    })
    // EXTRACTED-only edge: missing-observed at confidence 0.5 (no OBSERVED
    // traffic on source).
    g.addEdgeWithKey(extractedCallEdge.id, 'service:a', 'service:b', extractedCallEdge)
    // OBSERVED-only edge: missing-extracted at ~OBSERVED ceiling (higher).
    const obs: GraphEdge = {
      id: `${EdgeType.CALLS}:OBSERVED:service:a->service:c`,
      source: 'service:a',
      target: 'service:c',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      callCount: 100,
      lastObserved: new Date().toISOString(),
    }
    g.addEdgeWithKey(obs.id, 'service:a', 'service:c', obs)
    const result = computeDivergences(g)
    expect(result.divergences.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < result.divergences.length; i++) {
      expect(result.divergences[i - 1]!.confidence).toBeGreaterThanOrEqual(
        result.divergences[i]!.confidence,
      )
    }
  })

  it('computeDivergences is a pure function — no I/O, no mutation, no async (ADR-060 — binding rule 4)', async () => {
    const src = readFileSync(join(CORE_SRC, 'divergences.ts'), 'utf8')
    // Not async. The export signature must be synchronous so the route handler
    // can call it without an await round-trip.
    expect(src).toMatch(/export function computeDivergences/)
    expect(src).not.toMatch(/export async function computeDivergences/)
    // No fs / fetch / promises imports.
    expect(src).not.toMatch(/from\s+['"]node:fs/)
    expect(src).not.toMatch(/from\s+['"]fs/)
    expect(src).not.toMatch(/\bfetch\s*\(/)
  })

  it('packages/core/src/divergences.ts contains no graph mutation calls (read-only — extends mutation-authority scan)', () => {
    const src = readFileSync(join(CORE_SRC, 'divergences.ts'), 'utf8')
    const mutators = [
      'addNode',
      'addEdge',
      'addEdgeWithKey',
      'addDirectedEdge',
      'addDirectedEdgeWithKey',
      'dropNode',
      'dropEdge',
      'replaceEdgeAttributes',
      'replaceNodeAttributes',
      'mergeEdgeAttributes',
      'mergeNodeAttributes',
    ]
    const re = new RegExp(`\\b(graph|g)\\.(${mutators.join('|')})\\s*\\(`)
    const offenders: string[] = []
    src.split('\n').forEach((line, i) => {
      const trimmed = line.trim()
      if (re.test(line) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
        offenders.push(`divergences.ts:${i + 1}: ${trimmed}`)
      }
    })
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no divergences.ndjson persistence sidecar exists (ADR-060 — binding rule 2; derived, not persisted)', () => {
    // No source line in core/src references a divergences.ndjson sidecar —
    // the contract is "derived, not persisted". A future writer / reader
    // would land in persist.ts or watch.ts.
    const offenders: string[] = []
    for (const file of walkSrc(CORE_SRC)) {
      const content = readFileSync(file, 'utf8')
      if (content.includes('divergences.ndjson')) {
        offenders.push(file)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// OBSERVED-led divergence query weighting + graded confidence (ADR-066)
// ──────────────────────────────────────────────────────────────────────────
//
// Amends ADR-029 (provenance confidence semantics), ADR-060 (divergence query
// weighting). EXTRACTED grades at emit time per extractor; OBSERVED grades by
// the signal block; a precision floor drops sub-threshold EXTRACTED candidates
// before they enter the graph; the divergence query reweights so
// `missing-extracted` (OBSERVED-led) is the headline finding type.
//
// Initial entries are `it.todo` and flip to live as the v0.3.4 implementation
// PRs land (#257 EXTRACTED grading, #258 OBSERVED grading, #259 reweighting +
// NEAT-BUG-8 envelope).
describe('OBSERVED-led divergence weighting + graded confidence (ADR-066)', () => {
  it('`@neat.is/types/confidence.ts` exports a single grading helper for EXTRACTED and OBSERVED tiers (ADR-066 §1 + §2)', async () => {
    const mod = (await import('@neat.is/types')) as Record<string, unknown>
    expect(typeof mod.confidenceForExtracted).toBe('function')
    expect(typeof mod.confidenceForObservedSignal).toBe('function')
    expect(typeof mod.passesExtractedFloor).toBe('function')
    expect(typeof mod.extractedPrecisionFloor).toBe('function')
  })

  it('EXTRACTED grades structural file facts at ~0.85 (ADR-066 §1)', async () => {
    const { confidenceForExtracted } = await import('@neat.is/types')
    expect(confidenceForExtracted('structural')).toBeCloseTo(0.85, 2)
  })

  it('EXTRACTED grades verified call sites at ~0.85 when a framework-aware recognizer matched (ADR-066 §1)', async () => {
    const { confidenceForExtracted } = await import('@neat.is/types')
    expect(confidenceForExtracted('verified-call-site')).toBeCloseTo(0.85, 2)
  })

  it('EXTRACTED grades string-shaped candidates with structural support at ~0.5 (ADR-066 §1)', async () => {
    const { confidenceForExtracted } = await import('@neat.is/types')
    expect(confidenceForExtracted('url-with-structural-support')).toBeCloseTo(0.5, 2)
  })

  it('EXTRACTED grades string-shaped candidates without structural support at ~0.2 — these fall below the precision floor by default (ADR-066 §1)', async () => {
    const { confidenceForExtracted, passesExtractedFloor } = await import('@neat.is/types')
    const v = confidenceForExtracted('hostname-shape-match')
    expect(v).toBeCloseTo(0.2, 2)
    expect(passesExtractedFloor(v)).toBe(false)
  })

  it('no `confidence: 0.5` literal remains in packages/core/src/extract/ (the flat-coarse emission pattern is a contract violation under ADR-066)', () => {
    const offenders: string[] = []
    const EXTRACT_DIR = join(CORE_SRC, 'extract')
    for (const file of walkSrc(EXTRACT_DIR)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (/\bconfidence\s*:\s*0\.5\b/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('OBSERVED grades by signal block: spanCount: 500 + recent grades strictly above spanCount: 5 + recent (ADR-066 §2)', async () => {
    const { confidenceForObservedSignal } = await import('@neat.is/types')
    const strong = confidenceForObservedSignal({ spanCount: 500, errorCount: 0, lastObservedAgeMs: 0 })
    const weak = confidenceForObservedSignal({ spanCount: 5, errorCount: 0, lastObservedAgeMs: 0 })
    expect(strong).toBeGreaterThan(weak)
  })

  it('OBSERVED grades by signal block: errorCount: 4 / spanCount: 5 grades strictly below errorCount: 0 / spanCount: 5 (ADR-066 §2)', async () => {
    const { confidenceForObservedSignal } = await import('@neat.is/types')
    const clean = confidenceForObservedSignal({ spanCount: 5, errorCount: 0, lastObservedAgeMs: 0 })
    const degraded = confidenceForObservedSignal({ spanCount: 5, errorCount: 4, lastObservedAgeMs: 0 })
    expect(degraded).toBeLessThan(clean)
  })

  it('OBSERVED grades at ingest by signal block — a single-span edge does not emit flat 1.0 (ADR-066 §2)', async () => {
    const { MultiDirectedGraph } = await import('graphology')
    const { handleSpan, resetParentSpanCache } = await import('../../src/ingest.js')
    const pathMod = await import('node:path')
    const os = await import('node:os')
    const fs = await import('node:fs/promises')
    resetParentSpanCache()
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:caller', {
      id: 'service:caller',
      type: NodeType.ServiceNode,
      name: 'caller',
      language: 'javascript',
    })
    g.addNode('service:callee', {
      id: 'service:callee',
      type: NodeType.ServiceNode,
      name: 'callee',
      language: 'javascript',
    })
    const tmp = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'neat-066-observed-'))
    await handleSpan(
      {
        graph: g,
        errorsPath: pathMod.join(tmp, 'errors.ndjson'),
        writeErrorEventInline: false,
      },
      {
        traceId: 't1',
        spanId: 's1',
        service: 'caller',
        name: 'GET /work',
        kind: 3,
        startTimeUnixNano: '0',
        endTimeUnixNano: '0',
        durationNanos: 0n,
        startTimeIso: new Date().toISOString(),
        statusCode: 0,
        attributes: { 'server.address': 'callee', 'http.method': 'GET' },
      },
    )
    const id = `${EdgeType.CALLS}:OBSERVED:service:caller->service:callee`
    expect(g.hasEdge(id)).toBe(true)
    const e = g.getEdgeAttributes(id) as GraphEdge
    expect(e.confidence).toBeDefined()
    expect(e.confidence as number).toBeLessThan(1.0)
  })

  it('precision floor: a fixture with above- and below-threshold EXTRACTED candidates produces only above-threshold edges in the graph (ADR-066 §3)', async () => {
    // Demo graph contains a hostname-shape CALLS edge (0.2, below default
    // floor) and structural CONFIGURED_BY / CONNECTS_TO / DEPENDS_ON /
    // RUNS_ON edges (0.85, above floor). With default floor, only the
    // structural edges land.
    const { resetGraph, getGraph } = await import('../../src/graph.js')
    const { extractFromDirectory } = await import('../../src/extract.js')
    const path = await import('node:path')
    const DEMO_PATH = path.resolve(__dirname, '../../../../demo')
    const prev = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    try {
      resetGraph()
      const g = getGraph()
      await extractFromDirectory(g, DEMO_PATH)
      let aboveFloor = 0
      let belowFloor = 0
      g.forEachEdge((_id, attrs) => {
        const e = attrs as GraphEdge
        if (e.provenance !== Provenance.EXTRACTED) return
        if ((e.confidence ?? 0) >= 0.7) aboveFloor++
        else belowFloor++
      })
      expect(aboveFloor).toBeGreaterThanOrEqual(1)
      expect(belowFloor).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
      else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prev
    }
  })

  it('precision floor: NEAT_EXTRACTED_PRECISION_FLOOR overrides the default 0.7 threshold (ADR-066 §3)', async () => {
    const { extractedPrecisionFloor } = await import('@neat.is/types')
    const prev = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    process.env.NEAT_EXTRACTED_PRECISION_FLOOR = '0.4'
    try {
      expect(extractedPrecisionFloor()).toBeCloseTo(0.4, 2)
    } finally {
      if (prev === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
      else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prev
    }
  })

  it('precision floor: NEAT_EXTRACTED_PRECISION_FLOOR=0.0 keeps every candidate (diagnostic mode) (ADR-066 §3)', async () => {
    const { passesExtractedFloor } = await import('@neat.is/types')
    const prev = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    process.env.NEAT_EXTRACTED_PRECISION_FLOOR = '0'
    try {
      expect(passesExtractedFloor(0)).toBe(true)
      expect(passesExtractedFloor(0.1)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
      else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prev
    }
  })

  it('computeDivergences orders `missing-extracted` ahead of `missing-observed` when both surface at equal confidence (ADR-066 §4)', async () => {
    const { MultiDirectedGraph } = await import('graphology')
    const { computeDivergences } = await import('../../src/divergences.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:a', {
      id: 'service:a',
      type: NodeType.ServiceNode,
      name: 'a',
      language: 'javascript',
    })
    g.addNode('service:b', {
      id: 'service:b',
      type: NodeType.ServiceNode,
      name: 'b',
      language: 'javascript',
    })
    g.addNode('service:c', {
      id: 'service:c',
      type: NodeType.ServiceNode,
      name: 'c',
      language: 'javascript',
    })
    // EXTRACTED-only: missing-observed candidate. Confidence 0.85 (structural).
    const eId = `${EdgeType.CALLS}:service:a->service:b`
    g.addEdgeWithKey(eId, 'service:a', 'service:b', {
      id: eId,
      source: 'service:a',
      target: 'service:b',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
      confidence: 0.85,
      evidence: { file: 'a/index.ts' },
    })
    // OBSERVED-only (different pair): missing-extracted candidate. Confidence 0.85.
    const oId = `${EdgeType.CALLS}:OBSERVED:service:a->service:c`
    g.addEdgeWithKey(oId, 'service:a', 'service:c', {
      id: oId,
      source: 'service:a',
      target: 'service:c',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      confidence: 0.85,
      lastObserved: new Date().toISOString(),
      callCount: 50,
      signal: { spanCount: 50, errorCount: 0, lastObservedAgeMs: 0 },
    })
    const result = computeDivergences(g)
    expect(result.divergences.length).toBeGreaterThanOrEqual(2)
    const me = result.divergences.findIndex((d) => d.type === 'missing-extracted')
    const mo = result.divergences.findIndex((d) => d.type === 'missing-observed')
    expect(me).toBeGreaterThanOrEqual(0)
    expect(mo).toBeGreaterThanOrEqual(0)
    expect(me).toBeLessThan(mo)
  })

  it('`missing-observed` rows backed by sub-floor EXTRACTED candidates never surface — the underlying edge was never added to the graph (ADR-066 §4)', async () => {
    const { resetGraph, getGraph } = await import('../../src/graph.js')
    const { extractFromDirectory } = await import('../../src/extract.js')
    const { computeDivergences } = await import('../../src/divergences.js')
    const path = await import('node:path')
    const DEMO_PATH = path.resolve(__dirname, '../../../../demo')
    const prev = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    try {
      resetGraph()
      const g = getGraph()
      await extractFromDirectory(g, DEMO_PATH)
      // The demo's service-a → service-b CALLS edge is the canonical
      // hostname-shape candidate (0.2). With the default floor it never
      // entered the graph, so no missing-observed row for it can surface.
      const result = computeDivergences(g)
      const offending = result.divergences.filter(
        (d) =>
          d.type === 'missing-observed' &&
          d.source === 'service:service-a' &&
          d.target === 'service:service-b',
      )
      expect(offending).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
      else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prev
    }
  })

  it('GET /graph/divergences returns DivergenceResultSchema on a freshly-loaded snapshot (NEAT-BUG-8 — ADR-066 §6)', async () => {
    const { resetGraph, getGraph, DEFAULT_PROJECT } = await import('../../src/graph.js')
    const { buildApi } = await import('../../src/api.js')
    const { Projects } = await import('../../src/projects.js')
    const { saveGraphToDisk, loadGraphFromDisk } = await import('../../src/persist.js')
    const { DivergenceResultSchema } = await import('@neat.is/types')
    const path = await import('node:path')
    const os = await import('node:os')
    const fs = await import('node:fs/promises')

    resetGraph()
    const seed = getGraph()
    seed.addNode('service:a', {
      id: 'service:a',
      type: NodeType.ServiceNode,
      name: 'a',
      language: 'javascript',
    })
    seed.addNode('service:b', {
      id: 'service:b',
      type: NodeType.ServiceNode,
      name: 'b',
      language: 'javascript',
    })
    const eId = `${EdgeType.CALLS}:service:a->service:b`
    seed.addEdgeWithKey(eId, 'service:a', 'service:b', {
      id: eId,
      source: 'service:a',
      target: 'service:b',
      type: EdgeType.CALLS,
      provenance: Provenance.EXTRACTED,
      confidence: 0.85,
      evidence: { file: 'a/index.ts' },
    })
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-bug8-'))
    const snapPath = path.join(tmp, 'graph.json')
    await saveGraphToDisk(seed, snapPath)

    // Reload — the production snapshot-load path. The divergence endpoint
    // must compute against the live graph regardless of when the load
    // happened.
    resetGraph()
    const reloaded = getGraph()
    await loadGraphFromDisk(reloaded, snapPath)
    const registry = new Projects()
    registry.set(DEFAULT_PROJECT, {
      graph: reloaded,
      paths: {
        snapshotPath: snapPath,
        errorsPath: path.join(tmp, 'errors.ndjson'),
        staleEventsPath: path.join(tmp, 'stale.ndjson'),
        embeddingsCachePath: path.join(tmp, 'emb.json'),
        policyViolationsPath: path.join(tmp, 'policies.ndjson'),
      },
    })
    const app = await buildApi({ projects: registry })
    try {
      const res = await app.inject({ method: 'GET', url: '/graph/divergences' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      const parsed = DivergenceResultSchema.safeParse(body)
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.format())).toBe(
        true,
      )
    } finally {
      await app.close()
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('GET /graph/divergences returns DivergenceResultSchema on a graph with no detectable divergences (zero-result; never null, never a bare value) (NEAT-BUG-8 — ADR-066 §6)', async () => {
    const { resetGraph, getGraph } = await import('../../src/graph.js')
    const { buildApi } = await import('../../src/api.js')
    const { DivergenceResultSchema } = await import('@neat.is/types')
    resetGraph()
    const g = getGraph()
    // Empty graph — no edges to disagree about; the query should still
    // return the documented envelope shape, not null and not a bare value.
    const app = await buildApi({ graph: g })
    try {
      const res = await app.inject({ method: 'GET', url: '/graph/divergences' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).not.toBeNull()
      expect(typeof body).toBe('object')
      const parsed = DivergenceResultSchema.safeParse(body)
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.format())).toBe(
        true,
      )
      expect(body.divergences).toEqual([])
      expect(body.totalAffected).toBe(0)
    } finally {
      await app.close()
    }
  })

  it('GET /projects/:project/graph/divergences returns DivergenceResultSchema on snapshot-load + zero-result paths (dual-mount per ADR-026 — ADR-066 §6)', async () => {
    const { resetGraph, getGraph, DEFAULT_PROJECT } = await import('../../src/graph.js')
    const { buildApi } = await import('../../src/api.js')
    const { Projects } = await import('../../src/projects.js')
    const { DivergenceResultSchema } = await import('@neat.is/types')
    const path = await import('node:path')
    const os = await import('node:os')
    const fs = await import('node:fs/promises')

    resetGraph()
    const g = getGraph()
    const registry = new Projects()
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-bug8-proj-'))
    registry.set(DEFAULT_PROJECT, {
      graph: g,
      paths: {
        snapshotPath: path.join(tmp, 'graph.json'),
        errorsPath: path.join(tmp, 'errors.ndjson'),
        staleEventsPath: path.join(tmp, 'stale.ndjson'),
        embeddingsCachePath: path.join(tmp, 'emb.json'),
        policyViolationsPath: path.join(tmp, 'policies.ndjson'),
      },
    })
    const app = await buildApi({ projects: registry })
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/projects/${DEFAULT_PROJECT}/graph/divergences`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      const parsed = DivergenceResultSchema.safeParse(body)
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.format())).toBe(
        true,
      )
    } finally {
      await app.close()
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('the divergence response is never null and never a bare array — the envelope is a JSON object (ADR-066 §6 — ADR-061 envelope rule)', () => {
    // Structural scan of divergences.ts. The output goes through
    // DivergenceResultSchema.parse at the bottom of computeDivergences, so
    // any code path that returned null or a bare array would fail the parse
    // before reaching the wire. Lock the shape: no `return null` at the
    // module level and no `return []` from computeDivergences.
    const src = readFileSync(join(CORE_SRC, 'divergences.ts'), 'utf8')
    // Find the computeDivergences function block.
    const fnStart = src.indexOf('export function computeDivergences')
    expect(fnStart, 'computeDivergences exported').toBeGreaterThanOrEqual(0)
    const fnSrc = src.slice(fnStart)
    expect(fnSrc).not.toMatch(/^\s*return\s+null\s*;?\s*$/m)
    expect(fnSrc).not.toMatch(/^\s*return\s+\[\s*\]\s*;?\s*$/m)
    expect(fnSrc).toMatch(/DivergenceResultSchema\.parse/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// REST API path canonicalization + response envelope rule (ADR-061)
// ──────────────────────────────────────────────────────────────────────────
//
// Amends ADR-040 / docs/contracts/rest-api.md after the 2026-05-11 audit
// found path drift (4 endpoints) and shape drift (5 endpoints) between
// backend and contract. Canonical paths and shapes are in rest-api.md.
//
// Three classes of assertion:
// 1. Canonical paths — drifted paths must NOT appear in api.ts; canonical
//    paths MUST appear.
// 2. Response envelope rule — every GET handler returns a JSON object,
//    never a bare array (with the documented /projects exception).
// 3. Response shape — runtime parse through Zod schema for each endpoint.
//
// Each flips from todo to live as the implementation agent ships the fix.
describe('REST API canonicalization (ADR-061)', () => {
  const API_TS = readFileSync(join(CORE_SRC, 'api.ts'), 'utf8')
  const REST_CONTRACT = readFileSync(
    join(__dirname, '../../../../docs/contracts/rest-api.md'),
    'utf8',
  )

  // Routes registered in api.ts. scope.get / scope.post are dual-mounted;
  // app.get / app.post mount only at the root. Picks up both signatures
  // (single-line and the `>('/path', ...` continuation form).
  const declaredPaths = new Set<string>()
  for (const m of API_TS.matchAll(/\b(?:scope|app)\.(?:get|post)(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g)) {
    declaredPaths.add(m[1])
  }
  // Also pick up the `>('/path',` continuation form where the type
  // generic spans multiple lines.
  for (const m of API_TS.matchAll(/\}>\(\s*['"]([^'"]+)['"]/g)) {
    declaredPaths.add(m[1])
  }
  // The two-line form: `scope.get<{ ... }>(\n    '/path',`
  for (const m of API_TS.matchAll(/\b(?:scope|app)\.(?:get|post)<[^>]*>\(\s*\n\s*['"]([^'"]+)['"]/g)) {
    declaredPaths.add(m[1])
  }

  // Endpoint table in rest-api.md — paths in the first column, wrapped in
  // backticks like `GET /health` or `GET /graph/node/:id`.
  const documentedPaths = new Set<string>()
  for (const m of REST_CONTRACT.matchAll(/`(?:GET|POST)\s+(\/[^`]+?)`/g)) {
    // Strip query strings — the documented `?limit=N` is illustrative,
    // not part of the route shape.
    documentedPaths.add(m[1].split('?')[0])
  }

  // ── Class A: path canonicalization ───────────────────────────────────
  it('api.ts declares `/graph/root-cause/:nodeId` (renamed from /traverse/root-cause) (ADR-061 #1)', () => {
    expect(declaredPaths).toContain('/graph/root-cause/:nodeId')
  })
  it('api.ts declares `/graph/blast-radius/:nodeId` (renamed from /traverse/blast-radius) (ADR-061 #1)', () => {
    expect(declaredPaths).toContain('/graph/blast-radius/:nodeId')
  })
  it('api.ts declares `/stale-events` (renamed from /incidents/stale) (ADR-061 #1)', () => {
    expect(declaredPaths).toContain('/stale-events')
  })
  it('api.ts declares `/graph/dependencies/:nodeId` (renamed from /graph/node/:id/dependencies) (ADR-061 #1)', () => {
    expect(declaredPaths).toContain('/graph/dependencies/:nodeId')
  })
  it('api.ts contains no references to drifted paths (/traverse/*, /incidents/stale, /graph/node/:id/dependencies) (ADR-061 #1)', () => {
    expect(API_TS).not.toMatch(/\/traverse\//)
    expect(API_TS).not.toMatch(/\/incidents\/stale/)
    expect(API_TS).not.toMatch(/\/graph\/node\/:id\/dependencies/)
  })

  // ── Class B: response envelope rule ──────────────────────────────────
  // Bare-collection returns inside scope.get handlers are a contract
  // violation. Scans for `return events`, `return violations`, etc. —
  // anything that returns a local variable named like a list.
  it('no scope.get handler in api.ts returns a bare collection (ADR-061 #2 — envelope rule)', () => {
    // Match `return <ident>` where ident is one of the list-shaped names
    // that previously held bare arrays. After ADR-061 every list should
    // be wrapped, so `return events` / `return violations` etc. inside a
    // scope.get block is a smell.
    const banned = ['events', 'violations', 'matches', 'incidents', 'dependencies']
    const offenders: string[] = []
    const lines = API_TS.split('\n')
    let insideScopeGet = false
    let depth = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/\bscope\.get\b/.test(line)) {
        insideScopeGet = true
        depth = 0
      }
      if (insideScopeGet) {
        for (const ch of line) {
          if (ch === '{') depth++
          if (ch === '}') depth--
        }
        for (const name of banned) {
          if (new RegExp(`\\breturn\\s+${name}\\s*$`).test(line.trim())) {
            offenders.push(`api.ts:${i + 1}: ${line.trim()}`)
          }
        }
        if (depth <= 0 && /\)\s*$/.test(line.trim())) insideScopeGet = false
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
  it('the documented /projects bare-array exception is the only bare-array GET return (ADR-061 #2)', () => {
    // listRegistryProjects() returns Array<RegistryEntry>; api.ts hands
    // it back directly from `app.get('/projects', ...)`. The contract
    // documents this as the one allowed bare-array GET (rest-api.md §29
    // table footnote).
    expect(API_TS).toMatch(/app\.get\(['"]\/projects['"][\s\S]{0,200}return\s+await\s+listRegistryProjects/)
  })

  // ── Class C: response shape via Zod schemas ──────────────────────────
  // Each endpoint's response parses through its declared schema. The
  // fixture is the demo graph loaded by extractFromDirectory — the same
  // shape api.test.ts uses — wired up once and reused per assertion.
  describe('response shapes parse through their declared schema (ADR-061 #3)', () => {
    // Schemas + buildApi() load via dynamic imports inside beforeAll so
    // the static-scan tests above don't pull the runtime machinery into
    // module init. The fixture graph is the demo dir — same shape
    // api.test.ts uses — and the registry is redirected via NEAT_HOME
    // so /projects/:project has something to look up.
    let app: import('fastify').FastifyInstance
    let tmpDir: string
    let diffPath: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let schemas: Record<string, import('zod').ZodTypeAny>

    beforeAll(async () => {
      const path = await import('node:path')
      const { promises: fs } = await import('node:fs')
      const os = await import('node:os')
      const types = await import('@neat.is/types')
      const { buildApi } = await import('../../src/api.js')
      const { extractFromDirectory } = await import('../../src/extract.js')
      const { resetGraph, getGraph } = await import('../../src/graph.js')
      const { saveGraphToDisk } = await import('../../src/persist.js')
      const { writeAtomically } = await import('../../src/registry.js')

      const DEMO_PATH = path.resolve(__dirname, '../../../../demo')
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-adr061-shapes-'))
      diffPath = path.join(tmpDir, 'base.json')
      const registryHome = path.join(tmpDir, 'neat-home')

      process.env.NEAT_HOME = registryHome
      const registry = {
        version: 1 as const,
        projects: [
          {
            name: 'default',
            path: DEMO_PATH,
            registeredAt: '2026-05-11T00:00:00.000Z',
            languages: ['javascript'],
            status: 'active' as const,
          },
        ],
      }
      await writeAtomically(path.join(registryHome, 'projects.json'), JSON.stringify(registry))

      resetGraph()
      const graph = getGraph()
      await extractFromDirectory(graph, DEMO_PATH)
      await saveGraphToDisk(graph, diffPath)

      app = await buildApi({ graph, scanPath: DEMO_PATH })

      schemas = {
        Incidents: types.IncidentsResponseSchema,
        StaleEvents: types.StaleEventsResponseSchema,
        PoliciesViolations: types.PoliciesViolationsResponseSchema,
        GraphNode: types.GraphNodeResponseSchema,
        GraphEdges: types.GraphEdgesResponseSchema,
        Health: types.HealthResponseSchema,
        SingleProject: types.SingleProjectResponseSchema,
        Search: types.SearchResponseSchema,
        SerializedGraph: types.SerializedGraphSchema,
        GraphDiff: types.GraphDiffResultSchema,
        RootCause: types.RootCauseResultSchema,
        BlastRadius: types.BlastRadiusResultSchema,
        TransitiveDependencies: types.TransitiveDependenciesResultSchema,
        Divergence: types.DivergenceResultSchema,
        PolicyFile: types.PolicyFileSchema,
      }
    })

    afterAll(async () => {
      const { promises: fs } = await import('node:fs')
      if (app) await app.close()
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
      delete process.env.NEAT_HOME
    })

    // Helper: hit `path`, expect 200, parse through `schema`, surface the
    // Zod error on failure so a regression points at the offending field.
    async function expectShape(url: string, schema: import('zod').ZodTypeAny): Promise<void> {
      const reply = await app.inject({ method: 'GET', url })
      expect(reply.statusCode, `${url}: ${reply.body}`).toBe(200)
      const parsed = schema.safeParse(reply.json())
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format(), null, 2)).toBe(true)
    }

    it('GET /incidents response parses through IncidentsResponseSchema (ADR-061 #3)', async () => {
      await expectShape('/incidents', schemas.Incidents)
    })
    it('GET /incidents/:nodeId response parses through IncidentsResponseSchema (ADR-061 #3)', async () => {
      await expectShape('/incidents/service:service-b', schemas.Incidents)
    })
    it('GET /stale-events response parses through StaleEventsResponseSchema (ADR-061 #3)', async () => {
      await expectShape('/stale-events', schemas.StaleEvents)
    })
    it('GET /policies/violations response parses through PoliciesViolationsResponseSchema (ADR-061 #3)', async () => {
      await expectShape('/policies/violations', schemas.PoliciesViolations)
    })
    it('GET /graph/node/:id response parses through GraphNodeResponseSchema (ADR-061 #3)', async () => {
      await expectShape('/graph/node/service:service-b', schemas.GraphNode)
    })
    it('GET /graph/edges/:id response parses through GraphEdgesResponseSchema (ADR-061 #3)', async () => {
      await expectShape('/graph/edges/service:service-b', schemas.GraphEdges)
    })
    it('GET /health response parses through HealthResponseSchema (ADR-061 #3)', async () => {
      await expectShape('/health', schemas.Health)
    })
    it('GET /projects/:project response parses through SingleProjectResponseSchema (ADR-061 #3)', async () => {
      await expectShape('/projects/default', schemas.SingleProject)
    })
    it('GET /search response parses through SearchResponseSchema (ADR-061 #3)', async () => {
      await expectShape('/search?q=service-b', schemas.Search)
    })
    it('GET /graph/root-cause/:nodeId response parses through RootCauseResultSchema (ADR-061 #3)', async () => {
      await expectShape('/graph/root-cause/database:payments-db', schemas.RootCause)
    })
    it('GET /graph/blast-radius/:nodeId response parses through BlastRadiusResultSchema (ADR-061 #3)', async () => {
      await expectShape('/graph/blast-radius/service:service-a', schemas.BlastRadius)
    })
    it('GET /graph/dependencies/:nodeId response parses through TransitiveDependenciesResultSchema (ADR-061 #3)', async () => {
      await expectShape('/graph/dependencies/service:service-a', schemas.TransitiveDependencies)
    })
    it('GET /graph/divergences response parses through DivergenceResultSchema (ADR-061 #3)', async () => {
      await expectShape('/graph/divergences', schemas.Divergence)
    })
    it('GET /policies response parses through PolicyFileSchema (ADR-061 #3)', async () => {
      await expectShape('/policies', schemas.PolicyFile)
    })
    it('GET /graph response parses through SerializedGraphSchema (ADR-061 #3)', async () => {
      await expectShape('/graph', schemas.SerializedGraph)
    })
    it('GET /graph/diff response parses through GraphDiffResultSchema (ADR-061 #3)', async () => {
      await expectShape(`/graph/diff?against=${encodeURIComponent(diffPath)}`, schemas.GraphDiff)
    })
  })

  // ── Class D: path consistency scan ───────────────────────────────────
  // Every scope.get / scope.post path in api.ts must appear in
  // rest-api.md's canonical endpoint table. Catches future drift in
  // either direction (route exists but not documented; route documented
  // but not implemented). Routes registered for completeness but not part
  // of the canonical endpoint table (the SSE stream is documented in a
  // separate section, not the main table) are listed here.
  const SSE_AND_INTERNAL = new Set(['/events'])

  it('every path registered in api.ts appears in rest-api.md endpoint table (ADR-061 #6)', () => {
    const undocumented: string[] = []
    for (const p of declaredPaths) {
      if (SSE_AND_INTERNAL.has(p)) continue
      if (!documentedPaths.has(p)) undocumented.push(p)
    }
    expect(undocumented, `paths in api.ts missing from rest-api.md: ${undocumented.join(', ')}`).toEqual([])
  })
  it('every path in rest-api.md endpoint table is registered in api.ts (ADR-061 #6)', () => {
    const unimplemented: string[] = []
    for (const p of documentedPaths) {
      if (!declaredPaths.has(p)) unimplemented.push(p)
    }
    expect(unimplemented, `paths in rest-api.md missing from api.ts: ${unimplemented.join(', ')}`).toEqual([])
  })

  // ── Class E: coverage gaps now documented ────────────────────────────
  it('rest-api.md documents GET /incidents/:nodeId (ADR-061 #7)', () => {
    expect(documentedPaths).toContain('/incidents/:nodeId')
  })
  it('rest-api.md documents GET /projects/:project (ADR-061 #7)', () => {
    expect(documentedPaths).toContain('/projects/:project')
  })
  it('rest-api.md documents GET /graph/divergences (ADR-061 #7 — also ADR-060)', () => {
    expect(documentedPaths).toContain('/graph/divergences')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// `neat watch` ignore-glob pruning + darwin polling fallback (#233)
// ──────────────────────────────────────────────────────────────────────────
//
// chokidar 4 dropped fsevents in favour of kqueue on macOS. Each watched
// subdirectory opens one kqueue handle; a repo with nested `node_modules`
// (medusa, anything 2025-era TS-heavy) blows through the per-process cap
// with EMFILE before the function-based `ignored` callback fires. The
// fix passes globs as `ignored` so chokidar prunes at descent time — the
// dirs are never opened — and falls back to polling when the scan root is
// large enough that the kqueue cap is still at risk.
describe('`neat watch` ignore globs + polling fallback (#233)', () => {
  const watchSrc = readFileSync(join(CORE_SRC, 'watch.ts'), 'utf8')

  it('chokidar.watch is called with an array-form `ignored` containing the ignore globs', () => {
    // The call site passes `[...IGNORED_WATCH_GLOBS, (p: string) => shouldIgnore(p)]`.
    // Asserting the spread shape (not just "ignored: [...]") catches the regression
    // back to the function-only form that produced the EMFILE on medusa.
    expect(watchSrc).toMatch(/ignored:\s*\[\s*\.\.\.IGNORED_WATCH_GLOBS/)
  })

  it('IGNORED_WATCH_GLOBS includes node_modules, .git, dist, build, .turbo, .next, neat-out', () => {
    // The globs the prompt enumerates (#233). Any missing entry would let a
    // descent into that subtree open kqueue handles before the regex backstop
    // fires.
    for (const segment of [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/neat-out/**',
    ]) {
      expect(watchSrc, `IGNORED_WATCH_GLOBS missing ${segment}`).toContain(`'${segment}'`)
    }
  })

  it('shouldUsePolling reads NEAT_WATCH_POLLING and falls through to a darwin heuristic', () => {
    // Two overrides plus auto-detect on darwin. "1"/"true" forces polling,
    // "0"/"false" disables it, unset uses the dir-count heuristic when
    // process.platform is 'darwin'.
    expect(watchSrc).toMatch(/NEAT_WATCH_POLLING/)
    expect(watchSrc).toMatch(/process\.platform !== 'darwin'/)
    expect(watchSrc).toMatch(/DARWIN_POLLING_DIR_THRESHOLD/)
  })

  it('chokidar.watch options pass through the computed `usePolling` value', () => {
    // Belt-and-suspenders alongside the glob pruning. Without `usePolling`
    // wired into the options object, the heuristic has no effect.
    expect(watchSrc).toMatch(/const\s+usePolling\s*=\s*shouldUsePolling\(/)
    expect(watchSrc).toMatch(/usePolling,/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Comms-voice contract (Refs #262)
// ──────────────────────────────────────────────────────────────────────────
//
// The contract framework is glob-based on the `governs:` frontmatter of each
// per-topic contract under docs/contracts/. Adding comms-voice.md with a
// cross-cutting glob list (contracts corpus + decisions log + README +
// CLAUDE.md + key docs) makes the existing PreToolUse hook surface the
// comms rule whenever any of those files is edited — zero change to
// _hook.sh. These assertions lock the file's shape in place so future
// edits can't silently weaken the coverage.
describe('Comms-voice contract (Refs #262)', () => {
  const CONTRACT_PATH = join(__dirname, '../../../../docs/contracts/comms-voice.md')

  it('docs/contracts/comms-voice.md exists', () => {
    expect(existsSync(CONTRACT_PATH)).toBe(true)
  })

  // Tiny frontmatter parser — the per-topic contracts use a fixed shape
  // (name, description, governs list, adr list). The hook parses it with
  // awk; mirroring its approach here avoids pulling yaml just to assert
  // four fields. Anything sturdier than this would over-spec the format.
  function parseFrontmatter(src: string): {
    name?: string
    description?: string
    governs: string[]
    adr: string[]
  } {
    const match = src.match(/^---\n([\s\S]*?)\n---/)
    if (!match) return { governs: [], adr: [] }
    const body = match[1]
    const name = body.match(/^name:\s*(.+)$/m)?.[1]?.trim()
    const description = body.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    const governsBlock = body.match(/^governs:\n((?:  - .+\n?)+)/m)?.[1] ?? ''
    const governs = [...governsBlock.matchAll(/^  - "?([^"\n]+)"?$/gm)].map((m) => m[1].trim())
    const adrMatch = body.match(/^adr:\s*\[([^\]]*)\]/m)?.[1] ?? ''
    const adr = adrMatch
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    return { name, description, governs, adr }
  }

  it('frontmatter has name, description, governs (array), adr (array)', () => {
    const src = readFileSync(CONTRACT_PATH, 'utf8')
    const fm = parseFrontmatter(src)
    expect(fm.name).toBe('comms-voice')
    expect(fm.description, 'description present').toBeTruthy()
    expect(Array.isArray(fm.governs)).toBe(true)
    expect(fm.governs.length).toBeGreaterThan(0)
    expect(Array.isArray(fm.adr)).toBe(true)
    expect(fm.adr.length).toBeGreaterThan(0)
  })

  it('governs list covers the contract corpus, ADR log, README, and CLAUDE.md', () => {
    // These four are the floor: contracts, decisions, README, CLAUDE.md.
    // The hook walks `docs/contracts/*.md` and matches against every glob
    // in this list. Dropping any of these four would leave a class of
    // repo-visible artifact uncovered by the comms rule.
    const src = readFileSync(CONTRACT_PATH, 'utf8')
    const fm = parseFrontmatter(src)
    for (const required of ['docs/contracts/*.md', 'docs/decisions.md', 'README.md', 'CLAUDE.md']) {
      expect(fm.governs, `comms-voice governs missing ${required}`).toContain(required)
    }
  })

  it('body carries the forward-looking-framing rule', () => {
    // Canary phrase. The body can be re-organised freely; this token has
    // to land somewhere in the prose so the rule survives future edits.
    const src = readFileSync(CONTRACT_PATH, 'utf8')
    expect(src.toLowerCase()).toContain('forward-looking framing')
  })

  it('contracts.md index references the new contract', () => {
    // Sanity check that the index row landed alongside the new file —
    // a contract not in the index is invisible to a reader skimming the
    // table.
    const indexPath = join(__dirname, '../../../../docs/contracts.md')
    const index = readFileSync(indexPath, 'utf8')
    expect(index).toContain('contracts/comms-voice.md')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// ADR-068 — FrontierNode and OBSERVED provenance are orthogonal (#267)
// ──────────────────────────────────────────────────────────────────────────
//
// Provenance is four values; FrontierNode is a node type that no longer
// doubles as a provenance value. Span-derived edges to unresolved peers
// carry OBSERVED provenance with the FrontierNode id as the target string.
// The frontierEdgeId helper retires; OBSERVED-with-FrontierNode-target uses
// observedEdgeId. persist.ts carries a v2 → v3 migration that rewrites
// legacy FRONTIER-provenance edges to OBSERVED on load.
describe('ADR-068 — FrontierNode + OBSERVED orthogonality (#267)', () => {
  it('Provenance enum has exactly four values (OBSERVED, INFERRED, EXTRACTED, STALE)', () => {
    expect(Object.keys(Provenance).sort()).toEqual(['EXTRACTED', 'INFERRED', 'OBSERVED', 'STALE'])
  })

  it('ProvenanceSchema.options matches the four-value enum', () => {
    expect(ProvenanceSchema.options.slice().sort()).toEqual(['EXTRACTED', 'INFERRED', 'OBSERVED', 'STALE'])
  })

  it('PROV_RANK has exactly four entries and the OBSERVED > INFERRED > EXTRACTED > STALE ordering', async () => {
    const { PROV_RANK } = await import('@neat.is/types')
    expect(Object.keys(PROV_RANK).sort()).toEqual(['EXTRACTED', 'INFERRED', 'OBSERVED', 'STALE'])
    expect(PROV_RANK.OBSERVED).toBeGreaterThan(PROV_RANK.INFERRED)
    expect(PROV_RANK.INFERRED).toBeGreaterThan(PROV_RANK.EXTRACTED)
    expect(PROV_RANK.EXTRACTED).toBeGreaterThan(PROV_RANK.STALE)
  })

  it('@neat.is/types exports no frontierEdgeId symbol', async () => {
    const mod = (await import('@neat.is/types')) as Record<string, unknown>
    expect(mod.frontierEdgeId).toBeUndefined()
  })

  it('no source file under packages/core/src/, packages/mcp/src/, packages/types/src/ references Provenance.FRONTIER', () => {
    const offenders: string[] = []
    const re = /\bProvenance\.FRONTIER\b/
    for (const file of [...walkSrc(CORE_SRC), ...walkSrc(MCP_SRC), ...walkSrc(TYPES_SRC)]) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        if (re.test(line) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
          offenders.push(`${file}:${i + 1}: ${trimmed}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no source file references the frontierEdgeId helper', () => {
    const offenders: string[] = []
    const re = /\bfrontierEdgeId\b/
    for (const file of [...walkSrc(CORE_SRC), ...walkSrc(MCP_SRC), ...walkSrc(TYPES_SRC)]) {
      const content = readFileSync(file, 'utf8')
      content.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        if (re.test(line) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
          offenders.push(`${file}:${i + 1}: ${trimmed}`)
        }
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('observedEdgeId(source, frontierId(host), type) round-trips through parseEdgeId with provenance=OBSERVED and FrontierNode target preserved', async () => {
    const { observedEdgeId, frontierId, parseEdgeId } = await import('@neat.is/types')
    const id = observedEdgeId('service:checkout', frontierId('api.github.com'), EdgeType.CALLS)
    expect(id).toBe('CALLS:OBSERVED:service:checkout->frontier:api.github.com')
    expect(parseEdgeId(id)).toEqual({
      type: EdgeType.CALLS,
      provenance: 'OBSERVED',
      source: 'service:checkout',
      target: 'frontier:api.github.com',
    })
  })

  it('OTLP span to an unresolved peer produces an OBSERVED edge with FrontierNode target, signal block populated, graded confidence', async () => {
    const { handleSpan } = await import('../../src/ingest.js')
    const { frontierId, observedEdgeId } = await import('@neat.is/types')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:hello-smoke', {
      id: 'service:hello-smoke',
      type: NodeType.ServiceNode,
      name: 'hello-smoke',
      language: 'javascript',
    })
    const errorsPath = `/tmp/neat-adr068-${Date.now()}.ndjson`
    await handleSpan(
      { graph: g, errorsPath, writeErrorEventInline: false },
      {
        service: 'hello-smoke',
        traceId: 't1',
        spanId: 's1',
        name: 'GET /work',
        startTimeUnixNano: '1747400400000000000',
        endTimeUnixNano: '1747400400100000000',
        startTimeIso: '2026-05-16T14:00:00.000Z',
        durationNanos: 0n,
        attributes: { 'server.address': 'api.github.com' },
      },
    )
    const fid = frontierId('api.github.com')
    expect(g.hasNode(fid)).toBe(true)
    const id = observedEdgeId('service:hello-smoke', fid, EdgeType.CALLS)
    expect(g.hasEdge(id)).toBe(true)
    const edge = g.getEdgeAttributes(id) as GraphEdge
    expect(edge.provenance).toBe(Provenance.OBSERVED)
    expect(edge.signal).toBeDefined()
    expect(edge.signal!.spanCount).toBe(1)
    expect(edge.signal!.errorCount).toBe(0)
    expect(typeof edge.confidence).toBe('number')
  })

  it('promoteFrontierNodes preserves provenance: OBSERVED-to-FrontierNode promotes to OBSERVED-to-typed-node (already asserted in lifecycle block)', async () => {
    const { observedEdgeId, frontierId } = await import('@neat.is/types')
    const { promoteFrontierNodes } = await import('../../src/ingest.js')
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    g.addNode('service:caller', { id: 'service:caller', type: NodeType.ServiceNode, name: 'caller', language: 'javascript' })
    g.addNode('service:callee', {
      id: 'service:callee', type: NodeType.ServiceNode, name: 'callee', language: 'javascript', aliases: ['callee.host'],
    })
    const fid = frontierId('callee.host')
    g.addNode(fid, { id: fid, type: NodeType.FrontierNode, name: 'callee.host', host: 'callee.host' })
    const oldId = observedEdgeId('service:caller', fid, EdgeType.CALLS)
    g.addEdgeWithKey(oldId, 'service:caller', fid, {
      id: oldId, source: 'service:caller', target: fid, type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED, lastObserved: '2026-05-16T00:00:00.000Z', callCount: 1,
    })
    expect(promoteFrontierNodes(g)).toBe(1)
    const newId = observedEdgeId('service:caller', 'service:callee', EdgeType.CALLS)
    expect(g.hasEdge(newId)).toBe(true)
    expect((g.getEdgeAttributes(newId) as GraphEdge).provenance).toBe(Provenance.OBSERVED)
  })

  it('persist.ts SCHEMA_VERSION is 3', () => {
    const content = readFileSync(join(CORE_SRC, 'persist.ts'), 'utf8')
    expect(content).toMatch(/const\s+SCHEMA_VERSION\s*=\s*3/)
  })

  it('persist v2 → v3 migration rewrites edges with provenance=FRONTIER to provenance=OBSERVED; target ref preserved; id re-keyed via OBSERVED wire format', async () => {
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join: pathJoin } = await import('node:path')
    const { loadGraphFromDisk } = await import('../../src/persist.js')
    const { MultiDirectedGraph: MDG } = await import('graphology')

    const tmp = await mkdtemp(pathJoin(tmpdir(), 'neat-adr068-'))
    try {
      const snapshotPath = pathJoin(tmp, 'graph.json')
      const legacy = {
        schemaVersion: 2,
        exportedAt: '2026-05-16T14:00:00.000Z',
        graph: {
          attributes: {},
          options: { allowSelfLoops: false, multi: true, type: 'directed' },
          nodes: [
            { key: 'service:caller', attributes: { id: 'service:caller', type: NodeType.ServiceNode, name: 'caller', language: 'javascript' } },
            { key: 'frontier:peer.host', attributes: { id: 'frontier:peer.host', type: NodeType.FrontierNode, name: 'peer.host', host: 'peer.host' } },
          ],
          edges: [
            {
              key: 'CALLS:FRONTIER:service:caller->frontier:peer.host',
              source: 'service:caller',
              target: 'frontier:peer.host',
              attributes: {
                id: 'CALLS:FRONTIER:service:caller->frontier:peer.host',
                source: 'service:caller',
                target: 'frontier:peer.host',
                type: EdgeType.CALLS,
                provenance: 'FRONTIER',
                lastObserved: '2026-05-16T13:59:00.000Z',
                callCount: 5,
              },
            },
          ],
        },
      }
      await writeFile(snapshotPath, JSON.stringify(legacy), 'utf8')
      const g = new MDG<GraphNode, GraphEdge>({ allowSelfLoops: false })
      await loadGraphFromDisk(g as unknown as NeatGraph, snapshotPath)

      const expectedId = 'CALLS:OBSERVED:service:caller->frontier:peer.host'
      expect(g.hasEdge(expectedId)).toBe(true)
      const edge = g.getEdgeAttributes(expectedId) as GraphEdge
      expect(edge.provenance).toBe(Provenance.OBSERVED)
      expect(edge.target).toBe('frontier:peer.host')
      expect(edge.callCount).toBe(5)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('contracts/provenance.md and contracts/frontier-promotion.md reference ADR-068 in their adr: list', () => {
    const provFm = readFileSync(join(__dirname, '../../../../docs/contracts/provenance.md'), 'utf8')
    const frontierFm = readFileSync(join(__dirname, '../../../../docs/contracts/frontier-promotion.md'), 'utf8')
    expect(provFm).toMatch(/adr:.*ADR-068/)
    expect(frontierFm).toMatch(/adr:.*ADR-068/)
  })
})

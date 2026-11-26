import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import { EdgeType, NodeType, Provenance, type GraphEdge, type GraphNode } from '@neat.is/types'
import { REDACTED, redactAndClip, scrubEdgeText } from '../src/credential-scrub.js'
import { buildEdgeErrorExemplar, EDGE_ERROR_MESSAGE_MAX } from '../src/ingest/edges.js'
import { snippet } from '../src/extract/calls/shared.js'
import { SCHEMA_VERSION, loadGraphFromDisk, migrateSnapshot, type PersistedGraph } from '../src/persist.js'
import type { NeatGraph } from '../src/graph.js'

// #1759: the credential scrub that every ledger row goes through also covers
// the two pieces of free text a graph edge carries, `signal.lastError.message`
// (a span's failure message, ADR-236) and `evidence.snippet` (a source line).
// One pattern set, applied where each is written and again on snapshot load.

const PG_URL = 'postgres://app:hunter2pass@db.internal:5432/orders'
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const BEARER = 'Bearer abc123def456ghi789jkl'

describe('edge last-error message', () => {
  it('redacts the password in a connection string quoted by a failure message', () => {
    const ex = buildEdgeErrorExemplar(
      { exceptionType: 'ConnectionError', message: `could not connect to ${PG_URL}: timeout` },
      '2026-11-26T00:00:00.000Z',
    )
    expect(ex.message).not.toContain('hunter2pass')
    expect(ex.message).toBe(`could not connect to postgres://app:${REDACTED}@db.internal:5432/orders: timeout`)
    expect(ex.exceptionType).toBe('ConnectionError')
  })

  it('redacts a bearer token echoed into the message', () => {
    const ex = buildEdgeErrorExemplar({ message: `401 from upstream, sent ${BEARER}` }, 't')
    expect(ex.message).toBe(`401 from upstream, sent Bearer ${REDACTED}`)
  })

  it('redacts a credential that straddles the length ceiling instead of keeping half of it', () => {
    // The URL starts inside the 512-char window and its `@` lands after it. A
    // trim-then-scrub would keep `postgres://app:hunter2` with no `@` to match.
    const pad = 'x'.repeat(EDGE_ERROR_MESSAGE_MAX - 20)
    const ex = buildEdgeErrorExemplar({ message: `${pad} ${PG_URL}` }, 't')
    expect(ex.message!.length).toBeLessThanOrEqual(EDGE_ERROR_MESSAGE_MAX)
    expect(ex.message).not.toContain('hunter2')
  })

  it('leaves an ordinary failure message unchanged', () => {
    const msg = 'connect ECONNREFUSED 10.0.0.4:5432'
    expect(buildEdgeErrorExemplar({ message: msg }, 't').message).toBe(msg)
  })
})

describe('evidence snippet', () => {
  it('redacts an AWS access key literal in the source line', () => {
    const src = `import boto3\nclient = boto3.client("s3", aws_access_key_id="${AWS_KEY}")\n`
    const out = snippet(src, 2)
    expect(out).not.toContain(AWS_KEY)
    expect(out).toBe(`client = boto3.client("s3", aws_access_key_id="${REDACTED}")`)
  })

  it('redacts a hardcoded bearer token and a connection string', () => {
    expect(snippet(`headers = { Authorization: "${BEARER}" }`, 1)).toBe(`headers = { Authorization: "Bearer ${REDACTED}" }`)
    expect(snippet(`const pool = new Pool("${PG_URL}")`, 1)).not.toContain('hunter2pass')
  })

  it('redacts a credential that straddles the 120-char cap', () => {
    const line = `const conn = "${'a'.repeat(95)}" + "${PG_URL}"`
    const out = snippet(line, 1)
    expect(out).toContain('… (+')
    expect(out).not.toContain('hunter2')
  })

  it('leaves an ordinary source line unchanged', () => {
    const line = 'await fetch("https://api.example.com/orders?page=2")'
    expect(snippet(`a\n  ${line}  \nb`, 2)).toBe(line)
  })
})

describe('redactAndClip', () => {
  it('scrubs the whole text when redaction brings a long input under the cap', () => {
    // A complete PEM block fills the scan window and the AWS key is cut by the
    // window's edge. Redacting the block leaves the text short enough to keep
    // whole, so the whole text is scrubbed, key included.
    const header = '-----BEGIN RSA PRIVATE KEY-----'
    const footer = '-----END RSA PRIVATE KEY-----'
    const key = `${header}\n${'Z'.repeat(1130 - header.length - footer.length - 2)}\n${footer}`
    expect(key.length).toBe(1130)
    const { text, cut } = redactAndClip(`${key} tail ${AWS_KEY}`, 120)
    expect(cut).toBe(0)
    expect(text).toBe(`${REDACTED} tail ${REDACTED}`)
  })

  it('drops what lies past the scan window rather than keeping it unscrubbed', () => {
    const { text, cut } = redactAndClip(`${'q'.repeat(5000)} ${AWS_KEY}`, 120)
    expect(text).toBe('q'.repeat(120))
    expect(cut).toBe(5000 + 1 + AWS_KEY.length - 120)
  })
})

describe('scrubEdgeText', () => {
  it('returns a clean edge as the same object', () => {
    const edge = { id: 'e', evidence: { file: 'a.ts', snippet: 'fetch(url)' }, signal: { lastError: { message: 'timeout' } } }
    expect(scrubEdgeText(edge)).toBe(edge)
  })
})

// The load-path pass, for edges written before the producers scrubbed.
function dirtySnapshot(): PersistedGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  for (const name of ['api', 'db']) {
    g.addNode(`service:${name}`, { id: `service:${name}`, type: NodeType.ServiceNode, name, language: 'javascript' } as GraphNode)
  }
  const observed = `${EdgeType.CALLS}:OBSERVED:service:api->service:db`
  g.addEdgeWithKey(observed, 'service:api', 'service:db', {
    id: observed,
    source: 'service:api',
    target: 'service:db',
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    signal: { spanCount: 3, errorCount: 1, lastError: { message: `connect failed: ${PG_URL}`, at: 't' } },
  } as GraphEdge)
  const extracted = `${EdgeType.CALLS}:service:api->service:db`
  g.addEdgeWithKey(extracted, 'service:api', 'service:db', {
    id: extracted,
    source: 'service:api',
    target: 'service:db',
    type: EdgeType.CALLS,
    provenance: Provenance.EXTRACTED,
    evidence: { file: 'src/s3.py', line: 4, snippet: `aws_access_key_id="${AWS_KEY}"` },
  } as GraphEdge)
  return { schemaVersion: SCHEMA_VERSION, exportedAt: '2026-01-01T00:00:00.000Z', graph: g.export() }
}

describe('snapshot load', () => {
  let outPath: string

  beforeEach(async () => {
    outPath = path.join(await fs.mkdtemp(path.join(tmpdir(), 'neat-edge-scrub-')), 'graph.json')
  })

  afterEach(async () => {
    await fs.rm(path.dirname(outPath), { recursive: true, force: true })
  })

  it('scrubs edge text on load and saves the snapshot back clean', async () => {
    await fs.writeFile(outPath, JSON.stringify(dirtySnapshot()), 'utf8')
    const graph: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    await loadGraphFromDisk(graph, outPath)

    const observed = graph.getEdgeAttributes(`${EdgeType.CALLS}:OBSERVED:service:api->service:db`)
    expect(observed.signal?.lastError?.message).toBe(`connect failed: postgres://app:${REDACTED}@db.internal:5432/orders`)
    const extracted = graph.getEdgeAttributes(`${EdgeType.CALLS}:service:api->service:db`)
    expect(extracted.evidence?.snippet).toBe(`aws_access_key_id="${REDACTED}"`)
    expect(extracted.evidence?.file).toBe('src/s3.py')

    const onDisk = await fs.readFile(outPath, 'utf8')
    expect(onDisk).not.toContain('hunter2pass')
    expect(onDisk).not.toContain(AWS_KEY)
  })

  it('leaves a clean snapshot on disk untouched', async () => {
    const snap = dirtySnapshot()
    for (const e of snap.graph.edges) e.attributes = scrubEdgeText(e.attributes)
    const bytes = JSON.stringify(snap)
    await fs.writeFile(outPath, bytes, 'utf8')
    const graph: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    await loadGraphFromDisk(graph, outPath)
    expect(await fs.readFile(outPath, 'utf8')).toBe(bytes)
  })

  it('scrubs a pushed snapshot through migrateSnapshot too', () => {
    const out = JSON.stringify(migrateSnapshot(dirtySnapshot()))
    expect(out).not.toContain('hunter2pass')
    expect(out).not.toContain(AWS_KEY)
  })
})

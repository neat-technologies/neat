import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { discoverPythonService } from '../src/extract/python.js'
import { getRootCause } from '../src/traverse.js'
import type { ServiceNode } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PY_FIXTURES = path.resolve(__dirname, 'fixtures', 'python')

describe('Python service extraction', () => {
  beforeEach(() => resetGraph())

  it('reads requirements.txt + pyproject.toml deps off a Python service', async () => {
    const result = await discoverPythonService(path.join(PY_FIXTURES, 'payments-api'))
    expect(result?.name).toBe('payments-api')
    expect(result?.dependencies.psycopg2).toBe('2.7.0')
    expect(result?.dependencies.fastapi).toBe('0.110.0')
  })

  it('reads poetry-style deps when requirements.txt is absent', async () => {
    const result = await discoverPythonService(path.join(PY_FIXTURES, 'orders-api'))
    expect(result?.name).toBe('orders-api')
    expect(result?.version).toBe('0.2.0')
    expect(result?.dependencies.fastapi).toBe('0.110.0')
    expect(result?.dependencies.python).toBeUndefined()
  })

  it('produces a Python ServiceNode with language="python" and reaches root cause', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, PY_FIXTURES)

    expect(graph.hasNode('service:payments-api')).toBe(true)
    const node = graph.getNodeAttributes('service:payments-api') as ServiceNode
    expect(node.language).toBe('python')
    expect(node.dependencies?.psycopg2).toBe('2.7.0')

    expect(node.incompatibilities?.[0]).toMatchObject({
      driver: 'psycopg2',
      driverVersion: '2.7.0',
      engine: 'postgresql',
      engineVersion: '15',
    })

    const result = getRootCause(graph, 'database:payments-db')
    expect(result.rootCauseNode).toBe('service:payments-api')
    expect(result.rootCauseReason).toMatch(/psycopg2/)
  })

  it('emits a CALLS edge between two Python services via tree-sitter-python', async () => {
    // ADR-066 — Python http URL match grades at the hostname-shape tier
    // (0.2) and drops below the default precision floor (0.7). Flip the
    // floor off here so the test exercises full recall.
    const prev = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    process.env.NEAT_EXTRACTED_PRECISION_FLOOR = '0'
    try {
      const graph = getGraph()
      await extractFromDirectory(graph, PY_FIXTURES)

      // File-first (ADR-089): the CALLS edge originates from the file the call
      // site lives in (file:payments-api:<relPath>), not the service directly.
      const aToB = graph
        .edges()
        .filter(
          (e) =>
            graph.getEdgeAttribute(e, 'type') === 'CALLS' &&
            graph.source(e).startsWith('file:payments-api:') &&
            graph.target(e) === 'service:orders-api',
        )
      expect(aToB.length).toBeGreaterThanOrEqual(1)
    } finally {
      if (prev === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
      else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prev
    }
  })
})

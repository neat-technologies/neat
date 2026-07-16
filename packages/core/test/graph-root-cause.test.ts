import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'
import { extractFromDirectory } from '../src/extract.js'
import { getRootCause } from '../src/traverse.js'
import type { NeatGraph } from '../src/graph.js'

// get_root_cause correctness over the REAL extracted graph, not a hand-built one.
// traverse.test.ts exercises the traversal + compat matrix against synthetic
// graphs; this proves the same query lands the right culprit when the graph is
// the one `extractFromDirectory` actually produces from demo/, and that the
// /graph/root-cause endpoint the MCP get_root_cause tool wraps returns it.

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../demo')

describe('get_root_cause over the real demo graph', () => {
  let graph: NeatGraph
  let app: FastifyInstance

  beforeAll(async () => {
    resetGraph()
    graph = getGraph()
    await extractFromDirectory(graph, DEMO)
    app = await buildApi({ graph, scanPath: DEMO })
  })

  it('traces a failing database up to the service that connects to it', () => {
    // demo: service-a → service-b → payments-db. Asking root-cause of the db
    // walks incoming dependencies to the service carrying the DB relationship.
    const result = getRootCause(graph, 'database:payments-db')
    expect(result, 'root cause of a real declared db should resolve').not.toBeNull()
    expect(result!.rootCauseNode).toBe('service:service-b')
    // the traversal path is real graph node ids, ending at the failing db.
    expect(result!.traversalPath.length).toBeGreaterThan(0)
    expect(result!.traversalPath).toContain('database:payments-db')
  })

  it('returns null for a node absent from the graph', () => {
    expect(getRootCause(graph, 'database:does-not-exist')).toBeNull()
  })

  it('surfaces the same culprit through the /graph/root-cause endpoint', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/graph/root-cause/database:payments-db',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { rootCauseNode: string; traversalPath: string[] }
    expect(body.rootCauseNode).toBe('service:service-b')
  })
})

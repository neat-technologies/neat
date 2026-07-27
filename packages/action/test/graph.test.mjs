import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGraph, diffGraphs, blastRadius, renderComment, MARKER } from '../src/graph.mjs'

// Fixtures are two real NEAT snapshots — a "shop-api" service and a PR that adds
// an items route + order_items table and removes the customers route + table.
const dir = path.dirname(fileURLToPath(import.meta.url))
const base = loadGraph(path.join(dir, 'fixtures/base.graph.json'))
const head = loadGraph(path.join(dir, 'fixtures/head.graph.json'))

test('diff surfaces added/removed routes and tables', () => {
  const d = diffGraphs(base, head)
  assert.deepEqual(d.routesAdded, ['GET /orders/{order_id}/items'])
  assert.deepEqual(d.routesRemoved, ['GET /customers'])
  assert.deepEqual(d.tablesAdded, ['order_items'])
  assert.deepEqual(d.tablesRemoved, ['customers'])
})

test('blast radius finds inbound dependents of a changed file', () => {
  const deps = blastRadius(head, 'file:shop-api:models.py').filter((d) => d.startsWith('file:'))
  assert.ok(deps.includes('file:shop-api:main.py'), 'main.py imports models.py')
})

test('renders a sticky comment with the delta + blast radius', () => {
  const delta = diffGraphs(base, head)
  const { marker, body } = renderComment({
    graph: head,
    delta,
    changedFiles: ['file:shop-api:models.py', 'file:shop-api:main.py'],
  })
  assert.equal(marker, MARKER)
  assert.ok(body.startsWith(MARKER), 'carries the sticky marker for update-in-place')
  assert.ok(body.includes('➕ routes: `GET /orders/{order_id}/items`'))
  assert.ok(body.includes('➖ tables: `customers`'))
  assert.ok(body.includes('⚠️ removed reference'))
  assert.ok(body.includes('`models.py` → depended on by `main.py`'))
  assert.ok(body.includes('Static graph (EXTRACTED)'))
})

test('empty diff renders an honest "no changes" line, not a hollow comment', () => {
  const delta = diffGraphs(head, head)
  const { body } = renderComment({ graph: head, delta, changedFiles: [] })
  assert.ok(body.includes('no route/table/dependency changes detected'))
})

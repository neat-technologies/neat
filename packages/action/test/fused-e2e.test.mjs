import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'

// End-to-end over real HTTP: the action's fused fetch hits a live endpoint that
// serves divergence findings in the engine's real shape (type/source/target/reason,
// from divergences.ts), and keeps only the findings that touch a node this PR
// changed. Proves the fused data path, not just the rendering.
test('fused fetch pulls divergences over HTTP and filters to changed nodes', async () => {
  const findings = [
    {
      type: 'missing-observed',
      source: 'file:shop-api:main.py',
      target: 'infra:sql-table:order_items',
      edgeType: 'CALLS',
      reason: 'Code declares main.py → order_items but no production traffic has been observed.',
    },
    {
      type: 'missing-observed',
      source: 'file:shop-api:main.py',
      target: 'infra:sql-table:orders',
      edgeType: 'CALLS',
      reason: 'unchanged edge — must be filtered out, not a changed node.',
    },
  ]
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(findings))
  })
  server.listen(0)
  await once(server, 'listening')
  const port = server.address().port
  process.env.INPUT_NEAT_API_URL = `http://127.0.0.1:${port}`

  // Import after the env is set — main.mjs reads INPUT_NEAT_API_URL at load, and
  // the guarded entrypoint means importing it runs no side effects.
  const { fetchDivergences } = await import('../src/main.mjs')
  try {
    const changed = ['infra:sql-table:order_items', 'route:shop-api:GET /customers']
    const out = await fetchDivergences(changed)
    assert.equal(out.length, 1, 'only the finding touching a changed node is kept')
    assert.match(out[0], /missing-observed.*order_items/)
    assert.doesNotMatch(out[0], /unchanged/)
  } finally {
    server.close()
  }
})

test('fused fetch degrades to empty on an unreachable host (stays static tier)', async () => {
  process.env.INPUT_NEAT_API_URL = 'http://127.0.0.1:1' // nothing listening
  const { fetchDivergences } = await import('../src/main.mjs')
  const out = await fetchDivergences(['infra:sql-table:orders'])
  assert.deepEqual(out, [])
})

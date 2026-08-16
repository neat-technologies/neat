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

// The auth header the connected host receives — a self-hosted daemon on the
// customer's own network (and the hosted plane) can require a bearer token; the
// neat-local static tier connects to no host at all.
async function captureAuthHeader({ token }) {
  let seen
  const server = http.createServer((req, res) => {
    seen = req.headers.authorization
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ observed: true, inboundObservedCount: 2, dependencies: [] }))
  })
  server.listen(0)
  await once(server, 'listening')
  process.env.INPUT_NEAT_API_URL = `http://127.0.0.1:${server.address().port}`
  if (token === undefined) delete process.env.INPUT_NEAT_API_TOKEN
  else process.env.INPUT_NEAT_API_TOKEN = token
  try {
    const { fetchObservedBreaks } = await import('../src/main.mjs')
    await fetchObservedBreaks([{ id: 'route:shop-api:GET /orders', type: 'route', change: 'removed' }])
    return seen
  } finally {
    server.close()
    delete process.env.INPUT_NEAT_API_TOKEN
  }
}

test('fused fetch sends the bearer token when neat-api-token is set (self-hosted / hosted auth)', async () => {
  const auth = await captureAuthHeader({ token: 's3cr3t-daemon-key' })
  assert.equal(auth, 'Bearer s3cr3t-daemon-key')
})

test('fused fetch sends no Authorization when neat-api-token is unset (open host / static tier)', async () => {
  const auth = await captureAuthHeader({ token: undefined })
  assert.equal(auth, undefined)
})

test('fused fetch pulls the node-level inbound block onto the break object (ADR-190)', async () => {
  const iso = '2026-08-16T18:00:00.000Z'
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        observed: true,
        inboundObservedCount: 3,
        dependencies: [],
        inboundVolume: 3214,
        window: '7d',
        inboundLastObserved: iso,
      }),
    )
  })
  server.listen(0)
  await once(server, 'listening')
  process.env.INPUT_NEAT_API_URL = `http://127.0.0.1:${server.address().port}`
  try {
    const { fetchObservedBreaks } = await import('../src/main.mjs')
    const breaks = await fetchObservedBreaks([
      { id: 'route:shop-api:GET /orders/:id', type: 'RouteNode', label: 'GET /orders/:id', change: 'removed' },
    ])
    assert.equal(breaks.length, 1)
    const b = breaks[0]
    // New keys — callCount (outbound deps.length) and dependentCount untouched.
    assert.equal(b.dependentCount, 3)
    assert.equal(b.callCount, 0)
    assert.equal(b.inboundVolume, 3214)
    assert.equal(b.window, '7d')
    assert.equal(b.inboundLastObserved, iso)
  } finally {
    server.close()
  }
})

test('fused fetch omits the inbound block when the host does not serve it (degrade path)', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ observed: true, inboundObservedCount: 2, dependencies: [] }))
  })
  server.listen(0)
  await once(server, 'listening')
  process.env.INPUT_NEAT_API_URL = `http://127.0.0.1:${server.address().port}`
  try {
    const { fetchObservedBreaks } = await import('../src/main.mjs')
    const breaks = await fetchObservedBreaks([
      { id: 'route:x', type: 'RouteNode', label: 'x', change: 'removed' },
    ])
    assert.equal(breaks[0].inboundVolume, undefined)
    assert.equal(breaks[0].window, undefined)
    assert.equal(breaks[0].inboundLastObserved, undefined)
  } finally {
    server.close()
  }
})

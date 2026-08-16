import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { loadGraph, diffGraphs, renderComment, renderVerdict, MARKER } from '../src/graph.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const emptyDelta = { routesAdded: [], routesRemoved: [], tablesAdded: [], tablesRemoved: [] }
const emptyGraph = { nodes: new Map(), edges: [] }

// ── GREEN ─────────────────────────────────────────────────────────────────
test('GREEN: a clean diff renders all-clear + the fusion note', () => {
  const { body, tier } = renderVerdict({
    graph: emptyGraph,
    delta: { ...emptyDelta, routesAdded: ['GET /health'] }, // additive only
    divergences: [],
    observedBreaks: [],
  })
  assert.equal(tier, 'green')
  assert.ok(body.startsWith(MARKER), 'carries the sticky marker for update-in-place')
  assert.ok(body.includes('## ✅ NEAT — all clear'))
  assert.ok(body.includes('Nothing this PR touches is observed in production'))
  assert.ok(body.includes('<sub>'), 'fusion/freshness note present')
  // No fabricated recency/volume.
  assert.doesNotMatch(body, /\d[\d,]*×|last seen|in \d+\s?d\b/)
})

// ── YELLOW ────────────────────────────────────────────────────────────────
test('YELLOW: a divergence with no observed break lists under "Read them"', () => {
  const { body, tier } = renderVerdict({
    graph: emptyGraph,
    delta: emptyDelta,
    divergences: ['missing-observed: `GET /customers` — declared, never observed in prod'],
    observedBreaks: [],
  })
  assert.equal(tier, 'yellow')
  assert.ok(body.includes('## ⚠️ NEAT — a few minor problems'))
  assert.ok(body.includes('1 minor problem — read it below.'))
  assert.ok(body.includes('<details><summary>Read them →</summary>'))
  assert.ok(body.includes('**🟠 Divergence** — missing-observed: `GET /customers`'))
})

test('YELLOW: a removed route with no observed traffic is a static concern', () => {
  const { body, tier } = renderVerdict({
    graph: emptyGraph,
    delta: { ...emptyDelta, routesRemoved: ['GET /legacy'] },
    divergences: [],
    observedBreaks: [],
  })
  assert.equal(tier, 'yellow')
  assert.ok(body.includes('**🟠 Removed route** — `GET /legacy`'))
})

// ── RED ───────────────────────────────────────────────────────────────────
function redInputs(extra = {}) {
  return {
    graph: emptyGraph,
    delta: { ...emptyDelta, routesRemoved: ['GET /orders/:id'] },
    divergences: ['missing-observed: `GET /customers` — declared, never observed in prod'],
    observedBreaks: [
      {
        id: 'route:shop-api:GET /orders/:id',
        type: 'RouteNode',
        label: 'GET /orders/:id',
        change: 'removed',
        dependentCount: 3,
        callCount: 0,
      },
    ],
    ...extra,
  }
}

test('RED: observed break ranks first, divergence second, honest counts (no fabricated volume)', () => {
  const { body, tier } = renderVerdict(redInputs())
  assert.equal(tier, 'red')
  assert.ok(body.includes('## 🛑 NEAT — FUCK NO. Here are the problems:'))
  // Ranked, observed break first.
  assert.ok(
    body.includes('1. **🔴 Production will break** — this PR deletes `GET /orders/:id`'),
    'break is finding #1',
  )
  assert.ok(body.includes('3 observed dependents (OBSERVED). Live callers 404.'))
  assert.ok(body.includes('2. **🟠 Divergence** —'), 'divergence ranks after the break')
  assert.ok(body.includes('<details><summary>Full detail →</summary>'))
  // The removed route is a 🔴 break, so it must NOT be double-counted as a 🟠 static concern.
  assert.doesNotMatch(body, /Removed route.*GET \/orders\/:id/)
  // Never invent request volume or recency the host doesn't hand us.
  assert.doesNotMatch(body, /\d[\d,]*×|last seen|in \d+\s?d\b/)
})

test('RED: sniper-dispatch-url renders the dispatch link only when set', () => {
  const withLink = renderVerdict(redInputs({ sniperDispatchUrl: 'https://sniper.neat.is/dispatch/42' }))
  assert.ok(withLink.body.includes('**[⚡ Dispatch Sniper to fix these →](https://sniper.neat.is/dispatch/42)**'))

  const without = renderVerdict(redInputs())
  assert.doesNotMatch(without.body, /Dispatch Sniper/)
})

test('RED: graph-diff-url renders a link only when set', () => {
  const withLink = renderVerdict(redInputs({ graphDiffUrl: 'https://neat.is/diff/9' }))
  assert.ok(withLink.body.includes('[Full graph diff →](https://neat.is/diff/9)'))
  assert.doesNotMatch(renderVerdict(redInputs()).body, /Full graph diff/)
})

test('tone: professional swaps to SFW copy, same severity + structure', () => {
  const { body, tier } = renderVerdict(redInputs({ tone: 'professional' }))
  assert.equal(tier, 'red')
  assert.ok(body.includes('## 🛑 NEAT — Critical: production will break'))
  assert.doesNotMatch(body, /FUCK NO/)
  // Same structure: still a ranked break first.
  assert.ok(body.includes('1. **🔴 Production will break**'))
})

// ── Static-only fallback (no neat-api-url) ──────────────────────────────────
test('static fallback keeps the graph-diff comment and nudges toward a host', () => {
  const base = loadGraph(path.join(dir, 'fixtures/base.graph.json'))
  const head = loadGraph(path.join(dir, 'fixtures/head.graph.json'))
  const delta = diffGraphs(base, head)
  const { body } = renderComment({ graph: head, delta, changedFiles: [], connected: false })
  assert.ok(body.includes('Static graph (EXTRACTED)'), "today's static behavior")
  assert.ok(body.includes('does not flag observed breaks'), 'honest observed-break nudge')
  assert.ok(body.includes('neat-api-url'), 'nudges the user to connect a host')
})

// ── Observed-break data path over real HTTP (mocked host) ───────────────────
test('fetchObservedBreaks maps observed dependents to a break, drops the un-observed', async () => {
  // The host's real /graph/observed-dependencies shape: origin/dependencies/
  // observed/inboundObservedCount/hasExtractedOutbound. No volume, no timestamp.
  const byId = {
    'route:shop-api:GET /orders/:id': {
      origin: 'route:shop-api:GET /orders/:id',
      dependencies: [],
      observed: true,
      inboundObservedCount: 3,
      hasExtractedOutbound: false,
    },
    'route:shop-api:GET /unused': {
      origin: 'route:shop-api:GET /unused',
      dependencies: [],
      observed: false,
      inboundObservedCount: 0,
      hasExtractedOutbound: true,
    },
  }
  const server = http.createServer((req, res) => {
    const m = req.url.match(/\/graph\/observed-dependencies\/(.+)$/)
    const id = m ? decodeURIComponent(m[1]) : ''
    res.setHeader('content-type', 'application/json')
    if (byId[id]) res.end(JSON.stringify(byId[id]))
    else {
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'node not found' }))
    }
  })
  server.listen(0)
  await once(server, 'listening')
  process.env.INPUT_NEAT_API_URL = `http://127.0.0.1:${server.address().port}`

  const { fetchObservedBreaks } = await import('../src/main.mjs')
  try {
    const breaks = await fetchObservedBreaks([
      { id: 'route:shop-api:GET /orders/:id', type: 'RouteNode', label: 'GET /orders/:id', change: 'removed' },
      { id: 'route:shop-api:GET /unused', type: 'RouteNode', label: 'GET /unused', change: 'removed' },
    ])
    assert.equal(breaks.length, 1, 'only the observed node is a break')
    assert.equal(breaks[0].dependentCount, 3, 'inboundObservedCount surfaces as observed dependents')

    // Render the fetched break: honest count, no invented volume.
    const { body, tier } = renderVerdict({ graph: emptyGraph, delta: emptyDelta, observedBreaks: breaks })
    assert.equal(tier, 'red')
    assert.ok(body.includes('3 observed dependents (OBSERVED). Live callers 404.'))
    assert.doesNotMatch(body, /\d[\d,]*×|last seen|in \d+\s?d\b/)
  } finally {
    server.close()
  }
})

test('fetchObservedBreaks returns [] with no connected host (stays static tier)', async () => {
  delete process.env.INPUT_NEAT_API_URL
  const { fetchObservedBreaks } = await import('../src/main.mjs')
  const out = await fetchObservedBreaks([
    { id: 'route:x:GET /y', type: 'RouteNode', label: 'GET /y', change: 'removed' },
  ])
  assert.deepEqual(out, [])
})

// ── RED with the node-level inbound block (ADR-190) ─────────────────────────
test('RED: a windowed inbound block renders the visceral served/last-seen line', () => {
  const iso = new Date(Date.now() - 14 * 60 * 1000).toISOString() // ~14m ago
  const { body } = renderVerdict(
    redInputs({
      observedBreaks: [
        {
          id: 'route:shop-api:GET /orders/:id',
          type: 'RouteNode',
          label: 'GET /orders/:id',
          change: 'removed',
          dependentCount: 3,
          callCount: 0,
          inboundVolume: 3214,
          window: '7d',
          inboundLastObserved: iso,
        },
      ],
    }),
  )
  assert.ok(body.includes('served 3,214× in 7d'), 'renders the windowed volume from the host')
  assert.match(body, /last seen \d+[smhd] ago/, 'formats the raw recency in the renderer')
  // The traffic line replaces the bare "N observed dependents" degrade line.
  assert.doesNotMatch(body, /3 observed dependents/)
})

test('RED: a lifetime count is labeled lifetime and NEVER rendered as a 7-day rate', () => {
  const iso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { body } = renderVerdict(
    redInputs({
      delta: { ...emptyDelta, tablesRemoved: ['orders-db'] },
      observedBreaks: [
        {
          id: 'infra:orders-db',
          type: 'InfraNode',
          label: 'orders-db',
          change: 'changed',
          dependentCount: 5,
          callCount: 2,
          inboundVolume: 1000,
          window: 'lifetime',
          inboundLastObserved: iso,
        },
      ],
    }),
  )
  assert.ok(body.includes('served 1,000× (lifetime)'), 'labels a lifetime window honestly')
  assert.doesNotMatch(body, /in 7d/, 'a lifetime count is never a fabricated 7-day rate')
  assert.match(body, /last seen \d+[smhd] ago/)
})

test('RED: an absent inbound block degrades to counts, never a fabricated volume', () => {
  // redInputs() default carries dependentCount but no inboundVolume.
  const { body } = renderVerdict(redInputs())
  assert.ok(body.includes('3 observed dependents (OBSERVED)'))
  assert.doesNotMatch(body, /served [\d,]+×|last seen|in 7d/)
})

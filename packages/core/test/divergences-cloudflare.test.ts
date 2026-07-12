import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { computeDivergences } from '../src/divergences.js'
import { runConnectorPoll } from '../src/connectors/index.js'
import {
  CloudflareConnector,
  createCloudflareResolveTarget,
  type CloudflareConnectorConfig,
} from '../src/connectors/cloudflare/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'infra')

// The three real leads an agent uses get_divergences for on a Cloudflare
// project (ADR-133 §Divergence surfacing), proven against the same
// orders-worker/notifications-worker fixture Phase 1's extractor tests use.
describe('get_divergences on a Cloudflare project (ADR-133)', () => {
  beforeEach(() => resetGraph())

  it('a wrangler-declared route with no matching production traffic surfaces as missing-observed', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare'))

    const { divergences } = computeDivergences(graph)
    const entryFileId = 'file:orders-worker:src/index.ts'

    // CONNECTS_TO is in the divergence engine's observable-edge-type allowlist
    // (divergences.ts), so a declared route with no OBSERVED counterpart
    // (no connector poll ran in this test at all) surfaces exactly the way
    // any other declared-but-unobserved CONNECTS_TO edge would.
    const routeMissing = divergences.find(
      (d) =>
        d.type === 'missing-observed' &&
        d.source === entryFileId &&
        d.target === 'infra:cloudflare-route:api.example.com/orders/*',
    )
    expect(routeMissing).toBeDefined()
  })

  it('a declared KV/D1/R2/DO/Queue/cron binding does NOT surface as missing-observed — DEPENDS_ON is deliberately excluded, honestly, not a Cloudflare-specific gap', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare'))

    const { divergences } = computeDivergences(graph)
    const entryFileId = 'file:orders-worker:src/index.ts'

    // divergences.ts's OBSERVABLE_EDGE_TYPES allowlist deliberately excludes
    // DEPENDS_ON (and RUNS_ON) project-wide — the same reason a docker-compose
    // depends_on edge never flags missing-observed either: there is no runtime
    // span shape for "this deploys alongside that", so including it would flag
    // every declared dependency everywhere as noise. Bindings inherit that
    // exclusion rather than getting a Cloudflare-specific carve-out — asserted
    // here so a future OBSERVABLE_EDGE_TYPES change doesn't silently start
    // (or stop) surfacing these without a test noticing.
    const kvMissing = divergences.find(
      (d) => d.type === 'missing-observed' && d.source === entryFileId && d.target === 'infra:cloudflare-kv:SESSIONS',
    )
    expect(kvMissing).toBeUndefined()
  })

  it('a deployed Worker absent from wrangler surfaces as missing-extracted, not a silent connector-log line', async () => {
    const graph = getGraph()
    // Only orders-worker is declared in this scan; notifications-worker is
    // deliberately excluded so its telemetry has no declared graph to land on.
    await extractFromDirectory(graph, path.join(FIXTURES, 'cloudflare', 'orders-worker'))

    const config: CloudflareConnectorConfig = { accountId: 'acct-123' }
    const connector = new CloudflareConnector(config)
    const resolveTarget = createCloudflareResolveTarget(config, graph)

    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: {
            events: {
              count: 1,
              events: [
                {
                  timestamp: Date.now(),
                  $metadata: { service: 'shadow-worker', trigger: 'GET /', statusCode: 200 },
                  $workers: { scriptName: 'shadow-worker', outcome: 'ok' },
                },
              ],
            },
          },
        }),
        { status: 200 },
      )
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    try {
      await runConnectorPoll(connector, { projectDir: '/repo', credentials: { apiToken: 't' } }, graph, resolveTarget)
    } finally {
      globalThis.fetch = originalFetch
    }

    const { divergences } = computeDivergences(graph)
    const found = divergences.find(
      (d) =>
        d.type === 'missing-extracted' &&
        d.source === 'service:shadow-worker' &&
        d.target === 'infra:cloudflare-worker:shadow-worker',
    )
    expect(found).toBeDefined()
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import http2 from 'node:http2'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { MultiDirectedGraph } from 'graphology'
import {
  DivergenceResultSchema,
  EdgeType,
  IncidentCardSchema,
  Provenance,
  infraId,
  type ErrorEvent,
  type FlagDefinition,
  type GraphEdge,
  type GraphNode,
  type InfraNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { computeDivergences } from '../src/divergences.js'
import { handleSpan, mergeObservedFlags, type IngestContext } from '../src/ingest.js'
import { parseOtlpRequest, type ParsedSpan } from '../src/otel.js'
import { buildApi } from '../src/api.js'
import { canonicalFlag, flagFieldsChanged, foldDeclaredFlags, foldObservedFlags, parseFlagDocument } from '../src/flags.js'
import { decodeFetchAllFlagsResponse, fetchFlagdFlags } from '../src/flag-stores/flagd-sync.js'
import { pollFlagStore } from '../src/flag-stores/index.js'
import { isTestPath } from '../src/extract/shared.js'

// Flag grain (ADR-242): a flag store is a dependency, each flag its grain. The
// committed definition and the code that reads the key are EXTRACTED; what the
// store serves is OBSERVED; a flag running in a state nobody committed is a
// flag-mismatch divergence on each service that reads it.

const STORE = infraId('flag-store', 'flagd')

// The shape of otel-demo's src/flagd/demo.flagd.json, trimmed to three flags.
const FLAG_FILE = {
  $schema: 'https://flagd.dev/schema/v0/flags.json',
  flags: {
    cartFailure: {
      description: 'Fail cart service',
      state: 'ENABLED',
      variants: { on: true, off: false },
      defaultVariant: 'off',
    },
    adFailure: {
      description: 'Fail ad service',
      state: 'ENABLED',
      variants: { on: true, off: false },
      defaultVariant: 'off',
    },
    imageSlowLoad: {
      state: 'ENABLED',
      variants: { '10sec': 10000, '5sec': 5000, off: 0 },
      defaultVariant: 'off',
    },
  },
}

const CART_SERVICE_CS = [
  'namespace Cart;',
  'public class CartService {',
  '  // cartFailure in a comment is not a reader',
  '  public async Task EmptyCart() {',
  '    if (await _featureFlagHelper.GetBooleanValueAsync("cartFailure", false)) {',
  '      await _badCartStore.EmptyCartAsync();',
  '    }',
  '  }',
  '}',
  '',
].join('\n')

function newGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

async function writeFile(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
}

async function writeFixture(dir: string): Promise<void> {
  await writeFile(dir, 'src/flagd/demo.flagd.json', JSON.stringify(FLAG_FILE, null, 2))
  await writeFile(dir, 'src/cart/cart.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n')
  await writeFile(dir, 'src/cart/src/services/CartService.cs', CART_SERVICE_CS)
  await writeFile(dir, 'src/ad/package.json', JSON.stringify({ name: 'ad' }))
  await writeFile(dir, 'src/ad/src/flags.ts', "export const AD_FAILURE = 'adFailure'\n")
  // A Cypress spec names a key from outside the service; it is not a reader.
  await writeFile(dir, 'src/ad/cypress/e2e/ad.cy.ts', "cy.setFlag('cartFailure')\n")
}

function storeNode(graph: NeatGraph): InfraNode {
  return graph.getNodeAttributes(STORE) as InfraNode
}

function served(overrides: Record<string, unknown> = {}): Map<string, FlagDefinition> {
  const flags = { ...FLAG_FILE.flags, ...overrides }
  // flagd adds bookkeeping fields the canonical form drops.
  const doc = {
    flags: Object.fromEntries(
      Object.entries(flags).map(([k, v]) => [k, { ...(v as object), source: './etc/flagd/demo.flagd.json', selector: '' }]),
    ),
  }
  return parseFlagDocument(doc)!
}

const CART_ON = {
  cartFailure: { ...FLAG_FILE.flags.cartFailure, defaultVariant: 'on' },
}

describe('flag definitions — canonical form and compare', () => {
  it('drops provider bookkeeping and key order', () => {
    const a = canonicalFlag({ state: 'ENABLED', variants: { on: true, off: false }, defaultVariant: 'off', description: 'x' })!
    const b = canonicalFlag({ defaultVariant: 'off', variants: { off: false, on: true }, state: 'ENABLED', source: 'f', selector: '' })!
    expect(flagFieldsChanged(a, b)).toEqual([])
  })

  it('names the fields that differ, including a targeting-only change', () => {
    const a = canonicalFlag(FLAG_FILE.flags.cartFailure)!
    const b = canonicalFlag({ ...FLAG_FILE.flags.cartFailure, targeting: { if: [{ '==': [1, 1] }, 'on', 'off'] } })!
    expect(flagFieldsChanged(a, b)).toEqual(['targeting'])
    const c = canonicalFlag({ ...FLAG_FILE.flags.cartFailure, defaultVariant: 'on' })!
    expect(flagFieldsChanged(a, c)).toEqual(['defaultVariant'])
  })

  it('recognizes a flag document structurally and nothing else', () => {
    expect(parseFlagDocument(FLAG_FILE)?.size).toBe(3)
    expect(parseFlagDocument({ name: 'pkg', version: '1.0.0' })).toBeNull()
    expect(parseFlagDocument({ flags: { a: { enabled: true } } })).toBeNull()
  })

  it('only folds an observed definition onto a declared flag, counting the rest', () => {
    const declared = foldDeclaredFlags(undefined, [
      { key: 'cartFailure', definition: canonicalFlag(FLAG_FILE.flags.cartFailure)!, declaredIn: 'f.json', readers: [] },
    ])
    const { flags, undeclared } = foldObservedFlags(declared, served(), '2026-10-11T00:00:00.000Z')
    expect(flags.map((f) => f.key)).toEqual(['cartFailure'])
    expect(flags[0]!.provenances).toEqual([Provenance.EXTRACTED, Provenance.OBSERVED])
    expect(undeclared).toEqual(['adFailure', 'imageSlowLoad'])
  })

  it('treats a Cypress spec as a test path', () => {
    expect(isTestPath('src/frontend/cypress/e2e/Checkout.cy.ts')).toBe(true)
    expect(isTestPath('src/frontend/components/Cart.tsx')).toBe(false)
  })
})

describe('flag grain — EXTRACTED: the flag file and the literal join', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-flags-'))
    await writeFixture(tmp)
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('mints one flag-store node carrying every committed flag', async () => {
    const graph = newGraph()
    await extractFromDirectory(graph, tmp)
    const node = storeNode(graph)
    expect(node.kind).toBe('flag-store')
    expect(node.provider).toBe('flagd')
    expect(node.flags!.map((f) => f.key)).toEqual(['adFailure', 'cartFailure', 'imageSlowLoad'])
    const cart = node.flags!.find((f) => f.key === 'cartFailure')!
    expect(cart.declared).toEqual({ state: 'ENABLED', defaultVariant: 'off', variants: { off: false, on: true } })
    expect(cart.declaredIn).toBe('src/flagd/demo.flagd.json')
    expect(cart.provenances).toEqual([Provenance.EXTRACTED])
  })

  it('records the code that holds a key as a literal, in any language, and not a comment or a test', async () => {
    const graph = newGraph()
    await extractFromDirectory(graph, tmp)
    const flags = storeNode(graph).flags!
    const cart = flags.find((f) => f.key === 'cartFailure')!
    expect(cart.readers).toEqual([{ file: 'file:cart:src/services/CartService.cs', service: 'service:cart', line: 5 }])
    const ad = flags.find((f) => f.key === 'adFailure')!
    expect(ad.readers).toEqual([{ file: 'file:ad:src/flags.ts', service: 'service:ad', line: 1 }])
    expect(flags.find((f) => f.key === 'imageSlowLoad')!.readers).toBeUndefined()

    const edge = graph.getEdgeAttributes(
      graph.edges('file:cart:src/services/CartService.cs', STORE)[0]!,
    ) as GraphEdge
    expect(edge.type).toBe(EdgeType.CONNECTS_TO)
    expect(edge.provenance).toBe(Provenance.EXTRACTED)
    expect(edge.evidence).toEqual({ file: 'src/cart/src/services/CartService.cs', line: 5 })
  })

  it('emits no flag divergence while nothing is observed', async () => {
    const graph = newGraph()
    await extractFromDirectory(graph, tmp)
    const r = computeDivergences(graph, { type: new Set(['flag-mismatch']) })
    expect(r.divergences).toEqual([])
  })
})

describe('flag grain — OBSERVED and the flag-mismatch divergence', () => {
  let tmp: string
  let graph: NeatGraph
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-flags-'))
    await writeFixture(tmp)
    graph = newGraph()
    await extractFromDirectory(graph, tmp)
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('stays silent when the store serves exactly what is committed', () => {
    mergeObservedFlags(graph, 'flagd', served(), '2026-10-11T00:00:00.000Z')
    expect(computeDivergences(graph, { type: new Set(['flag-mismatch']) }).divergences).toEqual([])
  })

  it('names the flag on the service that reads it when the store serves another default', () => {
    mergeObservedFlags(graph, 'flagd', served(CART_ON), '2026-10-11T00:00:00.000Z')
    const r = computeDivergences(graph, { node: 'service:cart' })
    DivergenceResultSchema.parse(r)
    const flag = r.divergences.filter((d) => d.type === 'flag-mismatch')
    expect(flag).toHaveLength(1)
    expect(flag[0]).toMatchObject({
      type: 'flag-mismatch',
      source: 'service:cart',
      target: STORE,
      flagKey: 'cartFailure',
      changed: ['defaultVariant'],
      declaredVariant: 'off',
      observedVariant: 'on',
      readers: ['src/services/CartService.cs:5'],
      confidence: 0.9,
    })
    expect(flag[0]!.reason).toContain('cartFailure')
    // The ad service does not read cartFailure, so it carries nothing.
    expect(computeDivergences(graph, { node: 'service:ad', type: new Set(['flag-mismatch']) }).divergences).toEqual([])
  })

  it('lands on the store alone for a flag no code reads', () => {
    mergeObservedFlags(graph, 'flagd', served({ imageSlowLoad: { ...FLAG_FILE.flags.imageSlowLoad, defaultVariant: '10sec' } }), 'now')
    const d = computeDivergences(graph, { type: new Set(['flag-mismatch']) }).divergences
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ source: STORE, target: STORE, flagKey: 'imageSlowLoad' })
  })

  it('compares a service evaluation only when it was untargeted', async () => {
    const ctx: IngestContext = { graph, errorsPath: path.join(tmp, 'errors.ndjson') }
    const span = (reason: string): ParsedSpan => ({
      ...parseOtlpRequest(otlpWithFlagEvent('cartFailure', 'on', reason))[0]!,
    })
    await handleSpan(ctx, span('targeting_match'))
    expect(computeDivergences(graph, { type: new Set(['flag-mismatch']) }).divergences).toEqual([])
    await handleSpan(ctx, span('static'))
    const d = computeDivergences(graph, { type: new Set(['flag-mismatch']) }).divergences
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ source: 'service:cart', flagKey: 'cartFailure', observedVariant: 'on' })
    // The evaluation is the OBSERVED twin of the literal join's dependency edge.
    const observed = graph.filterEdges('service:cart', STORE, (_, e) => (e as GraphEdge).provenance === Provenance.OBSERVED)
    expect(observed).toHaveLength(1)
  })

  it('puts the flag on the card for the erroring service, read through the API', async () => {
    mergeObservedFlags(graph, 'flagd', served(CART_ON), '2026-10-11T00:00:00.000Z')
    const errorsPath = path.join(tmp, 'errors.ndjson')
    const ev: ErrorEvent = {
      id: 't1:s1',
      timestamp: '2026-10-11T10:00:00.000Z',
      service: 'cart',
      traceId: 't1',
      spanId: 's1',
      errorMessage: "Can't access cart storage. System.ApplicationException: Wasn't able to connect to redis",
      exceptionType: 'System.ApplicationException',
      affectedNode: 'service:cart',
    }
    await fs.writeFile(errorsPath, JSON.stringify(ev) + '\n', 'utf8')
    const app = await buildApi({ graph, errorsPath })
    try {
      const res = await app.inject({ method: 'GET', url: '/graph/incident-card/service:cart' })
      expect(res.statusCode).toBe(200)
      const card = IncidentCardSchema.parse(res.json())
      expect(card.divergence).toContainEqual({
        type: 'flag-mismatch',
        summary: 'flag cartFailure: committed off, running on (read at src/services/CartService.cs:5)',
      })
      const div = await app.inject({ method: 'GET', url: '/graph/divergences?type=flag-mismatch' })
      expect(div.json().divergences).toHaveLength(1)
    } finally {
      await app.close()
    }
  })
})

describe('flagd sync reader', () => {
  let server: http2.Http2Server
  let endpoint: string
  let serving: unknown
  let status = '0'

  beforeEach(async () => {
    status = '0'
    serving = { flags: { ...FLAG_FILE.flags, ...CART_ON } }
    server = http2.createServer()
    server.on('stream', (stream, headers) => {
      expect(headers[':path']).toBe('/flagd.sync.v1.FlagSyncService/FetchAllFlags')
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': status }))
      if (status === '0') stream.write(grpcFrame(JSON.stringify(serving)))
      stream.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    endpoint = `127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('decodes FetchAllFlags into canonical definitions', async () => {
    const flags = await fetchFlagdFlags(endpoint)
    expect(flags.get('cartFailure')?.defaultVariant).toBe('on')
    expect(flags.size).toBe(3)
  })

  it('skips fields it does not know', () => {
    const json = Buffer.from('{"flags":{}}')
    const msg = Buffer.concat([Buffer.from([0x12, 0x01, 0x78]), Buffer.from([0x0a, json.length]), json])
    expect(decodeFetchAllFlagsResponse(msg)).toBe('{"flags":{}}')
  })

  it('folds a poll onto the grain and writes nothing when the store fails', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-flags-'))
    try {
      await writeFixture(tmp)
      const graph = newGraph()
      await extractFromDirectory(graph, tmp)
      const entry = { id: 'demo', provider: 'flagd', endpoint }
      const ok = await pollFlagStore(graph, entry)
      expect(ok).toMatchObject({ ok: true, served: 3, undeclared: [] })
      expect(storeNode(graph).flags!.find((f) => f.key === 'cartFailure')!.observed?.defaultVariant).toBe('on')

      status = '14'
      const failed = await pollFlagStore(graph, entry)
      expect(failed.ok).toBe(false)
      expect(failed.error).toContain('grpc-status 14')
      // The last observed state stands; a failed poll never clears it.
      expect(storeNode(graph).flags!.find((f) => f.key === 'cartFailure')!.observed?.defaultVariant).toBe('on')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('feature_flag.evaluation span events', () => {
  it('reads the current semconv names and the legacy ones', () => {
    const current = parseOtlpRequest(otlpWithFlagEvent('cartFailure', 'on', 'static'))[0]!
    expect(current.flagEvaluations).toEqual([{ key: 'cartFailure', variant: 'on', provider: 'flagd', reason: 'static' }])
    const legacy = parseOtlpRequest(
      otlpWith('feature_flag', [
        kv('feature_flag.key', 'adFailure'),
        kv('feature_flag.variant', 'off'),
        kv('feature_flag.provider_name', 'flagd'),
        kv('feature_flag.evaluation.reason', 'DEFAULT'),
      ]),
    )[0]!
    expect(legacy.flagEvaluations).toEqual([{ key: 'adFailure', variant: 'off', provider: 'flagd', reason: 'DEFAULT' }])
  })
})

function kv(key: string, value: string): { key: string; value: { stringValue: string } } {
  return { key, value: { stringValue: value } }
}

function otlpWith(eventName: string, attributes: ReturnType<typeof kv>[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', 'cart')] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: '0af7651916cd43dd8448eb211c80319c',
                spanId: 'b7ad6b7169203331',
                name: 'POST /oteldemo.CartService/EmptyCart',
                kind: 2,
                startTimeUnixNano: '1760140800000000000',
                endTimeUnixNano: '1760140800010000000',
                attributes: [],
                events: [{ name: eventName, timeUnixNano: '1760140800005000000', attributes }],
              },
            ],
          },
        ],
      },
    ],
  }
}

function otlpWithFlagEvent(key: string, variant: string, reason: string) {
  return otlpWith('feature_flag.evaluation', [
    kv('feature_flag.key', key),
    kv('feature_flag.result.variant', variant),
    kv('feature_flag.provider.name', 'flagd'),
    kv('feature_flag.result.reason', reason),
  ])
}

// A FetchAllFlagsResponse with `flag_configuration` set, gRPC length-prefixed.
function grpcFrame(json: string): Buffer {
  const body = Buffer.from(json, 'utf8')
  const len: number[] = []
  let n = body.length
  while (n > 0x7f) {
    len.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  len.push(n)
  const msg = Buffer.concat([Buffer.from([0x0a, ...len]), body])
  const head = Buffer.alloc(5)
  head.writeUInt32BE(msg.length, 1)
  return Buffer.concat([head, msg])
}

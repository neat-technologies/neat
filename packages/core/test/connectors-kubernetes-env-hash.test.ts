import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { MultiDirectedGraph } from 'graphology'
import { EdgeType, NodeType, Provenance, type ErrorEvent, type GraphEdge, type GraphNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { runConnectorPoll, type ConnectorContext } from '../src/connectors/index.js'
import {
  ENV_HASH_KEY_FILE,
  configMapDataHashes,
  configMapsPath,
  createKubernetesConnector,
  deploymentsPath,
  envValueHash,
  loadEnvSalt,
  podTemplateSpec,
  podsPath,
  type Deployment,
  type Pod,
} from '../src/connectors/kubernetes/index.js'
import { changesSinceHealthy, resetBaselineState } from '../src/healthy-baseline.js'
import { saveGraphToDisk } from '../src/persist.js'
import { buildApi } from '../src/api.js'

// #1487 follow-on — a literal env value changed under the same name used to be
// invisible: the spec keeps env names, never values. Each literal now carries
// `valueHash`, HMAC-SHA256 under a per-project salt in neat-out (0600, never in
// the graph). The frontend Deployment is astronomy-shop's healthy one (the
// ADR-270 fixture); the fault sets CART_ADDR from cart:8080 to cart:9999.

const here = path.dirname(fileURLToPath(import.meta.url))
const NS = 'astronomy-shop'
const healthyFrontend = (): Deployment =>
  JSON.parse(readFileSync(path.join(here, 'fixtures', 'healthy-baseline', 'astronomy-frontend-healthy.json'), 'utf8')) as Deployment

function withCartAddr(value: string): Deployment {
  const d = healthyFrontend()
  const c = d.spec!.template!.spec!.containers![0]!
  c.env = (c.env ?? []).map((e) => (e.name === 'CART_ADDR' ? { ...e, value } : e))
  return { ...d, status: { replicas: 1, readyReplicas: 1, availableReplicas: 1 } }
}

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-envhash-'))
  resetBaselineState()
  process.env.NEAT_BASELINE_HOLD_MS = '0'
})
afterEach(async () => {
  delete process.env.NEAT_BASELINE_HOLD_MS
  await fs.rm(dir, { recursive: true, force: true })
})

describe('the env-hash salt', () => {
  it('is created once, 0600, and read back the same', async () => {
    const a = await loadEnvSalt(dir)
    const b = await loadEnvSalt(dir)
    expect(a).toBeDefined()
    expect(a!.equals(b!)).toBe(true)
    const stat = await fs.stat(path.join(dir, ENV_HASH_KEY_FILE))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('tightens a key file left readable', async () => {
    await loadEnvSalt(dir)
    await fs.chmod(path.join(dir, ENV_HASH_KEY_FILE), 0o644)
    await loadEnvSalt(dir)
    expect((await fs.stat(path.join(dir, ENV_HASH_KEY_FILE))).mode & 0o777).toBe(0o600)
  })

  it('keys the hash: same value same hash, another value or another salt a different one', async () => {
    const salt = (await loadEnvSalt(dir))!
    const other = Buffer.alloc(32, 7)
    expect(envValueHash(salt, 'cart:8080')).toMatch(/^[0-9a-f]{16}$/)
    expect(envValueHash(salt, 'cart:8080')).toBe(envValueHash(salt, 'cart:8080'))
    expect(envValueHash(salt, 'cart:8080')).not.toBe(envValueHash(salt, 'cart:9999'))
    expect(envValueHash(other, 'cart:8080')).not.toBe(envValueHash(salt, 'cart:8080'))
  })
})

describe('env entries in the pod-template spec', () => {
  it('hash a literal under the salt, keep a reference by name and key, and never the value', () => {
    const salt = Buffer.alloc(32, 1)
    const d = withCartAddr('cart:8080')
    d.spec!.template!.spec!.containers![0]!.env!.push({
      name: 'DB_PASSWORD',
      valueFrom: { secretKeyRef: { name: 'db-creds', key: 'password' } },
    })
    const env = (podTemplateSpec(d, salt)['containers'] as Array<{ env: Array<Record<string, unknown>> }>)[0]!.env
    expect(env.find((e) => e['name'] === 'CART_ADDR')).toEqual({ name: 'CART_ADDR', valueHash: envValueHash(salt, 'cart:8080') })
    expect(env.find((e) => e['name'] === 'DB_PASSWORD')).toEqual({ name: 'DB_PASSWORD', secret: 'db-creds', key: 'password' })
    expect(env.find((e) => e['name'] === 'OTEL_SERVICE_NAME')).not.toHaveProperty('valueHash')
    expect(JSON.stringify(env)).not.toContain('cart:8080')
    // Without a salt, a literal keeps its name only.
    const bare = (podTemplateSpec(d)['containers'] as Array<{ env: Array<Record<string, unknown>> }>)[0]!.env
    expect(bare.find((e) => e['name'] === 'CART_ADDR')).toEqual({ name: 'CART_ADDR' })
  })
})

describe('a changed env value since healthy', () => {
  function graph(): NeatGraph {
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    for (const s of ['frontend-proxy', 'frontend']) {
      g.addNode(`service:${s}`, { id: `service:${s}`, type: NodeType.ServiceNode, name: s, language: 'ts' } as GraphNode)
    }
    const c = 'CALLS:OBSERVED:service:frontend-proxy->service:frontend'
    g.addEdgeWithKey(c, 'service:frontend-proxy', 'service:frontend', {
      id: c,
      source: 'service:frontend-proxy',
      target: 'service:frontend',
      type: EdgeType.CALLS,
      provenance: Provenance.OBSERVED,
      callCount: 100,
      signal: { spanCount: 100, errorCount: 0 },
    } as GraphEdge)
    return g
  }
  const frontendPod: Pod = {
    metadata: { name: 'frontend-abc', namespace: NS, labels: { 'opentelemetry.io/name': 'frontend' } },
    status: { phase: 'Running', containerStatuses: [{ name: 'frontend', ready: true, restartCount: 0, state: { running: {} } }] },
  }

  async function poll(g: NeatGraph, frontend: Deployment, errorsPath: string, flagd = 'off'): Promise<void> {
    const lists: Record<string, unknown[]> = {
      [deploymentsPath(NS)]: [frontend],
      [podsPath(NS)]: [frontendPod],
      [configMapsPath(NS)]: [{ metadata: { name: 'flagd-config', namespace: NS }, data: { 'demo.flagd.json': `{"flags":{"adFailure":{"defaultVariant":"${flagd}"}}}` } }],
    }
    const fetchImpl = (async (url: string | URL) => {
      const items = lists[new URL(String(url)).pathname]
      if (!items) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ items }) } as Response
    }) as unknown as typeof fetch
    const { connector, resolveTarget } = createKubernetesConnector(g, { namespace: NS, apiServerUrl: 'https://k8s-envhash.test' }, fetchImpl)
    const ctx: ConnectorContext = { projectDir: '/repo', credentials: { token: 't' }, errorsPath }
    await runConnectorPoll(connector, ctx, g, resolveTarget)
  }

  it('shows in /graph/changes, and neither the value nor the salt reaches the graph or a baseline', async () => {
    const errorsPath = path.join(dir, 'errors.ndjson')
    const g = graph()
    for (let i = 0; i < 2; i++) await poll(g, withCartAddr('cart:8080'), errorsPath)
    await poll(g, withCartAddr('cart:9999'), errorsPath)
    const ev: ErrorEvent = {
      id: 't:1',
      timestamp: new Date().toISOString(),
      service: 'frontend-proxy',
      traceId: 't',
      spanId: '1',
      errorMessage: 'HTTP 502 upstream connect error',
      affectedNode: 'service:frontend-proxy',
    } as ErrorEvent
    await fs.appendFile(errorsPath, JSON.stringify(ev) + '\n')

    const app = await buildApi({ graph: g, errorsPath })
    try {
      const res = (await app.inject({ method: 'GET', url: '/graph/changes' })).json()
      const frontend = res.changes.find((c: { id: string }) => c.id === 'k8s:k8s-deployment/astronomy-shop/frontend')
      expect(frontend).toMatchObject({ kind: 'object', change: 'modified' })
      const salt = (await loadEnvSalt(dir))!
      expect(frontend.fields).toEqual([
        {
          path: '/containers/frontend/env/CART_ADDR/valueHash',
          before: envValueHash(salt, 'cart:8080'),
          after: envValueHash(salt, 'cart:9999'),
        },
      ])
    } finally {
      await app.close()
    }

    const snapshot = path.join(dir, 'graph.json')
    await saveGraphToDisk(g, snapshot)
    const saltHex = (await fs.readFile(path.join(dir, ENV_HASH_KEY_FILE), 'utf8')).trim()
    const files = [snapshot, path.join(dir, 'baselines.ndjson')]
    for (const f of await fs.readdir(path.join(dir, 'baselines', 'objects'))) files.push(path.join(dir, 'baselines', 'objects', f))
    for (const f of files) {
      const text = await fs.readFile(f, 'utf8')
      expect(text).not.toContain('cart:8080')
      expect(text).not.toContain('cart:9999')
      expect(text).not.toContain(saltHex)
    }
  })

  it('a ConfigMap value changed under the same key shows the same way', async () => {
    const errorsPath = path.join(dir, 'errors.ndjson')
    const g = graph()
    for (let i = 0; i < 2; i++) await poll(g, withCartAddr('cart:8080'), errorsPath, 'off')
    await poll(g, withCartAddr('cart:8080'), errorsPath, 'on')
    const salt = (await loadEnvSalt(dir))!
    const res = await changesSinceHealthy(g, dir)
    const cm = res.changes.find((c) => c.id === 'k8s:k8s-configmap/astronomy-shop/flagd-config')
    expect(cm?.fields).toEqual([
      {
        path: '/data/demo.flagd.json',
        before: `hmac:${envValueHash(salt, '{"flags":{"adFailure":{"defaultVariant":"off"}}}')}`,
        after: `hmac:${envValueHash(salt, '{"flags":{"adFailure":{"defaultVariant":"on"}}}')}`,
      },
    ])
    const objects = await fs.readdir(path.join(dir, 'baselines', 'objects'))
    for (const f of objects) expect(await fs.readFile(path.join(dir, 'baselines', 'objects', f), 'utf8')).not.toContain('adFailure')
  })
})

describe('ConfigMap values under the same salt', () => {
  it('hash per key under the salt, and record only presence without one', () => {
    const salt = Buffer.alloc(32, 3)
    const cm = { metadata: { name: 'flagd-config' }, data: { 'demo.flagd.json': '{"flags":{}}' } }
    expect(configMapDataHashes(cm, salt)).toEqual({ 'demo.flagd.json': `hmac:${envValueHash(salt, '{"flags":{}}')}` })
    expect(configMapDataHashes(cm)).toEqual({ 'demo.flagd.json': 'present' })
  })
})

describe('baselines from before the salt', () => {
  it('are never the base: one written earlier would read every value as changed', async () => {
    // A manifest left by an earlier version, before this project had a salt.
    const old = { takenAt: '2026-10-01T00:00:00.000Z', objects: {}, flags: {}, erroringEdges: [] }
    await fs.writeFile(path.join(dir, 'baselines.ndjson'), JSON.stringify(old) + '\n')
    await loadEnvSalt(dir)
    const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
    expect((await changesSinceHealthy(g, dir, { at: new Date().toISOString() })).base).toBeNull()
  })
})

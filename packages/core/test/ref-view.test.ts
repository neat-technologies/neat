import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import git from 'isomorphic-git'
import {
  EdgeType,
  NodeType,
  Provenance,
  RefBlockSchema,
  SerializedGraphSchema,
  fileId,
  observedEdgeId,
  serviceId,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import { getGraph, listProjects, makeGraph, resetGraph, type NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { buildStaticLayer, composeView, resolveView } from '../src/extract/ref-view.js'
import { RefRegistry, commitKey } from '../src/ref-registry.js'
import { saveGraphToDisk } from '../src/persist.js'
import { buildApi } from '../src/api.js'

// Ref views (ADR-278, ref-views.md §7). A read with `?ref=` is answered from a
// view: the ref's static layer, the other repositories' live static layers and
// the live runtime layer, composed when the request starts.

// The card route awaits its incident read. `gate.hold` parks that read so a test
// can change the live graph while a request is in the middle of its work.
const gate = vi.hoisted(() => ({
  hold: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
}))
vi.mock('../src/ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ingest.js')>()
  return {
    ...actual,
    readErrorEvents: async (...args: Parameters<typeof actual.readErrorEvents>) => {
      const events = await actual.readErrorEvents(...args)
      if (gate.hold) {
        gate.entered?.()
        await gate.hold
      }
      return events
    },
  }
})

const APP = 'acme/app'
const OTHER = 'acme/other'
const author = { name: 'test', email: 'test@example.com' }
const dirs: string[] = []

afterEach(async () => {
  gate.hold = undefined
  gate.entered = undefined
  resetGraph()
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function tmp(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `neat-ref-view-${name}-`))
  dirs.push(dir)
  return dir
}

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), body, 'utf8')
  }
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git.add({ fs: nodeFs, dir, filepath: '.' })
  return git.commit({ fs: nodeFs, dir, message, author })
}

async function tree(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(child)
      else out.push(child)
    }
  }
  await walk('')
  return out.sort()
}

function observed(source: string, target: string): GraphEdge {
  return {
    id: observedEdgeId(source, target, EdgeType.CALLS),
    source,
    target,
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    confidence: 1,
    lastObserved: new Date().toISOString(),
    callCount: 3,
  } as GraphEdge
}

function addObserved(graph: NeatGraph, source: string, target: string): string {
  const edge = observed(source, target)
  graph.addEdgeWithKey(edge.id, source, target, edge)
  return edge.id
}

const A = serviceId('svc-a')
const B = serviceId('svc-b')
const C = serviceId('svc-c')
const GHOST = serviceId('ghost')
const A_INDEX = fileId('svc-a', 'index.js')
const A_EXTRA = fileId('svc-a', 'extra.js')
const B_INDEX = fileId('svc-b', 'index.js')
const LEFT_PAD = 'dep:npm:left-pad@1.3.0'

interface World {
  repo: string
  live: NeatGraph
  oldSha: string
  headSha: string
  errorsPath: string
  runtimeEdges: { shown: string; onRemovedFile: string; onRemovedService: string; toGhost: string }
}

/**
 * One project, two repositories. acme/app is a git checkout with two commits:
 * the old one has svc-a alone, the head adds a dependency, a file (extra.js) and
 * a second service (svc-c). acme/other is svc-b, which declares the same
 * dependency. The live graph is both at their heads, plus a runtime layer.
 */
async function world(): Promise<World> {
  const repo = await tmp('app')
  await git.init({ fs: nodeFs, dir: repo })
  await write(repo, {
    'svc-a/package.json': JSON.stringify({ name: 'svc-a', version: '1.0.0' }),
    'svc-a/index.js': 'function helper(n) { return n }\nfunction main() { return helper(1) }\nmodule.exports = { main, helper }\n',
  })
  const oldSha = await commitAll(repo, 'svc-a')
  await write(repo, {
    'svc-a/package.json': JSON.stringify({ name: 'svc-a', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    'svc-a/index.js':
      "const pad = require('left-pad')\nfunction helper(n) { return pad(String(n), 3) }\nfunction main() { return helper(1) }\nmodule.exports = { main, helper }\n",
    'svc-a/extra.js': 'function extra() { return 2 }\nmodule.exports = { extra }\n',
    'svc-c/package.json': JSON.stringify({ name: 'svc-c', version: '1.0.0' }),
    'svc-c/index.js': 'function serve() { return 3 }\nmodule.exports = { serve }\n',
  })
  const headSha = await commitAll(repo, 'svc-c, extra.js and left-pad')

  const other = await tmp('other')
  await write(other, {
    'svc-b/package.json': JSON.stringify({ name: 'svc-b', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    'svc-b/index.js': "const pad = require('left-pad')\nfunction b() { return pad('1', 3) }\nmodule.exports = { b }\n",
  })

  const live = getGraph()
  await extractFromDirectory(live, repo, {
    source: APP,
    sourceCommit: { repository: APP, sha: headSha },
    announce: false,
  })
  await extractFromDirectory(live, other, { source: OTHER, announce: false })
  expect(live.getNodeAttributes(LEFT_PAD).declaredBy).toEqual([APP, OTHER])

  // The runtime layer: a runtime-discovered service, runtime attributes on a
  // declared one, and observed calls.
  live.addNode(GHOST, {
    id: GHOST,
    type: NodeType.ServiceNode,
    name: 'ghost',
    language: 'unknown',
    discoveredVia: 'otel',
  } as GraphNode)
  live.replaceNodeAttributes(A, { ...live.getNodeAttributes(A), env: 'prod', discoveredVia: 'merged' } as GraphNode)
  const runtimeEdges = {
    shown: addObserved(live, A_INDEX, B),
    onRemovedFile: addObserved(live, A_EXTRA, B),
    onRemovedService: addObserved(live, B_INDEX, C),
    toGhost: addObserved(live, A, GHOST),
  }

  const out = await tmp('out')
  const errorsPath = path.join(out, 'errors.ndjson')
  await writeFile(
    errorsPath,
    JSON.stringify({
      id: 'err-1',
      timestamp: '2026-11-16T10:00:00.000Z',
      service: 'svc-a',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      errorMessage: 'boom',
      affectedNode: A,
    }) + '\n',
  )
  return { repo, live, oldSha, headSha, errorsPath, runtimeEdges }
}

async function api(w: World, registry = new RefRegistry(), refBuild = {}) {
  const app = await buildApi({
    graph: w.live,
    scanPath: w.repo,
    errorsPath: w.errorsPath,
    refs: registry,
    refBuild,
  })
  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url })
    return { status: res.statusCode, body: res.json() }
  }
  /** Ask for a commit's layer and wait for its build. Returns the ref key. */
  const built = async (sha: string, repository = APP): Promise<string> => {
    const res = await app.inject({ method: 'POST', url: '/refs', payload: { repository, sha } })
    expect([200, 202]).toContain(res.statusCode)
    const { ref } = res.json() as { ref: string }
    const found = registry.find('default', ref)
    if (!('entry' in found)) throw new Error(`no entry for ${ref}`)
    await found.entry.settled
    return ref
  }
  return { app, get, built, registry }
}

const byId = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => (a.id < b.id ? -1 : 1))

// An answer without its `ref` block and without the one field that is the
// moment it was computed.
function plain(body: Record<string, unknown>): Record<string, unknown> {
  const { ref: _ref, computedAt: _computedAt, ...rest } = body
  return rest
}

const READ_ROUTES = (node: string): string[] => [
  '/graph',
  `/graph/node/${encodeURIComponent(node)}`,
  `/graph/blast-radius/${encodeURIComponent(node)}`,
  `/graph/dependencies/${encodeURIComponent(node)}`,
  `/graph/root-cause/${encodeURIComponent(node)}`,
  '/graph/divergences',
  `/graph/incident-card/${encodeURIComponent(node)}`,
]

describe('a view at the live graph\'s own commit', () => {
  it('answers every sampled query the same as the live graph and hides no runtime edge', async () => {
    const w = await world()
    const { get, built } = await api(w)
    const ref = await built(w.headSha)
    expect(ref).toBe(commitKey(w.headSha))

    const liveGraph = await get('/graph')
    const viewGraph = await get(`/graph?ref=${ref}`)
    expect(viewGraph.status).toBe(200)
    expect(SerializedGraphSchema.safeParse(viewGraph.body).success).toBe(true)
    expect(viewGraph.body.ref).toEqual({ key: ref, hiddenRuntimeEdges: 0 })
    expect(byId(viewGraph.body.nodes)).toEqual(byId(liveGraph.body.nodes))
    expect(byId(viewGraph.body.edges)).toEqual(byId(liveGraph.body.edges))
    expect(liveGraph.body.ref).toBeUndefined()

    const sampled = w.live.nodes()
    expect(sampled.length).toBeGreaterThan(10)
    let compared = 0
    for (const node of sampled) {
      for (const route of READ_ROUTES(node).slice(1)) {
        const fromLive = await get(route)
        const fromView = await get(`${route}${route.includes('?') ? '&' : '?'}ref=${ref}`)
        expect(fromView.status, route).toBe(fromLive.status)
        expect(plain(fromView.body), route).toEqual(plain(fromLive.body))
        // Every answer from a view says which ref it is and what it hides.
        expect(fromView.body.ref, route).toEqual({ key: ref, hiddenRuntimeEdges: 0 })
        expect(fromLive.body.ref, route).toBeUndefined()
        compared++
      }
    }
    expect(compared).toBe(sampled.length * 6)
  })

  it('carries the layer\'s own baseline for its repository and the live one for the others', async () => {
    const w = await world()
    const { get, built } = await api(w)
    const head = await built(w.headSha)
    const old = await built(w.oldSha)
    const other = { status: 'unavailable', repository: OTHER }
    expect((await get('/graph')).body.sourceBaselines).toEqual([
      { status: 'ready', repository: APP, sha: w.headSha },
      other,
    ])
    expect((await get(`/graph?ref=${head}`)).body.sourceBaselines).toEqual([
      { status: 'ready', repository: APP, sha: w.headSha, state: 'commit' },
      other,
    ])
    expect((await get(`/graph?ref=${old}`)).body.sourceBaselines).toEqual([
      { status: 'ready', repository: APP, sha: w.oldSha, state: 'commit' },
      other,
    ])
    // The same evidence on its own route, with no nodes or edges beside it.
    for (const query of ['', `?ref=${head}`, `?ref=${old}`]) {
      const alone = await get(`/source-baselines${query}`)
      const whole = await get(`/graph${query}`)
      expect(alone.status).toBe(200)
      expect(Object.keys(alone.body).sort()).toEqual(query ? ['ref', 'sourceBaselines'] : ['sourceBaselines'])
      expect(alone.body.sourceBaselines).toEqual(whole.body.sourceBaselines)
      expect(alone.body.ref).toEqual(whole.body.ref)
    }
    const unknown = await get(`/source-baselines?ref=${encodeURIComponent(`commit:${'0'.repeat(40)}`)}`)
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe('ref_not_found')
    expect(unknown.body.sourceBaselines).toBeUndefined()
  })
})

describe('a view at an older commit', () => {
  it('drops what only the ref\'s repository declared, keeps the rest, and counts the runtime edges it hides', async () => {
    const w = await world()
    const { get, built } = await api(w)
    const ref = await built(w.oldSha)

    const { body } = await get(`/graph?ref=${ref}`)
    const nodes = new Map((body.nodes as GraphNode[]).map((n) => [n.id, n]))
    const edges = new Map((body.edges as GraphEdge[]).map((e) => [e.id, e]))

    // svc-c is declared at live by acme/app alone and is absent at the ref.
    expect(w.live.getNodeAttributes(C).declaredBy).toEqual([APP])
    expect(nodes.has(C)).toBe(false)
    expect(nodes.has(fileId('svc-c', 'index.js'))).toBe(false)
    expect((await get(`/graph/node/${encodeURIComponent(C)}?ref=${ref}`)).status).toBe(404)
    // A file removed at the ref is gone too.
    expect(nodes.has(A_EXTRA)).toBe(false)

    // The dependency is absent at the ref, but acme/other declares it as well: it stays, as theirs.
    expect(nodes.get(LEFT_PAD)?.declaredBy).toEqual([OTHER])
    expect(edges.has(`DEPENDS_ON:${A}->${LEFT_PAD}`)).toBe(false)
    expect(edges.has(`DEPENDS_ON:${B}->${LEFT_PAD}`)).toBe(true)

    // The other repository comes through untouched.
    for (const id of w.live.nodes()) {
      const attrs = w.live.getNodeAttributes(id)
      if (attrs.declaredBy?.length === 1 && attrs.declaredBy[0] === OTHER) expect(nodes.get(id), id).toEqual(attrs)
    }

    // A runtime-discovered node always shows, with its edge.
    expect(nodes.get(GHOST)).toEqual(w.live.getNodeAttributes(GHOST))
    expect(edges.get(w.runtimeEdges.toGhost)).toEqual(w.live.getEdgeAttributes(w.runtimeEdges.toGhost))
    expect(edges.has(w.runtimeEdges.shown)).toBe(true)
    // The ref's declared fields, with the runtime fields carried over.
    expect(nodes.get(A)).toMatchObject({ env: 'prod', discoveredVia: 'merged', declaredBy: [APP] })
    // svc-a at the old commit calls helper without left-pad.
    expect(edges.has(`IMPORTS:${A_INDEX}->${LEFT_PAD}`)).toBe(false)

    // Two runtime edges lost an endpoint: one on the removed file, one on the absent service.
    expect(edges.has(w.runtimeEdges.onRemovedFile)).toBe(false)
    expect(edges.has(w.runtimeEdges.onRemovedService)).toBe(false)
    expect(body.ref).toEqual({ key: ref, hiddenRuntimeEdges: 2 })
    expect(RefBlockSchema.safeParse(body.ref).success).toBe(true)

    // Nothing in the view dangles.
    for (const e of edges.values()) {
      expect(nodes.has(e.source) && nodes.has(e.target), e.id).toBe(true)
    }
    // The live graph is as it was.
    expect(w.live.hasNode(C)).toBe(true)
    expect(w.live.getNodeAttributes(LEFT_PAD).declaredBy).toEqual([APP, OTHER])
  })

  it('counts a file removed at the ref: each runtime edge on it is hidden and the count says so', () => {
    const live = makeGraph()
    const layer = makeGraph()
    const node = (id: string, extra: Record<string, unknown> = {}): GraphNode =>
      ({ id, type: NodeType.FileNode, name: id, declaredBy: [APP], ...extra }) as unknown as GraphNode
    for (const g of [live, layer]) g.addNode('file:s:kept.js', node('file:s:kept.js'))
    live.addNode('file:s:gone.js', node('file:s:gone.js'))
    live.addNode('file:s:unknown.js', node('file:s:unknown.js', { declaredBy: undefined }))
    addObserved(live, 'file:s:gone.js', 'file:s:kept.js')
    addObserved(live, 'file:s:kept.js', 'file:s:gone.js')
    const kept = addObserved(live, 'file:s:unknown.js', 'file:s:kept.js')

    const view = composeView(layer, live, APP)
    expect(view.hiddenRuntimeEdges).toBe(2)
    expect(view.graph.hasNode('file:s:gone.js')).toBe(false)
    // No recorded declarer is unknown, treated as someone else's: it stays.
    expect(view.graph.hasNode('file:s:unknown.js')).toBe(true)
    expect(view.graph.edges()).toEqual([kept])
    // Composing wrote to neither input.
    expect(layer.order).toBe(1)
    expect(layer.size).toBe(0)
    expect(live.order).toBe(3)
    expect(live.size).toBe(3)
  })
})

describe('freshness', () => {
  it('shows a runtime edge added after a view was composed in the next request on that ref', async () => {
    const w = await world()
    const { get, built, registry } = await api(w)
    const ref = await built(w.headSha)

    const before = await get(`/graph?ref=${ref}`)
    const again = await get(`/graph?ref=${ref}`)
    expect(again.body).toEqual(before.body)
    const found = registry.find('default', ref)
    const composedOnce = 'entry' in found ? found.entry.view?.graph : undefined
    expect(composedOnce).toBeDefined()

    const added = addObserved(w.live, B_INDEX, A)
    const after = await get(`/graph?ref=${ref}`)
    expect((before.body.edges as GraphEdge[]).some((e) => e.id === added)).toBe(false)
    expect((after.body.edges as GraphEdge[]).some((e) => e.id === added)).toBe(true)
    // The live graph moved, so the next request composed a new view.
    expect('entry' in found ? found.entry.view?.graph : undefined).not.toBe(composedOnce)

    const blast = await get(`/graph/blast-radius/${encodeURIComponent(A)}?ref=${ref}`)
    expect(JSON.stringify(blast.body)).toContain(B_INDEX)
  })

  it('reuses the composed view while the live graph has not changed', async () => {
    const w = await world()
    const registry = new RefRegistry()
    const entry = registry.request('default', APP, commitKey(w.headSha), () =>
      buildStaticLayer({ repository: APP, sha: w.headSha, scanPath: w.repo }),
    )
    await entry.settled
    const first = resolveView(registry, entry, w.live)
    expect(resolveView(registry, entry, w.live).graph).toBe(first.graph)
    w.live.setNodeAttribute(A, 'env', 'staging')
    const second = resolveView(registry, entry, w.live)
    expect(second.graph).not.toBe(first.graph)
    expect(second.graph.getNodeAttributes(A)).toMatchObject({ env: 'staging' })
    // The earlier view is a copy, so a holder of it still reads what it resolved.
    expect(first.graph.getNodeAttributes(A)).toMatchObject({ env: 'prod' })
  })

  it('keeps a multi-step request on the view it resolved at its start', async () => {
    const w = await world()
    const { app, get, built } = await api(w)
    const ref = await built(w.headSha)
    const card = `/graph/incident-card/${encodeURIComponent(A)}`
    const baseline = await get(`${card}?ref=${ref}`)
    expect(baseline.status).toBe(200)
    expect(JSON.stringify(baseline.body)).not.toContain(B_INDEX)

    // Park the card's incident read, change the live graph while the request
    // waits, then let it finish.
    const midRequest = async (url: string, mutate: () => void) => {
      let release!: () => void
      const entered = new Promise<void>((resolve) => { gate.entered = resolve })
      gate.hold = new Promise<void>((resolve) => { release = resolve })
      const pending = app.inject({ method: 'GET', url })
      await entered
      mutate()
      gate.hold = undefined
      gate.entered = undefined
      release()
      const res = await pending
      return { status: res.statusCode, body: res.json() }
    }

    let added = ''
    const during = await midRequest(`${card}?ref=${ref}`, () => {
      added = addObserved(w.live, B_INDEX, A)
    })
    expect(w.live.hasEdge(added)).toBe(true)
    // The edge landed on the live graph mid-request and is not in this answer.
    expect(during.body).toEqual(baseline.body)
    // The next request on the ref sees it.
    const next = await get(`${card}?ref=${ref}`)
    expect(next.body).not.toEqual(baseline.body)
    expect(JSON.stringify(next.body)).toContain(B_INDEX)

    // The same interleaving on a live read does reach the answer, which is what
    // makes the pinned read above a real difference and not a quiet await.
    w.live.dropEdge(added)
    const liveBaseline = await get(card)
    const liveDuring = await midRequest(card, () => {
      addObserved(w.live, B_INDEX, A)
    })
    expect(liveDuring.body).not.toEqual(liveBaseline.body)
  })
})

describe('builds', () => {
  it('runs one extraction for two concurrent requests for one key', async () => {
    const w = await world()
    let extractions = 0
    const extract: typeof extractFromDirectory = (...args) => {
      extractions++
      return extractFromDirectory(...args)
    }
    const { app, registry } = await api(w, new RefRegistry(), { extract })
    const post = () => app.inject({ method: 'POST', url: '/refs', payload: { repository: APP, sha: w.oldSha } })
    const [first, second] = await Promise.all([post(), post()])
    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(202)
    expect(first.json()).toEqual({ project: 'default', ref: commitKey(w.oldSha), status: 'building' })
    expect(second.json()).toEqual(first.json())

    const found = registry.find('default', commitKey(w.oldSha))
    if (!('entry' in found)) throw new Error('no entry')
    await found.entry.settled
    const third = await post()
    expect(third.statusCode).toBe(200)
    expect(third.json().status).toBe('ready')
    expect(extractions).toBe(1)
  })

  it('reads the commit and nothing else: a dirty working tree does not reach the layer', async () => {
    const w = await world()
    await write(w.repo, { 'svc-a/dirty.js': 'function dirty() { return 9 }\nmodule.exports = { dirty }\n' })
    const layer = await buildStaticLayer({ repository: APP, sha: w.headSha, scanPath: w.repo })
    expect(layer.graph.hasNode(fileId('svc-a', 'dirty.js'))).toBe(false)
    expect(layer.graph.hasNode(A_EXTRA)).toBe(true)
    expect(layer.graph.getNodeAttributes(A).declaredBy).toEqual([APP])
    expect(layer).toMatchObject({ extractionErrors: 0, skippedFiles: 0 })
  })

  it('serves an incomplete layer and says so in every answer', async () => {
    const w = await world()
    const extract: typeof extractFromDirectory = async (...args) => {
      const result = await extractFromDirectory(...args)
      return { ...result, extractionErrors: 3, skippedFiles: 2 }
    }
    const { get, built } = await api(w, new RefRegistry(), { extract })
    const ref = await built(w.headSha)
    const block = { key: ref, hiddenRuntimeEdges: 0, extractionErrors: 3, skippedFiles: 2 }
    for (const route of READ_ROUTES(A)) {
      const res = await get(`${route}?ref=${ref}`)
      expect(res.body.ref, route).toEqual(block)
    }
    const listed = await get('/refs')
    expect(listed.body.refs).toMatchObject([{ key: ref, status: 'incomplete', extractionErrors: 3, skippedFiles: 2 }])
    // An incomplete extraction is not evidence of its commit.
    expect((await get(`/graph?ref=${ref}`)).body.sourceBaselines).toContainEqual({
      status: 'unavailable',
      repository: APP,
    })
  })

  it('lists the retained layers with key, status and age, and no graph content', async () => {
    const w = await world()
    const { get, built } = await api(w)
    expect((await get('/refs')).body).toEqual({ project: 'default', count: 0, refs: [] })
    const ref = await built(w.oldSha)
    const { body } = await get('/refs')
    expect(body.count).toBe(1)
    expect(Object.keys(body.refs[0]).sort()).toEqual(['ageMs', 'idleMs', 'key', 'pinned', 'repository', 'status'])
    expect(body.refs[0]).toMatchObject({ key: ref, repository: APP, status: 'ready', pinned: false })
    // Both mounts answer, as every project route does.
    expect((await get('/projects/default/refs')).body.refs).toMatchObject([{ key: ref, status: 'ready' }])
    expect((await get(`/projects/default/graph?ref=${ref}`)).body.ref).toEqual({ key: ref, hiddenRuntimeEdges: 2 })
  })

  it('refuses a body that is not a repository and a full sha', async () => {
    const w = await world()
    const { app } = await api(w)
    for (const payload of [
      {},
      { repository: APP },
      { repository: APP, sha: 'main' },
      { repository: APP, sha: w.headSha.slice(0, 12) },
      { repository: '../etc', sha: w.headSha },
      { repository: APP, sha: w.headSha, cloneUrl: 'https://example.com/acme/app.git' },
      { repository: APP, sha: w.headSha, cloneUrl: 'https://github.com/acme/elsewhere.git' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/refs', payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(res.json().details, JSON.stringify(payload)).toBeDefined()
    }
  })

  it('clones a commit from the clone URL when the request carries one', async () => {
    const w = await world()
    const calls: Array<{ url: string; sha: string }> = []
    const cloneCommit = async (url: string, sha: string, dest: string): Promise<void> => {
      calls.push({ url, sha })
      await write(dest, {
        'package.json': JSON.stringify({ name: 'svc-a', version: '1.0.0' }),
        'index.js': 'function cloned() { return 1 }\nmodule.exports = { cloned }\n',
      })
    }
    const registry = new RefRegistry()
    const { app } = await api(w, registry, { cloneCommit })
    const cloneUrl = 'https://x-access-token:SECRET@github.com/acme/app.git'
    const res = await app.inject({
      method: 'POST',
      url: '/refs',
      payload: { repository: APP, sha: 'c'.repeat(40), cloneUrl },
    })
    expect(res.statusCode).toBe(202)
    expect(res.body).not.toContain('SECRET')
    const found = registry.find('default', commitKey('c'.repeat(40)))
    if (!('entry' in found)) throw new Error('no entry')
    await found.entry.settled
    expect(calls).toEqual([{ url: cloneUrl, sha: 'c'.repeat(40) }])
    expect(found.entry.status).toBe('ready')
    expect(found.entry.layer?.graph.hasNode(fileId('svc-a', 'index.js'))).toBe(true)
  })
})

describe('a ref that cannot be served', () => {
  it('never falls back to the live graph: unknown, malformed, building, failed and evicted refs are refused', async () => {
    const w = await world()
    const registry = new RefRegistry({ maxLayersPerProject: 1 })
    let finishCheckout!: () => void
    const held = new Promise<void>((resolve) => { finishCheckout = resolve })
    const { app, get, built } = await api(w, registry, {
      // The commit named `b…` parks in its checkout so it can be read while building.
      checkout: async (scanPath: string, sha: string, dest: string) => {
        if (sha === 'b'.repeat(40)) await held
        const { checkoutLocalCommit } = await import('../src/extract/ref-view.js')
        await checkoutLocalCommit(scanPath, sha, dest)
      },
    })

    const refused = async (ref: string, status: number, code: string): Promise<void> => {
      for (const route of READ_ROUTES(A)) {
        const res = await get(`${route}${ref}`)
        expect(res.status, `${route}${ref}`).toBe(status)
        expect(res.body.code, `${route}${ref}`).toBe(code)
        // Nothing of the live graph is in a refusal.
        expect(Object.keys(res.body).sort(), `${route}${ref}`).toEqual(
          ['code', 'detail', 'error', 'hint', 'project', 'ref'].filter((k) => k !== 'detail' || 'detail' in res.body),
        )
      }
    }

    // Never built.
    await refused(`?ref=${commitKey('f'.repeat(40))}`, 404, 'ref_not_found')
    // Not a key at all: a branch name, a bare sha, an empty value, a repeated one.
    await refused('?ref=main', 404, 'ref_not_found')
    await refused(`?ref=${w.headSha}`, 404, 'ref_not_found')
    await refused('?ref=', 404, 'ref_not_found')
    await refused(`?ref=${commitKey(w.headSha)}&ref=${commitKey(w.oldSha)}`, 404, 'ref_not_found')

    // Building.
    const building = await app.inject({ method: 'POST', url: '/refs', payload: { repository: APP, sha: 'b'.repeat(40) } })
    expect(building.json().status).toBe('building')
    await refused(`?ref=${commitKey('b'.repeat(40))}`, 409, 'ref_building')

    // Failed: the repository holds no such commit.
    finishCheckout()
    const failed = registry.find('default', commitKey('b'.repeat(40)))
    if (!('entry' in failed)) throw new Error('no entry')
    await failed.entry.settled
    expect(failed.entry.status).toBe('failed')
    await refused(`?ref=${commitKey('b'.repeat(40))}`, 409, 'ref_failed')
    expect((await get('/refs')).body.refs).toMatchObject([{ status: 'failed' }])

    // Evicted: the project keeps one layer, so building a second drops the first.
    const first = await built(w.oldSha)
    expect((await get(`/graph?ref=${first}`)).status).toBe(200)
    const second = await built(w.headSha)
    expect((await get(`/graph?ref=${second}`)).status).toBe(200)
    await refused(`?ref=${first}`, 404, 'ref_evicted')

    // With no ref, the same routes read the live graph as they always have.
    for (const route of READ_ROUTES(A)) {
      const res = await get(route)
      expect(res.status, route).toBe(200)
      expect(res.body.ref, route).toBeUndefined()
    }
  })

  it('answers a project with no scan path 409 and builds nothing', async () => {
    const w = await world()
    const registry = new RefRegistry()
    const app = await buildApi({ graph: w.live, refs: registry })
    const res = await app.inject({ method: 'POST', url: '/refs', payload: { repository: APP, sha: w.headSha } })
    expect(res.statusCode).toBe(409)
    expect(registry.list('default')).toEqual([])
  })
})

describe('memory only', () => {
  it('writes no layer or view to a snapshot or any file', async () => {
    const w = await world()
    const out = await tmp('snapshot')
    const tmpRoot = await tmp('checkouts')
    const projectsBefore = listProjects()
    const repoBefore = await tree(w.repo)
    const { get, built, registry } = await api(w, new RefRegistry(), { tmpRoot })

    const ref = await built(w.oldSha)
    for (const route of READ_ROUTES(A)) expect((await get(`${route}?ref=${ref}`)).status).toBe(200)

    // The checkout the layer was read from is gone, and the project's own tree
    // is as it was: no neat-out, no sidecar, no worktree registered in .git.
    expect(await tree(tmpRoot)).toEqual([])
    expect(await tree(w.repo)).toEqual(repoBefore)
    expect(repoBefore.some((f) => f.startsWith('neat-out/'))).toBe(false)

    // Neither the layer nor the view is a project graph, so nothing that walks
    // the projects (the persist loop, the event bus) can reach one.
    expect(listProjects()).toEqual(projectsBefore)
    const found = registry.find('default', ref)
    if (!('entry' in found)) throw new Error('no entry')
    const layerGraph = found.entry.layer!.graph
    const viewGraph = found.entry.view!.graph
    for (const project of listProjects()) {
      expect(getGraph(project)).not.toBe(layerGraph)
      expect(getGraph(project)).not.toBe(viewGraph)
    }

    // The project's snapshot is the live graph: what the old ref lacks is still in it.
    const snapshotPath = path.join(out, 'graph.json')
    await saveGraphToDisk(w.live, snapshotPath)
    expect(await tree(out)).toEqual(['graph.json'])
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as { graph: { nodes: Array<{ key: string }> } }
    const persisted = new Set(snapshot.graph.nodes.map((n) => n.key))
    expect(persisted.has(C)).toBe(true)
    expect(viewGraph.hasNode(C)).toBe(false)
    expect(persisted.size).toBe(w.live.order)
  })
  // ref-views.md §6: the policy check reads the view too, so a build run checks
  // policy on the pull request's code and not on whatever is live.
  it('evaluates POST /policies/check on the view, and never on the live graph for a ref it cannot serve', async () => {
    const w = await world()
    await write(w.repo, {
      'policy.json': JSON.stringify({
        version: 1,
        policies: [
          { id: 'service-owner', name: 'services must declare an owner', severity: 'critical', rule: { type: 'ownership', nodeType: 'ServiceNode', field: 'owner' } },
        ],
      }),
    })
    const { app, built } = await api(w)
    const check = async (query = '') => {
      const res = await app.inject({ method: 'POST', url: `/policies/check${query}`, payload: {} })
      return { status: res.statusCode, body: res.json() }
    }
    const subjects = (body: { violations: { subject: { nodeId?: string } }[] }) =>
      [...new Set(body.violations.map((v) => v.subject.nodeId))].sort()

    const live = await check()
    expect(live.status).toBe(200)
    expect(live.body.ref).toBeUndefined()
    expect(subjects(live.body)).toEqual([A, B, C, GHOST].sort())

    // svc-c does not exist at the old commit, so it cannot violate anything there.
    // The runtime-discovered service shows at every ref.
    const key = await built(w.oldSha)
    const atRef = await check(`?ref=${encodeURIComponent(key)}`)
    expect(atRef.status).toBe(200)
    expect(atRef.body.ref.key).toBe(key)
    expect(atRef.body.allowed).toBe(false)
    expect(subjects(atRef.body)).toEqual([A, B, GHOST].sort())

    const unknown = await check(`?ref=${encodeURIComponent(`commit:${'0'.repeat(40)}`)}`)
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe('ref_not_found')
    expect(unknown.body.violations).toBeUndefined()
  })


  // ref-views.md §6, ruled 2026-11-21 (#1751): the security reads answer for a
  // ref's view, so a run on a pull request reads its own head's cards.
  it('answers the security reads at a ref, and never from the live graph for a ref it cannot serve', async () => {
    const w = await world()
    const home = await tmp('advisories')
    // One advisory for left-pad 1.3.0, served the way the OSV query API answers.
    const record = {
      id: 'GHSA-test-leftpad', aliases: [], summary: 'test advisory', details: 'test', modified: '2026-11-01T00:00:00Z',
      affected: [{ package: { name: 'left-pad', ecosystem: 'npm', purl: 'pkg:npm/left-pad' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.3.1' }] }] }],
      database_specific: { severity: 'HIGH' },
    }
    const fake = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/v1/querybatch')) {
        const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { name: string } }> }
        return new Response(JSON.stringify({ results: body.queries.map((q) => ({ vulns: q.package.name === 'left-pad' ? [{ id: record.id }] : [] })) }))
      }
      if (u.includes('/v1/vulns/')) return new Response(JSON.stringify(record))
      return new Response('not found', { status: 404 })
    })
    const prevHome = process.env.NEAT_HOME
    const prevAdv = process.env.NEAT_ADVISORIES
    process.env.NEAT_HOME = home
    delete process.env.NEAT_ADVISORIES
    vi.stubGlobal('fetch', fake)
    try {
      const { built, get } = await api(w)
      const head = await built(w.headSha)
      const old = await built(w.oldSha)
      const services = (body: { findings: Array<{ service: string; advisory: { id: string } }> }) =>
        body.findings.filter((c) => c.advisory.id === record.id).map((c) => c.service).sort()

      const live = await get('/graph/security/reachable-cves')
      expect(live.status).toBe(200)
      expect(live.body.ref).toBeUndefined()
      expect(services(live.body)).toEqual(['svc-a', 'svc-b'])

      // At the live graph's own commit the answer is the live one, with the ref block.
      const atHead = await get(`/graph/security/reachable-cves?ref=${encodeURIComponent(head)}`)
      expect(atHead.status).toBe(200)
      expect(atHead.body.ref.key).toBe(head)
      expect(services(atHead.body)).toEqual(services(live.body))

      // svc-a has no left-pad at the old commit; svc-b is the other repository's, still live.
      const atOld = await get(`/graph/security/reachable-cves?ref=${encodeURIComponent(old)}`)
      expect(atOld.body.ref.key).toBe(old)
      expect(services(atOld.body)).toEqual(['svc-b'])

      const reach = await get(`/graph/security/is-reachable?package=left-pad&service=svc-a&ref=${encodeURIComponent(old)}`)
      expect(reach.status).toBe(200)
      expect(reach.body.ref.key).toBe(old)
      expect(reach.body.reachable).toBe(false)
      const plan = await get(`/graph/security/fix-plan?ref=${encodeURIComponent(head)}`)
      expect(plan.status).toBe(200)
      expect(plan.body.ref.key).toBe(head)

      const unknown = `commit:${'0'.repeat(40)}`
      for (const route of ['reachable-cves', 'is-reachable?package=left-pad', 'fix-plan']) {
        const res = await get(`/graph/security/${route}${route.includes('?') ? '&' : '?'}ref=${encodeURIComponent(unknown)}`)
        expect(res.status).toBe(404)
        expect(res.body.code).toBe('ref_not_found')
        expect(res.body.findings).toBeUndefined()
      }
    } finally {
      vi.unstubAllGlobals()
      if (prevHome === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prevHome
      if (prevAdv === undefined) delete process.env.NEAT_ADVISORIES
      else process.env.NEAT_ADVISORIES = prevAdv
    }
  })
})

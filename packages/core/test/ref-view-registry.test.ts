import { describe, it, expect } from 'vitest'
import { makeGraph } from '../src/graph.js'
import {
  RefRegistry,
  commitKey,
  mutationCount,
  parseRefKey,
  worktreeKey,
  type StaticLayer,
} from '../src/ref-registry.js'
import { NodeType, type GraphNode } from '@neat.is/types'

// Ref views, the registry half (ADR-278, ref-views.md §1, §4): keys, one build
// per key, and what is retained: a fixed count per project, least recently read
// evicted first, a TTL since the last read, and pins.

const sha = (c: string): string => c.repeat(40)
const layer = (errors = 0, skipped = 0): StaticLayer => ({
  graph: makeGraph(),
  extractionErrors: errors,
  skippedFiles: skipped,
})

function clocked(opts: { maxLayersPerProject?: number; ttlMs?: number } = {}) {
  const clock = { at: 1_000 }
  const registry = new RefRegistry({ ...opts, now: () => clock.at })
  const built = async (project: string, c: string, repository = 'acme/app') => {
    const entry = registry.request(project, repository, commitKey(sha(c)), async () => layer())
    await entry.settled
    return entry
  }
  return { clock, registry, built }
}

describe('ref keys', () => {
  it('reads commit and worktree keys, and nothing else', () => {
    expect(parseRefKey(commitKey(sha('a')))).toEqual({ state: 'commit', sha: sha('a') })
    const digest = 'd'.repeat(64)
    expect(parseRefKey(worktreeKey(sha('a'), digest))).toEqual({
      state: 'worktree',
      sha: sha('a'),
      dirtyDigest: digest,
    })
    for (const notAKey of ['main', 'v1.2.3', sha('a'), 'commit:abc', `commit:${sha('A')}`, `worktree:${sha('a')}`, '']) {
      expect(parseRefKey(notAKey), notAKey).toBeNull()
    }
  })
})

describe('the mutation counter', () => {
  it('moves on every kind of graph change and stands still otherwise', () => {
    const graph = makeGraph()
    const node = (id: string): GraphNode =>
      ({ id, type: NodeType.ServiceNode, name: id, language: 'js' }) as GraphNode
    const start = mutationCount(graph)
    expect(mutationCount(graph)).toBe(start)
    const seen = [start]
    const moved = (): void => {
      const next = mutationCount(graph)
      expect(next).toBeGreaterThan(seen[seen.length - 1]!)
      seen.push(next)
    }
    graph.addNode('a', node('a'))
    moved()
    graph.addNode('b', node('b'))
    moved()
    graph.addEdgeWithKey('e', 'a', 'b', { id: 'e' } as never)
    moved()
    graph.replaceNodeAttributes('a', { ...node('a'), env: 'prod' } as GraphNode)
    moved()
    graph.setEdgeAttribute('e', 'callCount' as never, 2 as never)
    moved()
    graph.dropEdge('e')
    moved()
    graph.dropNode('b')
    moved()
    graph.clear()
    moved()
  })
})

describe('retention', () => {
  it('evicts the least recently read layer first once a project is over its count', async () => {
    const { clock, registry, built } = clocked({ maxLayersPerProject: 2 })
    const a = await built('p', 'a')
    clock.at += 10
    const b = await built('p', 'b')
    clock.at += 10
    // Reading `a` makes `b` the least recently read.
    registry.touch(a)
    clock.at += 10
    await built('p', 'c')

    expect(registry.list('p').map((e) => e.key).sort()).toEqual([commitKey(sha('a')), commitKey(sha('c'))])
    expect(registry.find('p', b.key)).toEqual({ missing: 'ref_evicted' })
    expect(b.layer).toBeUndefined()
    expect(registry.find('p', commitKey(sha('f')))).toEqual({ missing: 'ref_not_found' })
  })

  it('counts each project on its own', async () => {
    const { registry, built } = clocked({ maxLayersPerProject: 1 })
    await built('p', 'a')
    await built('q', 'b')
    expect(registry.list('p')).toHaveLength(1)
    expect(registry.list('q')).toHaveLength(1)
    // A key belongs to its project: another project's layer is not found from here.
    expect(registry.find('p', commitKey(sha('b')))).toEqual({ missing: 'ref_not_found' })
  })

  it('drops a layer nobody has read for the TTL, counted from its last read', async () => {
    const { clock, registry, built } = clocked({ ttlMs: 100 })
    const a = await built('p', 'a')
    const b = await built('p', 'b')
    clock.at += 80
    registry.touch(a)
    clock.at += 40
    // b is 120 ms unread, a is 40.
    expect(registry.find('p', b.key)).toEqual({ missing: 'ref_evicted' })
    expect(registry.find('p', a.key)).toEqual({ entry: a })
    clock.at += 101
    expect(registry.find('p', a.key)).toEqual({ missing: 'ref_evicted' })
    expect(registry.list('p')).toEqual([])
  })

  it('never evicts a pinned layer, by count or by TTL, until it is released', async () => {
    const { clock, registry, built } = clocked({ maxLayersPerProject: 1, ttlMs: 100 })
    const a = await built('p', 'a')
    const release = registry.pin(a)
    clock.at += 10
    const b = await built('p', 'b')
    // Over the count, and `a` is the older read, but it is pinned: `b` goes instead.
    expect(registry.find('p', a.key)).toEqual({ entry: a })
    expect(registry.find('p', b.key)).toEqual({ missing: 'ref_evicted' })

    clock.at += 1_000
    expect(registry.find('p', a.key)).toEqual({ entry: a })
    expect(a.layer).toBeDefined()

    release()
    release()
    expect(a.pins).toBe(0)
    expect(registry.find('p', a.key)).toEqual({ missing: 'ref_evicted' })
  })

  it('holds a building layer however long the build runs', async () => {
    const { clock, registry } = clocked({ ttlMs: 100 })
    let finish!: (l: StaticLayer) => void
    const entry = registry.request('p', 'acme/app', commitKey(sha('a')), () => new Promise((resolve) => { finish = resolve }))
    await Promise.resolve()
    clock.at += 10_000
    expect(registry.find('p', entry.key)).toEqual({ entry })
    expect(entry.status).toBe('building')
    finish(layer())
    await entry.settled
    expect(entry.status).toBe('ready')
    // The TTL runs from when the build landed.
    clock.at += 50
    expect(registry.find('p', entry.key)).toEqual({ entry })
  })
})

describe('builds', () => {
  it('runs one build for any number of requests for one key', async () => {
    const { registry } = clocked()
    let builds = 0
    let finish!: (l: StaticLayer) => void
    const build = (): Promise<StaticLayer> => {
      builds++
      return new Promise((resolve) => { finish = resolve })
    }
    const first = registry.request('p', 'acme/app', commitKey(sha('a')), build)
    const second = registry.request('p', 'acme/app', commitKey(sha('a')), build)
    expect(second).toBe(first)
    await Promise.resolve()
    finish(layer())
    await first.settled
    // Built: a later request gets the layer and starts nothing.
    expect(registry.request('p', 'acme/app', commitKey(sha('a')), build)).toBe(first)
    expect(builds).toBe(1)
    expect(first.status).toBe('ready')
  })

  it('marks a build with extraction errors or skipped files incomplete, and keeps it', async () => {
    const { registry } = clocked()
    const errors = registry.request('p', 'acme/app', commitKey(sha('a')), async () => layer(3, 0))
    const skipped = registry.request('p', 'acme/app', commitKey(sha('b')), async () => layer(0, 2))
    await Promise.all([errors.settled, skipped.settled])
    expect(errors.status).toBe('incomplete')
    expect(skipped.status).toBe('incomplete')
    expect(errors.layer?.extractionErrors).toBe(3)
    expect(skipped.layer?.skippedFiles).toBe(2)
  })

  it('records a failed build without a layer, and builds again when asked again', async () => {
    const { registry } = clocked()
    const failed = registry.request('p', 'acme/app', commitKey(sha('a')), async () => {
      throw new Error('no such commit')
    })
    await failed.settled
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('no such commit')
    expect(failed.layer).toBeUndefined()

    const again = registry.request('p', 'acme/app', commitKey(sha('a')), async () => layer())
    expect(again).not.toBe(failed)
    await again.settled
    expect(again.status).toBe('ready')
    expect(registry.list('p')).toEqual([again])
  })

  it('answers ambiguous when two repositories hold one state and the read names neither', async () => {
    const { registry, built } = clocked()
    const app = await built('p', 'a', 'acme/app')
    const fork = await built('p', 'a', 'acme/fork')
    expect(registry.find('p', app.key)).toEqual({ missing: 'ref_ambiguous' })
    expect(registry.find('p', app.key, 'acme/fork')).toEqual({ entry: fork })
  })

  it('retains nothing from a build that lands after its project was cleared', async () => {
    const { registry } = clocked()
    let finish!: (l: StaticLayer) => void
    const entry = registry.request('p', 'acme/app', commitKey(sha('a')), () => new Promise((resolve) => { finish = resolve }))
    await Promise.resolve()
    registry.clear('p')
    finish(layer())
    await entry.settled
    expect(entry.layer).toBeUndefined()
    expect(registry.list('p')).toEqual([])
  })
})

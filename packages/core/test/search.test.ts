import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EdgeType, NodeType, Provenance } from '@neat.is/types'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildSearchIndex, cosine, embedText } from '../src/search.js'

let tmpDir: string

beforeEach(async () => {
  resetGraph()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-search-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function seedGraph(): ReturnType<typeof getGraph> {
  const graph = getGraph()
  graph.addNode('service:checkout', {
    id: 'service:checkout',
    type: NodeType.ServiceNode,
    name: 'checkout',
    language: 'javascript',
  })
  graph.addNode('service:payments', {
    id: 'service:payments',
    type: NodeType.ServiceNode,
    name: 'payments',
    language: 'javascript',
  })
  graph.addNode('database:payments-db', {
    id: 'database:payments-db',
    type: NodeType.DatabaseNode,
    name: 'payments-db',
    engine: 'postgresql',
    engineVersion: '15',
  })
  graph.addEdgeWithKey(
    'CONNECTS_TO:service:payments->database:payments-db',
    'service:payments',
    'database:payments-db',
    {
      id: 'CONNECTS_TO:service:payments->database:payments-db',
      source: 'service:payments',
      target: 'database:payments-db',
      type: EdgeType.CONNECTS_TO,
      provenance: Provenance.EXTRACTED,
    },
  )
  return graph
}

describe('embedText', () => {
  it('joins id, name, and type-specific fragments', () => {
    const txt = embedText({
      id: 'service:checkout',
      type: NodeType.ServiceNode,
      name: 'checkout',
      language: 'javascript',
    })
    expect(txt).toBe('service:checkout checkout language=javascript')
  })

  it('emits engine + engineVersion for databases', () => {
    const txt = embedText({
      id: 'database:payments-db',
      type: NodeType.DatabaseNode,
      name: 'payments-db',
      engine: 'postgresql',
      engineVersion: '15',
    })
    expect(txt).toBe('database:payments-db payments-db engine=postgresql engineVersion=15')
  })

  it('emits kind for infra nodes', () => {
    const txt = embedText({
      id: 'infra:postgres:payments',
      type: NodeType.InfraNode,
      name: 'payments',
      kind: 'postgres',
    })
    expect(txt).toBe('infra:postgres:payments payments kind=postgres')
  })
})

describe('cosine', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3])
    expect(cosine(v, v)).toBeCloseTo(1, 6)
  })

  it('returns 0 when one vector is zero', () => {
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0)
  })

  it('returns 0 on length mismatch', () => {
    expect(cosine(new Float32Array([1]), new Float32Array([1, 1]))).toBe(0)
  })
})

describe('buildSearchIndex with substring provider', () => {
  it('falls back to substring when no embedder is available', async () => {
    seedGraph()
    const idx = await buildSearchIndex(getGraph(), { forceProvider: 'substring' })
    expect(idx.provider).toBe('substring')
    const result = await idx.search('payments')
    expect(result.provider).toBe('substring')
    const ids = result.matches.map((m) => m.node.id).sort()
    expect(ids).toEqual(['database:payments-db', 'service:payments'])
  })
})

describe('buildSearchIndex embedder-init timeout (refs #819)', () => {
  it('degrades to substring instead of hanging when the embedder init stalls', async () => {
    seedGraph()
    // A factory that never settles — the shape of a transformers/ONNX init or a
    // cold-cache model download that hangs on a slow or unsupported runtime (the
    // Node 26 report). Left unbounded it would hang the whole `neat watch` /
    // dev-server bring-up with no output; the bound has to turn it into a
    // substring fallback and keep going.
    const started = Date.now()
    const idx = await buildSearchIndex(getGraph(), {
      cachePath: null,
      embedderFactory: () => new Promise<never>(() => {}),
      initTimeoutMs: 200,
    })
    const elapsed = Date.now() - started
    // Came up bounded (nowhere near a hang) and degraded to substring.
    expect(elapsed).toBeLessThan(5000)
    expect(idx.provider).toBe('substring')
    // The substring index still answers, so the graph stays queryable.
    const result = await idx.search('payments')
    expect(result.provider).toBe('substring')
    expect(result.matches.map((m) => m.node.id)).toContain('service:payments')
  })

  it('uses the embedder when it resolves inside the bound', async () => {
    seedGraph()
    const idx = await buildSearchIndex(getGraph(), {
      cachePath: null,
      initTimeoutMs: 5000,
      embedderFactory: async () => ({
        provider: 'transformers' as const,
        model: 'fake-test-model',
        dim: 2,
        async embed(texts: string[]): Promise<Float32Array[]> {
          return texts.map(() => Float32Array.from([1, 0]))
        },
      }),
    })
    expect(idx.provider).toBe('transformers')
  })
})

describe('buildSearchIndex with an injected embedder', () => {
  // Tiny deterministic embedder: hashes the text into two dimensions so two
  // nodes whose text shares prefixes are closer than nodes that don't.
  function fakeEmbedder() {
    const dim = 8
    const embed = (text: string): Float32Array => {
      const v = new Float32Array(dim)
      for (let i = 0; i < text.length; i++) {
        v[text.charCodeAt(i) % dim] += 1
      }
      // L2 normalise
      let n = 0
      for (let i = 0; i < dim; i++) n += v[i] * v[i]
      n = Math.sqrt(n)
      if (n > 0) for (let i = 0; i < dim; i++) v[i] /= n
      return v
    }
    return {
      provider: 'transformers' as const,
      model: 'fake-test-model',
      dim,
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(embed)
      },
    }
  }

  it('returns scored matches sorted by cosine similarity', async () => {
    seedGraph()
    const idx = await buildSearchIndex(getGraph(), {
      embedder: fakeEmbedder(),
      cachePath: null,
    })
    expect(idx.provider).toBe('transformers')
    const result = await idx.search('payments database', 5)
    expect(result.provider).toBe('transformers')
    expect(result.matches.length).toBeGreaterThan(0)
    // Scores are descending.
    const scores = result.matches.map((m) => m.score)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i])
    }
  })

  it('persists vectors to a cache and skips re-embed when attrs unchanged', async () => {
    seedGraph()
    const cachePath = path.join(tmpDir, 'embeddings.json')
    const calls: string[][] = []
    const inner = fakeEmbedder()
    const counting = {
      ...inner,
      async embed(texts: string[]): Promise<Float32Array[]> {
        calls.push(texts)
        return inner.embed(texts)
      },
    }
    const first = await buildSearchIndex(getGraph(), {
      embedder: counting,
      cachePath,
    })
    expect(calls.flat().length).toBeGreaterThan(0)
    void first

    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'))
    expect(cache.version).toBe(1)
    expect(cache.provider).toBe('transformers')
    expect(cache.entries.length).toBeGreaterThan(0)

    // Second build with the same graph + same cache should not call embed.
    const callsAfter: string[][] = []
    const recheck = {
      ...inner,
      async embed(texts: string[]): Promise<Float32Array[]> {
        callsAfter.push(texts)
        return inner.embed(texts)
      },
    }
    const second = await buildSearchIndex(getGraph(), {
      embedder: recheck,
      cachePath,
    })
    expect(callsAfter.flat()).toEqual([])
    void second
  })

  it('drops cache entries whose attrs hash no longer matches', async () => {
    seedGraph()
    const cachePath = path.join(tmpDir, 'embeddings.json')
    const inner = fakeEmbedder()
    await buildSearchIndex(getGraph(), { embedder: inner, cachePath })

    // Mutate the service: changing name → changes embedText → changes hash.
    const graph = getGraph()
    graph.replaceNodeAttributes('service:payments', {
      id: 'service:payments',
      type: NodeType.ServiceNode,
      name: 'payments-renamed',
      language: 'javascript',
    })

    const calls: string[][] = []
    const counting = {
      ...inner,
      async embed(texts: string[]): Promise<Float32Array[]> {
        calls.push(texts)
        return inner.embed(texts)
      },
    }
    await buildSearchIndex(getGraph(), { embedder: counting, cachePath })
    // Should have re-embedded exactly the renamed node, not all three.
    expect(calls.flat()).toEqual([
      embedText({
        id: 'service:payments',
        type: NodeType.ServiceNode,
        name: 'payments-renamed',
        language: 'javascript',
      }),
    ])
  })

  it('refresh() drops vanished nodes from the index', async () => {
    seedGraph()
    const idx = await buildSearchIndex(getGraph(), {
      embedder: fakeEmbedder(),
      cachePath: null,
    })
    let result = await idx.search('payments')
    expect(result.matches.map((m) => m.node.id)).toContain('database:payments-db')

    getGraph().dropNode('database:payments-db')
    await idx.refresh(getGraph())
    result = await idx.search('payments')
    expect(result.matches.map((m) => m.node.id)).not.toContain('database:payments-db')
  })

  it('skips FrontierNodes', async () => {
    seedGraph()
    getGraph().addNode('frontier:unknown.host', {
      id: 'frontier:unknown.host',
      type: NodeType.FrontierNode,
      name: 'unknown.host',
      firstObserved: '2026-05-01T00:00:00Z',
      lastObserved: '2026-05-01T00:00:00Z',
    })
    const idx = await buildSearchIndex(getGraph(), {
      embedder: fakeEmbedder(),
      cachePath: null,
    })
    const result = await idx.search('unknown')
    expect(result.matches.map((m) => m.node.id)).not.toContain('frontier:unknown.host')
  })
})

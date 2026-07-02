// semantic_search — embedding-based node retrieval with a three-tier
// fallback chain. The chain is settled in ADR-025; this file is the
// implementation. Public API:
//
//   buildSearchIndex(graph, opts) → SearchIndex
//   SearchIndex.search(query, limit) → { provider, matches }
//   SearchIndex.refresh(graph)      → re-embeds new/changed nodes,
//                                     drops vanished ones
//
// The `/search` route in api.ts holds a single SearchIndex, refreshing it
// after any extraction. MCP's `semantic_search` tool reads the same shape.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { GraphNode } from '@neat.is/types'
import type { NeatGraph } from './graph.js'

export interface ScoredNode {
  node: GraphNode
  score: number
}

export interface SearchResponse {
  query: string
  provider: 'ollama' | 'transformers' | 'substring'
  matches: ScoredNode[]
}

export interface SearchIndex {
  readonly provider: SearchResponse['provider']
  search(query: string, limit?: number): Promise<SearchResponse>
  refresh(graph: NeatGraph): Promise<void>
}

interface Embedder {
  provider: 'ollama' | 'transformers'
  model: string
  dim: number
  embed(texts: string[]): Promise<Float32Array[]>
}

const DEFAULT_LIMIT = 10
const NOMIC_DIM = 768
const MINI_LM_DIM = 384

// FrontierNodes are noise by design (placeholders that should disappear).
// Embedding them would just clutter results.
function shouldEmbed(node: GraphNode): boolean {
  return node.type !== 'FrontierNode'
}

// Deterministic per-node text. Stable keys let the cache hit across
// extractions when nothing material changed.
export function embedText(node: GraphNode): string {
  const parts: string[] = [node.id]
  const name = (node as { name?: string }).name
  if (name) parts.push(name)
  switch (node.type) {
    case 'ServiceNode': {
      const lang = (node as { language?: string }).language
      if (lang) parts.push(`language=${lang}`)
      break
    }
    case 'DatabaseNode': {
      const eng = (node as { engine?: string }).engine
      const ver = (node as { engineVersion?: string }).engineVersion
      if (eng) parts.push(`engine=${eng}`)
      if (ver) parts.push(`engineVersion=${ver}`)
      break
    }
    case 'InfraNode': {
      const kind = (node as { kind?: string }).kind
      if (kind) parts.push(`kind=${kind}`)
      break
    }
    case 'ConfigNode': {
      const filePath = (node as { path?: string }).path
      if (filePath) parts.push(`path=${filePath}`)
      break
    }
    case 'RouteNode': {
      const method = (node as { method?: string }).method
      const tmpl = (node as { pathTemplate?: string }).pathTemplate
      if (method) parts.push(`method=${method}`)
      if (tmpl) parts.push(`path=${tmpl}`)
      break
    }
    case 'GraphQLOperationNode': {
      const opType = (node as { operationType?: string }).operationType
      if (opType) parts.push(`operationType=${opType}`)
      break
    }
    default:
      break
  }
  return parts.join(' ')
}

function attrsHash(node: GraphNode): string {
  return createHash('sha1').update(embedText(node)).digest('hex').slice(0, 16)
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ---------------------------------------------------------------- Embedders

function ollamaHost(): string | null {
  return process.env.OLLAMA_HOST ?? null
}

async function ollamaReachable(host: string): Promise<boolean> {
  try {
    const res = await fetch(`${host.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(500),
    })
    return res.ok
  } catch {
    return false
  }
}

function makeOllamaEmbedder(host: string, model = 'nomic-embed-text'): Embedder {
  const root = host.replace(/\/$/, '')
  return {
    provider: 'ollama',
    model,
    dim: NOMIC_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = []
      // Ollama's /api/embeddings is one-text-per-request. ≤10K nodes × ~30ms
      // each is fine for a one-shot index build; if it ever isn't, the API
      // also accepts batched input on /api/embed (newer routes).
      for (const text of texts) {
        const res = await fetch(`${root}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: text }),
        })
        if (!res.ok) {
          throw new Error(`ollama embeddings: ${res.status} ${res.statusText}`)
        }
        const data = (await res.json()) as { embedding: number[] }
        out.push(Float32Array.from(data.embedding))
      }
      return out
    },
  }
}

interface XenovaPipeline {
  (text: string | string[], options?: { pooling?: string; normalize?: boolean }): Promise<{
    data: Float32Array
  }>
}

async function makeTransformersEmbedder(): Promise<Embedder | null> {
  let pipelineFn: ((task: string, model: string) => Promise<XenovaPipeline>) | null = null
  try {
    // Lazy require so server.ts boot doesn't pay the WASM init cost when
    // Ollama is available. The package is heavy — only load it on demand.
    // The package is optional so its types may not be installed in every
    // environment. Use a dynamic specifier so tsc keeps the import dynamic
    // and doesn't try to resolve types at build time.
    const specifier = '@xenova/transformers'
    const mod = (await import(specifier)) as unknown as {
      pipeline: (task: string, model: string) => Promise<XenovaPipeline>
    }
    pipelineFn = mod.pipeline
  } catch {
    return null
  }
  if (!pipelineFn) return null
  const model = 'Xenova/all-MiniLM-L6-v2'
  const extractor = await pipelineFn('feature-extraction', model)
  return {
    provider: 'transformers',
    model,
    dim: MINI_LM_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = []
      for (const text of texts) {
        // Mean-pooled, L2-normalized → cosine reduces to dot product but
        // we keep the explicit cosine() for clarity.
        const result = await extractor(text, { pooling: 'mean', normalize: true })
        out.push(Float32Array.from(result.data))
      }
      return out
    },
  }
}

// Picks the highest-tier embedder available. Returns null when only
// substring is available (caller decides what to build).
export async function pickEmbedder(): Promise<Embedder | null> {
  const host = ollamaHost()
  if (host && (await ollamaReachable(host))) {
    return makeOllamaEmbedder(host)
  }
  return makeTransformersEmbedder()
}

// ------------------------------------------------------------------ Cache

interface CacheEntry {
  nodeId: string
  attrsHash: string
  vector: number[]
}

interface CacheFile {
  version: 1
  provider: 'ollama' | 'transformers'
  model: string
  dim: number
  entries: CacheEntry[]
}

async function readCache(cachePath: string): Promise<CacheFile | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8')
    const parsed = JSON.parse(raw) as CacheFile
    if (parsed.version !== 1) return null
    return parsed
  } catch {
    return null
  }
}

async function writeCache(cachePath: string, cache: CacheFile): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  await fs.writeFile(cachePath, JSON.stringify(cache))
}

// ----------------------------------------------------------------- Indexes

class VectorIndex implements SearchIndex {
  readonly provider: 'ollama' | 'transformers'
  private vectors = new Map<string, { node: GraphNode; vector: Float32Array; hash: string }>()

  constructor(
    private embedder: Embedder,
    private cachePath: string | null,
  ) {
    this.provider = embedder.provider
  }

  async search(query: string, limit = DEFAULT_LIMIT): Promise<SearchResponse> {
    const trimmed = query.trim()
    if (!trimmed || this.vectors.size === 0) {
      return { query: trimmed, provider: this.provider, matches: [] }
    }
    const embedded = await this.embedder.embed([trimmed])
    const qv = embedded[0]
    if (!qv) {
      return { query: trimmed, provider: this.provider, matches: [] }
    }
    const scored: ScoredNode[] = []
    for (const { node, vector } of this.vectors.values()) {
      const score = cosine(qv, vector)
      scored.push({ node, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return { query: trimmed, provider: this.provider, matches: scored.slice(0, limit) }
  }

  async refresh(graph: NeatGraph): Promise<void> {
    const present = new Set<string>()
    const toEmbed: { id: string; node: GraphNode; hash: string; text: string }[] = []

    graph.forEachNode((id, attrs) => {
      const node = attrs as GraphNode
      if (!shouldEmbed(node)) return
      present.add(id)
      const hash = attrsHash(node)
      const cached = this.vectors.get(id)
      if (cached && cached.hash === hash) {
        cached.node = node
        return
      }
      toEmbed.push({ id, node, hash, text: embedText(node) })
    })

    // Drop vanished nodes
    for (const id of [...this.vectors.keys()]) {
      if (!present.has(id)) this.vectors.delete(id)
    }

    if (toEmbed.length > 0) {
      const vectors = await this.embedder.embed(toEmbed.map((e) => e.text))
      toEmbed.forEach((entry, i) => {
        const v = vectors[i]
        if (!v) return
        this.vectors.set(entry.id, { node: entry.node, vector: v, hash: entry.hash })
      })
    }

    if (this.cachePath) {
      const entries: CacheEntry[] = []
      for (const [id, { vector, hash }] of this.vectors) {
        entries.push({ nodeId: id, attrsHash: hash, vector: Array.from(vector) })
      }
      await writeCache(this.cachePath, {
        version: 1,
        provider: this.embedder.provider,
        model: this.embedder.model,
        dim: this.embedder.dim,
        entries,
      })
    }
  }

  // Hydrate the in-memory map from a previously-written cache. Validates
  // shape against the current embedder; mismatch → empty start.
  loadFromCache(cache: CacheFile, graph: NeatGraph): void {
    if (
      cache.provider !== this.embedder.provider ||
      cache.model !== this.embedder.model ||
      cache.dim !== this.embedder.dim
    ) {
      return
    }
    const present = new Map<string, GraphNode>()
    graph.forEachNode((id, attrs) => {
      const node = attrs as GraphNode
      if (shouldEmbed(node)) present.set(id, node)
    })
    for (const entry of cache.entries) {
      const node = present.get(entry.nodeId)
      if (!node) continue
      // Skip cache entries whose attrs no longer match — they'll be
      // re-embedded by the next refresh().
      if (attrsHash(node) !== entry.attrsHash) continue
      if (entry.vector.length !== this.embedder.dim) continue
      this.vectors.set(entry.nodeId, {
        node,
        hash: entry.attrsHash,
        vector: Float32Array.from(entry.vector),
      })
    }
  }
}

class SubstringIndex implements SearchIndex {
  readonly provider = 'substring' as const
  private graph: NeatGraph | null = null

  async search(query: string, limit = DEFAULT_LIMIT): Promise<SearchResponse> {
    const q = query.trim().toLowerCase()
    const out: ScoredNode[] = []
    if (!q || !this.graph) {
      return { query: q, provider: 'substring', matches: [] }
    }
    this.graph.forEachNode((id, attrs) => {
      const node = attrs as GraphNode
      const name = (node as { name?: string }).name ?? ''
      if (id.toLowerCase().includes(q) || name.toLowerCase().includes(q)) {
        out.push({ node, score: 1 })
      }
    })
    return { query: q, provider: 'substring', matches: out.slice(0, limit) }
  }

  async refresh(graph: NeatGraph): Promise<void> {
    this.graph = graph
  }
}

// ------------------------------------------------------------ Public factory

export interface BuildSearchIndexOptions {
  // Where to read/write the embedding cache. Falls back to in-memory only
  // if not provided. Pass `null` to explicitly disable caching.
  cachePath?: string | null
  // Override the embedder selection. Useful for tests (substring-only mode
  // skips the Ollama probe + the Transformers.js download).
  forceProvider?: 'ollama' | 'transformers' | 'substring'
  // Pre-built embedder (test injection). Wins over forceProvider.
  embedder?: Embedder
}

export async function buildSearchIndex(
  graph: NeatGraph,
  options: BuildSearchIndexOptions = {},
): Promise<SearchIndex> {
  let embedder: Embedder | null = null
  if (options.embedder) {
    embedder = options.embedder
  } else if (options.forceProvider !== 'substring') {
    embedder = await pickEmbedder()
    if (options.forceProvider === 'ollama' && embedder?.provider !== 'ollama') {
      embedder = null
    }
    if (options.forceProvider === 'transformers' && embedder?.provider !== 'transformers') {
      embedder = null
    }
  }

  if (!embedder) {
    const idx = new SubstringIndex()
    await idx.refresh(graph)
    return idx
  }

  const cachePath = options.cachePath === undefined ? null : options.cachePath
  const idx = new VectorIndex(embedder, cachePath)
  if (cachePath) {
    const cache = await readCache(cachePath)
    if (cache) idx.loadFromCache(cache, graph)
  }
  await idx.refresh(graph)
  return idx
}

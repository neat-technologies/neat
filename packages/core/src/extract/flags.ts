import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GraphEdge, InfraNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  infraId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { flagStoreProviders } from '../compat.js'
import { FLAG_STORE_KIND, foldDeclaredFlags, parseFlagDocument, type DeclaredFlag } from '../flags.js'
import type { FlagDefinition } from '@neat.is/types'
import { isTestPath, makeEdgeId, maskCommentsInSource, type DiscoveredService } from './shared.js'
import { ensureFileNode, isMinifiedSource, toPosix, walkSourceFiles } from './calls/shared.js'

// Flag grain, EXTRACTED side (ADR-242). Two reads:
//
// 1. The committed definitions. A flag file is any `.json` under the scan root
//    whose top level holds a `flags` object of flag definitions and whose
//    `$schema` names a flag-store provider listed in compat.json. Each provider
//    becomes one `flag-store` InfraNode; each flag a grain entry on it carrying
//    its canonical definition. Only the `flags` object is read.
// 2. The code that reads each key. A source file holding a string literal exactly
//    equal to a declared key reads that flag. The match is on the literal, not on
//    any SDK call shape, so it holds in every language the walk covers and through
//    a wrapper or a constant: the literal is still in the service's own tree. The
//    file gets an EXTRACTED CONNECTS_TO to the store (the dependency, evidence at
//    the literal's line), and the flag records the file as a reader.
//
// A key built at runtime holds no literal and gets no reader: nothing is guessed.

const JSON_EXTENSIONS: ReadonlySet<string> = new Set(['.json'])
// A flag file is small. Anything past this is data, not a flag file.
const MAX_FLAG_FILE_BYTES = 1_000_000
// One string literal on one line, in any of the three quote styles the walked
// languages use. Comments are masked first, so a key named in a comment is not a
// reader.
const STRING_LITERAL_RE = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g

function providerFor(doc: unknown): string | null {
  if (typeof doc !== 'object' || doc === null) return null
  const schema = (doc as Record<string, unknown>)['$schema']
  if (typeof schema !== 'string') return null
  for (const p of flagStoreProviders()) {
    if (schema.includes(p.schemaPattern)) return p.provider
  }
  return null
}

interface FlagFile {
  provider: string
  relPath: string
  flags: Map<string, FlagDefinition>
}

async function findFlagFiles(scanPath: string): Promise<FlagFile[]> {
  const out: FlagFile[] = []
  const files = (await walkSourceFiles(scanPath, [], JSON_EXTENSIONS)).sort()
  for (const file of files) {
    const relPath = toPosix(path.relative(scanPath, file))
    if (isTestPath(relPath)) continue
    let text: string
    try {
      const stat = await fs.stat(file)
      if (stat.size > MAX_FLAG_FILE_BYTES) continue
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    // Cheap gate before a parse: every flag file names both words.
    if (!text.includes('"flags"') || !text.includes('"variants"')) continue
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      continue
    }
    const provider = providerFor(doc)
    if (!provider) continue
    const flags = parseFlagDocument(doc)
    if (flags) out.push({ provider, relPath, flags })
  }
  return out
}

interface Reader {
  file: string
  service: string
  line: number
}

// Every (key → first literal line) in one source file, for the keys asked about.
function literalKeyLines(src: string, keys: ReadonlySet<string>): Map<string, number> {
  const masked = maskCommentsInSource(src)
  const out = new Map<string, number>()
  STRING_LITERAL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STRING_LITERAL_RE.exec(masked)) !== null) {
    const value = m[2]!
    if (!keys.has(value) || out.has(value)) continue
    let line = 1
    for (let i = 0; i < m.index; i++) if (masked.charCodeAt(i) === 10) line++
    out.set(value, line)
  }
  return out
}

export async function addFlagStores(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0
  const flagFiles = await findFlagFiles(scanPath)
  if (flagFiles.length === 0) return { nodesAdded, edgesAdded }

  // provider → key → declaration. The first file (sorted path) to declare a key
  // for a provider wins, so the result is stable across runs.
  const byProvider = new Map<string, Map<string, { definition: FlagDefinition; declaredIn: string }>>()
  for (const ff of flagFiles) {
    const keys = byProvider.get(ff.provider) ?? new Map()
    for (const [key, definition] of ff.flags) {
      if (!keys.has(key)) keys.set(key, { definition, declaredIn: ff.relPath })
    }
    byProvider.set(ff.provider, keys)
  }

  for (const [provider, declarations] of byProvider) {
    const storeId = infraId(FLAG_STORE_KIND, provider)
    if (!graph.hasNode(storeId)) {
      const node: InfraNode = {
        id: storeId,
        type: NodeType.InfraNode,
        name: provider,
        provider,
        kind: FLAG_STORE_KIND,
      }
      graph.addNode(storeId, node)
      nodesAdded++
    }

    const keys = new Set(declarations.keys())
    const readers = new Map<string, Reader[]>()
    for (const service of services) {
      const files = await walkSourceFiles(service.dir, service.excludeDirs)
      for (const file of files) {
        const relToService = toPosix(path.relative(service.dir, file))
        if (isTestPath(relToService)) continue
        let src: string
        try {
          src = await fs.readFile(file, 'utf8')
        } catch {
          continue
        }
        if (isMinifiedSource(file, src).minified) continue
        const hits = literalKeyLines(src, keys)
        if (hits.size === 0) continue
        const { fileNodeId, nodesAdded: fn, edgesAdded: fe } = ensureFileNode(
          graph,
          service.pkg.name,
          service.node.id,
          relToService,
        )
        nodesAdded += fn
        edgesAdded += fe
        let firstLine = Number.POSITIVE_INFINITY
        for (const [key, line] of hits) {
          const list = readers.get(key) ?? []
          list.push({ file: fileNodeId, service: service.node.id, line })
          readers.set(key, list)
          firstLine = Math.min(firstLine, line)
        }
        const edge: GraphEdge = {
          id: makeEdgeId(fileNodeId, storeId, EdgeType.CONNECTS_TO),
          source: fileNodeId,
          target: storeId,
          type: EdgeType.CONNECTS_TO,
          provenance: Provenance.EXTRACTED,
          confidence: confidenceForExtracted('structural'),
          evidence: { file: toPosix(path.relative(scanPath, file)), line: firstLine },
        }
        if (!graph.hasEdge(edge.id)) {
          graph.addEdgeWithKey(edge.id, edge.source, edge.target, edge)
          edgesAdded++
        }
      }
    }

    const declared: DeclaredFlag[] = [...declarations].map(([key, d]) => ({
      key,
      definition: d.definition,
      declaredIn: d.declaredIn,
      readers: readers.get(key) ?? [],
    }))
    const node = graph.getNodeAttributes(storeId) as InfraNode
    graph.mergeNodeAttributes(storeId, { flags: foldDeclaredFlags(node.flags, declared) })
  }
  return { nodesAdded, edgesAdded }
}

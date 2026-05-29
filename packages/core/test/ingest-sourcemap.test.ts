// dist→src source-map resolution at ingest (file-awareness.md §4, ADR-090).
//
// A NEAT-emitted span whose `code.filepath` is a compiled `dist/...js` should
// land its OBSERVED FileNode on the original `src/...ts`, resolved through a
// disk-adjacent `.map`, with the raw dist frame preserved as `originalPath`.
// When no map is on the daemon's disk the dist frame is kept verbatim — honest,
// never fabricated (§6).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { MultiDirectedGraph } from 'graphology'
import { type GraphEdge, type GraphNode, type FileNode, NodeType } from '@neat.is/types'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import type { ParsedSpan } from '../src/otel.js'
import type { NeatGraph } from '../src/graph.js'

function graphWithService(repoPath: string): NeatGraph {
  const g: NeatGraph = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
  g.addNode('service:svc', {
    id: 'service:svc',
    type: NodeType.ServiceNode,
    name: 'svc',
    language: 'javascript',
    repoPath,
  })
  return g
}

function clientSpanAt(filepath: string, lineno: number): ParsedSpan {
  return {
    service: 'svc',
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'GET /x',
    kind: 2,
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env: 'unknown',
    attributes: {
      'http.method': 'GET',
      'server.address': 'api.example.com',
      'code.filepath': filepath,
      'code.lineno': lineno,
      'code.function': 'handler',
    },
    statusCode: 0,
  }
}

function fileNodesOf(graph: NeatGraph): FileNode[] {
  return graph
    .filterNodes((_id, a) => (a as GraphNode).type === NodeType.FileNode)
    .map((id) => graph.getNodeAttributes(id) as FileNode)
}

describe('dist→src source-map resolution at ingest (file-awareness §4)', () => {
  let tmpDir: string
  let svcDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-sm-'))
    // `mysvc` is the repo-relative segment the ServiceNode anchors on; the
    // service tree lives under a unique tmp dir so the module-level source-map
    // cache (keyed on the absolute dist path) never crosses between cases.
    svcDir = path.join(tmpDir, 'mysvc')
    await fs.mkdir(path.join(svcDir, 'dist'), { recursive: true })
    await fs.mkdir(path.join(svcDir, 'src'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('lands the FileNode on the original src file and preserves the dist frame', async () => {
    await fs.writeFile(path.join(svcDir, 'src', 'app.ts'), 'export const x = 1\n')
    await fs.writeFile(
      path.join(svcDir, 'dist', 'app.js'),
      'const x = 1\n//# sourceMappingURL=app.js.map\n',
    )
    // Minimal valid map: generated (0,0) → source 0 original (0,0). "AAAA".
    await fs.writeFile(
      path.join(svcDir, 'dist', 'app.js.map'),
      JSON.stringify({
        version: 3,
        file: 'app.js',
        sourceRoot: '',
        sources: ['../src/app.ts'],
        names: [],
        mappings: 'AAAA',
      }),
    )
    const graph = graphWithService('mysvc')
    const ctx: IngestContext = { graph, errorsPath: path.join(tmpDir, 'errors.ndjson') }
    await handleSpan(ctx, clientSpanAt(path.join(svcDir, 'dist', 'app.js'), 1))

    const files = fileNodesOf(graph)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('src/app.ts')
    expect(files[0].originalPath).toBe('dist/app.js')
  })

  it('keeps the dist frame when no adjacent map is on disk (never fabricated)', async () => {
    await fs.writeFile(path.join(svcDir, 'dist', 'app.js'), 'const x = 1\n')
    const graph = graphWithService('mysvc')
    const ctx: IngestContext = { graph, errorsPath: path.join(tmpDir, 'errors.ndjson') }
    await handleSpan(ctx, clientSpanAt(path.join(svcDir, 'dist', 'app.js'), 1))

    const files = fileNodesOf(graph)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('dist/app.js')
    expect(files[0].originalPath).toBeUndefined()
  })

  it('leaves a source-grained call site untouched (no .js, no resolution)', async () => {
    await fs.writeFile(path.join(svcDir, 'src', 'route.ts'), 'export const r = 1\n')
    const graph = graphWithService('mysvc')
    const ctx: IngestContext = { graph, errorsPath: path.join(tmpDir, 'errors.ndjson') }
    await handleSpan(ctx, clientSpanAt(path.join(svcDir, 'src', 'route.ts'), 1))

    const files = fileNodesOf(graph)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('src/route.ts')
    expect(files[0].originalPath).toBeUndefined()
  })
})

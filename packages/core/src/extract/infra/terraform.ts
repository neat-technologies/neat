import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance, confidenceForExtracted } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { IGNORED_DIRS, isPythonVenvDir, makeEdgeId } from '../shared.js'
import { toPosix } from '../calls/shared.js'
import { makeInfraNode } from './shared.js'
import { declared } from '../declare.js'

// Light pass: catalogue `resource "aws_*" "name"` blocks in any *.tf file and
// wire the references between them. We don't run a real Terraform backend, but
// the body of every resource block names the other resources it consumes
// (`aws_db_instance.main.endpoint`, `${aws_security_group.db.id}`, …). Those
// `<type>.<name>` references are the structural fact that turns an edgeless
// catalogue into a topology: a resource nothing points at is declared-but-unused,
// a resource something points at is in use. Without this, an RDS instance the
// app server depends on looks identical to a forgotten S3 bucket.
const RESOURCE_RE = /resource\s+"(aws_[A-Za-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"/g
// A reference to another declared resource. The negative look-behind keeps us
// from matching the tail of a longer identifier (`my_aws_thing.x`).
const REFERENCE_RE = /(?<![\w.])(aws_[A-Za-z0-9_]+)\.([A-Za-z0-9_-]+)/g

interface TfResource {
  type: string
  name: string
  nodeId: string
  body: string
  bodyOffset: number
}

async function walkTfFiles(start: string, depth = 0, max = 5): Promise<string[]> {
  if (depth > max) return []
  const out: string[] = []
  const entries = await fs.readdir(start, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name === '.terraform') continue
      const child = path.join(start, entry.name)
      if (await isPythonVenvDir(child)) continue
      out.push(...(await walkTfFiles(child, depth + 1, max)))
    } else if (entry.isFile() && entry.name.endsWith('.tf')) {
      out.push(path.join(start, entry.name))
    }
  }
  return out
}

// Find the index just past the `}` that closes the block whose opening `{`
// sits at or after `from`. Returns the body span (exclusive of the braces).
// Balanced-brace scan — good enough for HCL, which doesn't put bare braces in
// string literals often enough to matter for a reference catalogue.
function blockBody(content: string, from: number): { body: string; offset: number } | null {
  const open = content.indexOf('{', from)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < content.length; i++) {
    const ch = content[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { body: content.slice(open + 1, i), offset: open + 1 }
    }
  }
  return null
}

function lineAt(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

export async function addTerraformResources(
  graph: NeatGraph,
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0
  const files = await walkTfFiles(scanPath)
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8')
    const evidenceFile = toPosix(path.relative(scanPath, file))

    // First pass: register every resource as a node and remember its body so
    // the second pass can resolve references against the set of declared names.
    const resources: TfResource[] = []
    const byKey = new Map<string, TfResource>()
    RESOURCE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = RESOURCE_RE.exec(content)) !== null) {
      const type = m[1]!
      const name = m[2]!
      const node = makeInfraNode(type, name, 'aws')
      declared(graph, 'node', node.id)
      if (!graph.hasNode(node.id)) {
        graph.addNode(node.id, node)
        nodesAdded++
      }
      const span = blockBody(content, RESOURCE_RE.lastIndex)
      const resource: TfResource = {
        type,
        name,
        nodeId: node.id,
        body: span?.body ?? '',
        bodyOffset: span?.offset ?? RESOURCE_RE.lastIndex,
      }
      resources.push(resource)
      byKey.set(`${type}.${name}`, resource)
    }

    // Second pass: a `<type>.<name>` reference inside a resource body that
    // names another declared resource becomes a DEPENDS_ON edge from the
    // referencing resource to the one it consumes. Structural tier (ADR-066) —
    // the HCL literally says it depends on it.
    for (const resource of resources) {
      const seen = new Set<string>()
      REFERENCE_RE.lastIndex = 0
      let ref: RegExpExecArray | null
      while ((ref = REFERENCE_RE.exec(resource.body)) !== null) {
        const key = `${ref[1]!}.${ref[2]!}`
        if (key === `${resource.type}.${resource.name}`) continue
        const target = byKey.get(key)
        if (!target) continue
        if (seen.has(target.nodeId)) continue
        seen.add(target.nodeId)
        const edgeId = makeEdgeId(resource.nodeId, target.nodeId, EdgeType.DEPENDS_ON)
        declared(graph, 'edge', edgeId)
        if (graph.hasEdge(edgeId)) continue
        const line = lineAt(content, resource.bodyOffset + ref.index)
        const edge: GraphEdge = {
          id: edgeId,
          source: resource.nodeId,
          target: target.nodeId,
          type: EdgeType.DEPENDS_ON,
          provenance: Provenance.EXTRACTED,
          confidence: confidenceForExtracted('structural'),
          evidence: { file: evidenceFile, line, snippet: key },
        }
        graph.addEdgeWithKey(edgeId, edge.source, edge.target, edge)
        edgesAdded++
      }
    }
  }
  return { nodesAdded, edgesAdded }
}

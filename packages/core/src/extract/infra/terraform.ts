import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { NeatGraph } from '../../graph.js'
import { IGNORED_DIRS, isPythonVenvDir } from '../shared.js'
import { makeInfraNode } from './shared.js'

// Light pass: catalogue `resource "aws_*" "name"` blocks in any *.tf file.
// We don't interpret references — a real Terraform backend would resolve
// those — but the resource-type/name pair is enough to register the node so
// later cross-references can hang off it.
const RESOURCE_RE = /resource\s+"(aws_[A-Za-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"/g

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

export async function addTerraformResources(
  graph: NeatGraph,
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  const files = await walkTfFiles(scanPath)
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8')
    RESOURCE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = RESOURCE_RE.exec(content)) !== null) {
      const kind = m[1]!
      const name = m[2]!
      const node = makeInfraNode(kind, name, 'aws')
      if (!graph.hasNode(node.id)) {
        graph.addNode(node.id, node)
        nodesAdded++
      }
    }
  }
  return { nodesAdded, edgesAdded: 0 }
}

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseAllDocuments } from 'yaml'
import type { NeatGraph } from '../../graph.js'
import { CONFIG_FILE_EXTENSIONS, IGNORED_DIRS, isPythonVenvDir } from '../shared.js'
import { makeInfraNode } from './shared.js'

interface K8sDoc {
  kind?: string
  metadata?: { name?: string; namespace?: string }
}

const K8S_KIND_TO_INFRA_KIND: Record<string, string> = {
  Service: 'k8s-service',
  Deployment: 'k8s-deployment',
  StatefulSet: 'k8s-statefulset',
  DaemonSet: 'k8s-daemonset',
  CronJob: 'k8s-cronjob',
  Job: 'k8s-job',
  Ingress: 'k8s-ingress',
}

async function walkYamlFiles(start: string, depth = 0, max = 5): Promise<string[]> {
  if (depth > max) return []
  const out: string[] = []
  const entries = await fs.readdir(start, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      const child = path.join(start, entry.name)
      if (await isPythonVenvDir(child)) continue
      out.push(...(await walkYamlFiles(child, depth + 1, max)))
    } else if (entry.isFile() && CONFIG_FILE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(start, entry.name))
    }
  }
  return out
}

// Multi-document YAML with kind/metadata.name. We keep the matching simple:
// any file whose first doc looks k8s-shaped. The match is on `kind` only —
// random YAML configs (db-config.yaml, etc.) are usually flat objects with no
// `kind` field, so they're ignored without false positives.
export async function addK8sResources(
  graph: NeatGraph,
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  const files = await walkYamlFiles(scanPath)
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8')
    let docs: K8sDoc[]
    try {
      docs = parseAllDocuments(content).map((d) => d.toJSON() as K8sDoc)
    } catch {
      continue
    }
    for (const doc of docs) {
      if (!doc?.kind || !doc.metadata?.name) continue
      const infraKind = K8S_KIND_TO_INFRA_KIND[doc.kind]
      if (!infraKind) continue
      const namespaced = doc.metadata.namespace
        ? `${doc.metadata.namespace}/${doc.metadata.name}`
        : doc.metadata.name
      const node = makeInfraNode(infraKind, namespaced, 'kubernetes')
      if (!graph.hasNode(node.id)) {
        graph.addNode(node.id, node)
        nodesAdded++
      }
    }
  }
  return { nodesAdded, edgesAdded: 0 }
}

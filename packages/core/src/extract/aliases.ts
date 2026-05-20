import path from 'node:path'
import { promises as fs } from 'node:fs'
import { parseAllDocuments } from 'yaml'
import type { ServiceNode } from '@neat.is/types'
import { NodeType } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { recordExtractionError } from './errors.js'
import {
  CONFIG_FILE_EXTENSIONS,
  IGNORED_DIRS,
  exists,
  isPythonVenvDir,
  readYaml,
  type DiscoveredService,
} from './shared.js'

// Populate ServiceNode.aliases from sources that the OTel layer is likely to
// see in span attributes:
//
//   - docker-compose service names (compose-DNS).
//   - Dockerfile LABEL values that name the service.
//   - k8s metadata.name (and the cluster-DNS variants) for Service /
//     Deployment / StatefulSet whose name matches a known service.
//
// resolveServiceId in ingest.ts checks aliases before falling back to a
// FRONTIER placeholder; promoteFrontierNodes uses them to retire stale
// placeholders once they map to a real service.

interface ComposeService {
  container_name?: string
  hostname?: string
  networks?: string[] | Record<string, unknown>
}

interface ComposeFile {
  services?: Record<string, ComposeService>
}

interface K8sDoc {
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
    labels?: Record<string, string>
  }
  spec?: {
    selector?: {
      app?: string
      matchLabels?: Record<string, string>
    }
  }
}

const K8S_KINDS_WITH_HOSTNAMES = new Set([
  'Service',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
])

function addAliases(graph: NeatGraph, serviceId: string, candidates: Iterable<string>): void {
  if (!graph.hasNode(serviceId)) return
  const node = graph.getNodeAttributes(serviceId) as ServiceNode & { type?: string }
  if (node.type !== NodeType.ServiceNode) return
  const set = new Set(node.aliases ?? [])
  for (const c of candidates) {
    if (!c) continue
    if (c === node.name) continue
    set.add(c)
  }
  if (set.size === 0) return
  const updated: ServiceNode = { ...node, aliases: [...set].sort() }
  graph.replaceNodeAttributes(serviceId, updated)
}

function indexServicesByName(services: DiscoveredService[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const s of services) {
    map.set(s.node.name, s.node.id)
    map.set(path.basename(s.dir), s.node.id)
  }
  return map
}

async function collectComposeAliases(
  graph: NeatGraph,
  scanPath: string,
  serviceIndex: Map<string, string>,
): Promise<void> {
  let composePath: string | null = null
  for (const name of ['docker-compose.yml', 'docker-compose.yaml']) {
    const abs = path.join(scanPath, name)
    if (await exists(abs)) {
      composePath = abs
      break
    }
  }
  if (!composePath) return

  let compose: ComposeFile
  try {
    compose = await readYaml<ComposeFile>(composePath)
  } catch (err) {
    recordExtractionError(
      'aliases compose',
      path.relative(scanPath, composePath),
      err,
    )
    return
  }
  if (!compose?.services) return

  for (const [composeName, svc] of Object.entries(compose.services)) {
    const serviceId = serviceIndex.get(composeName)
    if (!serviceId) continue
    const aliases = new Set<string>([composeName])
    if (svc.container_name) aliases.add(svc.container_name)
    if (svc.hostname) aliases.add(svc.hostname)
    addAliases(graph, serviceId, aliases)
  }
}

const LABEL_KEYS = new Set([
  'service',
  'service.name',
  'app',
  'app.name',
  'com.docker.compose.service',
  'org.opencontainers.image.title',
])

function parseDockerfileLabels(content: string): string[] {
  const out: string[] = []
  // Support `LABEL key=value`, `LABEL key="value with spaces"`, and the
  // multi-pair form `LABEL k1=v1 k2=v2`. We don't try to honour line
  // continuations — the common single-line form is enough.
  const lineRegex = /^\s*label\s+(.+)$/i
  for (const raw of content.split('\n')) {
    const m = lineRegex.exec(raw)
    if (!m) continue
    const rest = m[1]!
    const pairRegex = /([\w.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s]+))/g
    let pair: RegExpExecArray | null
    while ((pair = pairRegex.exec(rest)) !== null) {
      const key = pair[1]!.toLowerCase()
      if (!LABEL_KEYS.has(key)) continue
      const value = pair[3] ?? pair[4] ?? pair[5] ?? ''
      if (value) out.push(value)
    }
  }
  return out
}

async function collectDockerfileAliases(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<void> {
  for (const service of services) {
    const dockerfilePath = path.join(service.dir, 'Dockerfile')
    if (!(await exists(dockerfilePath))) continue
    let content: string
    try {
      content = await fs.readFile(dockerfilePath, 'utf8')
    } catch (err) {
      recordExtractionError('aliases dockerfile', dockerfilePath, err)
      continue
    }
    const aliases = parseDockerfileLabels(content)
    if (aliases.length > 0) addAliases(graph, service.node.id, aliases)
  }
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

function k8sHostnames(name: string, namespace: string | undefined): string[] {
  const ns = namespace ?? 'default'
  return [
    name,
    `${name}.${ns}`,
    `${name}.${ns}.svc`,
    `${name}.${ns}.svc.cluster.local`,
  ]
}

function k8sServiceTarget(
  doc: K8sDoc,
  byName: Map<string, string>,
): string | null {
  // For `Service` resources, the target is whatever app the spec selects, not
  // necessarily the Service's own metadata.name. We prefer that mapping; if no
  // selector, fall back to the metadata.name match.
  const selector = doc.spec?.selector
  const selectorApp = selector?.app ?? selector?.matchLabels?.app
  if (selectorApp && byName.has(selectorApp)) return byName.get(selectorApp)!

  const labelApp = doc.metadata?.labels?.app
  if (labelApp && byName.has(labelApp)) return byName.get(labelApp)!

  const metaName = doc.metadata?.name
  if (metaName && byName.has(metaName)) return byName.get(metaName)!

  return null
}

async function collectK8sAliases(
  graph: NeatGraph,
  scanPath: string,
  serviceIndex: Map<string, string>,
): Promise<void> {
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
      if (!K8S_KINDS_WITH_HOSTNAMES.has(doc.kind)) continue
      const target = k8sServiceTarget(doc, serviceIndex)
      if (!target) continue
      addAliases(graph, target, k8sHostnames(doc.metadata.name, doc.metadata.namespace))
    }
  }
}

export async function addServiceAliases(
  graph: NeatGraph,
  scanPath: string,
  services: DiscoveredService[],
): Promise<void> {
  const byName = indexServicesByName(services)
  await collectComposeAliases(graph, scanPath, byName)
  await collectDockerfileAliases(graph, services)
  await collectK8sAliases(graph, scanPath, byName)
}

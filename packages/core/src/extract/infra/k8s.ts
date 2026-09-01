import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseAllDocuments } from 'yaml'
import { EdgeType, serviceId } from '@neat.is/types'
import type { InfraNode, ServiceNode } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import { CONFIG_FILE_EXTENSIONS, IGNORED_DIRS, isPythonVenvDir } from '../shared.js'
import { toPosix } from '../calls/shared.js'
import { emitPlatformResourceEdge, lineContaining, makeInfraNode } from './shared.js'

interface K8sDoc {
  kind?: string
  metadata?: { name?: string; namespace?: string }
  spec?: {
    replicas?: number
    template?: { spec?: { containers?: Array<{ image?: string }> } }
  }
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

// The kinds that carry a pod template we read the declared image + replica count
// from. Service / Ingress / Job-style kinds have neither (a Job/CronJob nests its
// template a level deeper and is left for a later rung).
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet'])

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

// The k8s deployment substrate — the DECLARED half. Reads workload manifests
// (multi-document YAML with a `kind`/`metadata.name`) and records the desired
// deploy state: the container image and replica count a Deployment/StatefulSet/
// DaemonSet declares. The declared state is stamped onto the `service:<name>` node
// the workload runs (`declaredImage`/`declaredReplicas`), where the k8s observed
// reader stamps the running image / ready replicas — the two provenances fuse on
// one node so the divergence detector can name a declared-vs-running deploy drift,
// including the stuck rollout that mints no incident (service still up on the old
// image). The workload also gets its own `infra:k8s-deployment:<name>` InfraNode
// with image/replicas + a RUNS_ON edge, for topology and blast-radius.
//
// The InfraNode is keyed NAME-ONLY (`infraId(kind, metadata.name)`), not
// `<ns>/<name>`: a manifest frequently omits `metadata.namespace` (relying on
// `kubectl apply -n`), so the name is the only key the declared manifest and the
// live cluster can both produce, and it matches NEAT's name-based identity (a
// ServiceNode is `service:<name>`, ADR-010). The namespace rides as an attribute.
export async function addK8sResources(
  graph: NeatGraph,
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0
  const files = await walkYamlFiles(scanPath)
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8')
    let docs: K8sDoc[]
    try {
      docs = parseAllDocuments(content).map((d) => d.toJSON() as K8sDoc)
    } catch {
      continue
    }
    const relFile = toPosix(path.relative(scanPath, file))
    for (const doc of docs) {
      if (!doc?.kind || !doc.metadata?.name) continue
      const infraKind = K8S_KIND_TO_INFRA_KIND[doc.kind]
      if (!infraKind) continue
      const name = doc.metadata.name

      const isWorkload = WORKLOAD_KINDS.has(doc.kind)
      const image = isWorkload ? doc.spec?.template?.spec?.containers?.[0]?.image : undefined
      const replicas =
        isWorkload && typeof doc.spec?.replicas === 'number' ? doc.spec.replicas : undefined

      const base = makeInfraNode(infraKind, name, 'kubernetes')
      const node: InfraNode = {
        ...base,
        ...(doc.metadata.namespace ? { namespace: doc.metadata.namespace } : {}),
        ...(image ? { image } : {}),
        ...(replicas !== undefined ? { replicas } : {}),
      }
      if (!graph.hasNode(node.id)) {
        graph.addNode(node.id, node)
        nodesAdded++
      }

      // Stamp the declared deploy state on the ServiceNode the workload runs — the
      // node the observed cluster reader stamps running-image/ready onto, so the two
      // fuse there. Only when the service already exists: no phantom, no dangle.
      if (isWorkload) {
        const svcId = serviceId(name)
        if (graph.hasNode(svcId)) {
          const svc = graph.getNodeAttributes(svcId) as ServiceNode
          graph.replaceNodeAttributes(svcId, {
            ...svc,
            platform: svc.platform ?? 'kubernetes',
            ...(image ? { declaredImage: image } : {}),
            ...(replicas !== undefined ? { declaredReplicas: replicas } : {}),
          })
          // Topology edge — the service runs on this declared k8s workload. The
          // InfraNode already exists (enriched above), so this only adds the edge.
          edgesAdded += emitPlatformResourceEdge(
            graph,
            svcId,
            EdgeType.RUNS_ON,
            infraKind,
            name,
            'kubernetes',
            relFile,
            lineContaining(content, image),
          ).edgesAdded
        }
      }
    }
  }
  return { nodesAdded, edgesAdded }
}

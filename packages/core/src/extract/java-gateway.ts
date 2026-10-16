import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseAllDocuments, isMap, isSeq, isScalar, type Node as YamlNode } from 'yaml'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  routeId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { makeEdgeId, type DiscoveredService } from './shared.js'
import { recordExtractionError, noteExtractedDropped } from './errors.js'
import { resolveEnvVar } from './databases/shared.js'
import { buildServiceHostIndex, ensureFileNode, snippet, toPosix } from './calls/shared.js'

// Spring Cloud Gateway routes — config as a source. A gateway service declares
// its whole routing table in application.yml:
//
//   spring:
//     cloud:
//       gateway:
//         routes:
//           - id: order
//             uri: lb://${ORDER_SERVICE_HOST:ts-order-service}
//             predicates:
//               - Path=/api/v1/orderservice/**
//
// Each route's Path patterns become RouteNodes on the gateway (method from a
// `Method=` predicate, else ALL), owned through `service ──CONTAINS──▶ route`
// like any other route, and the config file gets `file ──CALLS──▶ service` to
// the service the `uri` names. That is the hop every request takes from the
// front door, declared in config rather than code.
//
// Read from `spring.cloud.gateway.routes` and the newer
// `spring.cloud.gateway.server.webflux.routes`, default profile only, in either
// predicate form: the shortcut string (`Path=/a/**,/b/**`) or the expanded map
// (`name: Path`, `args: { patterns: … }`). A `${NAME:default}` in the uri
// resolves from the service's `.env`, else to its default. A uri with no
// resolvable host, or whose host names no service in the graph, gets no CALLS
// edge; an unresolved one is recorded as a drop with its reason.

const CONFIG_FILES = ['application.yml', 'application.yaml']
const ROUTE_KEYS = ['spring.cloud.gateway.routes', 'spring.cloud.gateway.server.webflux.routes']
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

export interface GatewayRoute {
  id?: string
  // The uri as written, and its host once placeholders resolve (null when they
  // can't be).
  uri: string
  host: string | null
  paths: string[]
  methods: string[]
  line: number
}

// A key from a YAML map node, nested or written flat (`spring.cloud.gateway:`).
function mapGet(node: unknown, key: string): unknown {
  if (!isMap(node)) return undefined
  for (const pair of node.items) {
    const k = isScalar(pair.key) ? String(pair.key.value) : undefined
    if (k === undefined) continue
    if (k === key) return pair.value
    if (key.startsWith(k + '.')) {
      const v = mapGet(pair.value, key.slice(k.length + 1))
      if (v !== undefined) return v
    }
  }
  return undefined
}

function scalarString(node: unknown): string | undefined {
  return isScalar(node) && node.value !== null && node.value !== undefined ? String(node.value) : undefined
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

// A predicate as (name, values): `Path=/a/**,/b/**` or the expanded map form.
function predicate(node: unknown): { name: string; values: string[]; offset: number } | null {
  const offset = (node as YamlNode | undefined)?.range?.[0] ?? 0
  const s = scalarString(node)
  if (s !== undefined) {
    const eq = s.indexOf('=')
    if (eq <= 0) return null
    return { name: s.slice(0, eq).trim(), values: s.slice(eq + 1).split(',').map((v) => v.trim()).filter(Boolean), offset }
  }
  if (!isMap(node)) return null
  const name = scalarString(mapGet(node, 'name'))
  if (!name) return null
  const args = mapGet(node, 'args')
  const values: string[] = []
  if (isMap(args)) {
    for (const pair of args.items) {
      const v = pair.value
      if (isSeq(v)) for (const item of v.items) {
        const t = scalarString(item)
        if (t) values.push(...t.split(',').map((x) => x.trim()).filter(Boolean))
      }
      else {
        const t = scalarString(v)
        if (t) values.push(...t.split(',').map((x) => x.trim()).filter(Boolean))
      }
    }
  }
  return { name, values, offset }
}

async function resolvePlaceholders(serviceDir: string, value: string): Promise<string | null> {
  let out = ''
  let last = 0
  const re = /\$\{([^}:]+)(?::([^}]*))?\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    out += value.slice(last, m.index)
    const resolved = (await resolveEnvVar(serviceDir, m[1]!)) ?? m[2]
    if (resolved === undefined) return null
    out += resolved
    last = m.index + m[0].length
  }
  return out + value.slice(last)
}

// `lb://name`, `http://host:port/x`, `ws://…` → host; null otherwise.
function hostOf(uri: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(uri)
  return m ? m[1]! : null
}

/** The Spring Cloud Gateway routes one application.yml declares (default profile). */
export async function gatewayRoutesFromYaml(text: string, serviceDir: string): Promise<GatewayRoute[]> {
  const out: GatewayRoute[] = []
  for (const doc of parseAllDocuments(text)) {
    if (doc.errors.length > 0) continue
    const root = doc.contents
    if (mapGet(root, 'spring.config.activate.on-profile') !== undefined || mapGet(root, 'spring.profiles') !== undefined) {
      continue
    }
    for (const key of ROUTE_KEYS) {
      const routes = mapGet(root, key)
      if (!isSeq(routes)) continue
      for (const r of routes.items) {
        const uri = scalarString(mapGet(r, 'uri'))
        const preds = mapGet(r, 'predicates')
        if (!uri || !isSeq(preds)) continue
        const paths: string[] = []
        let methods: string[] = ['ALL']
        let line = lineAt(text, (r as YamlNode).range?.[0] ?? 0)
        for (const p of preds.items) {
          const pred = predicate(p)
          if (!pred) continue
          if (pred.name === 'Path') {
            paths.push(...pred.values)
            line = lineAt(text, pred.offset)
          } else if (pred.name === 'Method') {
            const ms = pred.values.map((v) => v.toUpperCase()).filter((v) => HTTP_METHODS.has(v))
            if (ms.length > 0) methods = ms
          }
        }
        if (paths.length === 0) continue
        const resolved = await resolvePlaceholders(serviceDir, uri)
        out.push({
          id: scalarString(mapGet(r, 'id')),
          uri,
          host: resolved ? hostOf(resolved) : null,
          paths,
          methods,
          line,
        })
      }
    }
  }
  return out
}

/** Gateway RouteNodes and the config file's CALLS to each routed service. */
export async function addGatewayRoutes(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  const { hostToNodeId } = buildServiceHostIndex(services)
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    if (service.node.language !== 'java') continue
    for (const dir of [path.join(service.dir, 'src', 'main', 'resources'), service.dir]) {
      for (const name of CONFIG_FILES) {
        const abs = path.join(dir, name)
        const text = await fs.readFile(abs, 'utf8').catch(() => null)
        if (text === null || !text.includes('gateway')) continue
        let routes: GatewayRoute[]
        try {
          routes = await gatewayRoutesFromYaml(text, service.dir)
        } catch (err) {
          recordExtractionError('gateway route extraction', abs, err)
          continue
        }
        if (routes.length === 0) continue
        const relFile = toPosix(path.relative(service.dir, abs))
        const { fileNodeId, nodesAdded: n, edgesAdded: e } = ensureFileNode(
          graph,
          service.pkg.name,
          service.node.id,
          relFile,
        )
        nodesAdded += n
        edgesAdded += e

        for (const r of routes) {
          const ev = { file: relFile, line: r.line, snippet: snippet(text, r.line) }
          for (const p of r.paths) {
            const pathTemplate = p.startsWith('/') ? p : '/' + p
            for (const method of r.methods) {
              const rid = routeId(service.pkg.name, method, pathTemplate)
              if (!graph.hasNode(rid)) {
                const node: RouteNode = {
                  id: rid,
                  type: NodeType.RouteNode,
                  name: `${method} ${pathTemplate}`,
                  service: service.pkg.name,
                  method,
                  pathTemplate,
                  path: relFile,
                  line: r.line,
                  framework: 'spring-cloud-gateway',
                  discoveredVia: 'static',
                }
                graph.addNode(rid, node)
                nodesAdded++
              }
              const containsId = extractedEdgeId(service.node.id, rid, EdgeType.CONTAINS)
              if (!graph.hasEdge(containsId)) {
                const edge: GraphEdge = {
                  id: containsId,
                  source: service.node.id,
                  target: rid,
                  type: EdgeType.CONTAINS,
                  provenance: Provenance.EXTRACTED,
                  confidence: confidenceForExtracted('structural'),
                  evidence: ev,
                }
                graph.addEdgeWithKey(containsId, service.node.id, rid, edge)
                edgesAdded++
              }
            }
          }

          if (r.host === null) {
            noteExtractedDropped({
              source: fileNodeId,
              target: 'service:unresolved',
              type: EdgeType.CALLS,
              confidence: confidenceForExtracted('reconstructed-approximate'),
              confidenceKind: 'reconstructed-approximate',
              evidence: { ...ev, approximate: true, reason: `the route's uri host doesn't resolve: ${r.uri}` },
            })
            continue
          }
          const target = hostToNodeId.get(r.host)
          if (!target || target === service.node.id) continue
          const edgeId = makeEdgeId(fileNodeId, target, EdgeType.CALLS)
          if (graph.hasEdge(edgeId)) continue
          const edge: GraphEdge = {
            id: edgeId,
            source: fileNodeId,
            target,
            type: EdgeType.CALLS,
            provenance: Provenance.EXTRACTED,
            // A declared routing table: the gateway forwards these paths to this
            // service by configuration, not by a guessed URL.
            confidence: confidenceForExtracted('structural'),
            evidence: { ...ev, pathTemplate: r.paths[0] },
          }
          graph.addEdgeWithKey(edgeId, fileNodeId, target, edge)
          edgesAdded++
        }
      }
    }
  }

  return { nodesAdded, edgesAdded }
}

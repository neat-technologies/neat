import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GraphEdge, GrpcMethodNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  confidenceForExtracted,
  extractedEdgeId,
  grpcMethodId,
} from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { IGNORED_DIRS, isPythonVenvDir, isTestPath, type DiscoveredService } from './shared.js'
import { recordExtractionError } from './errors.js'
import { snippet, toPosix } from './calls/shared.js'

// gRPC `.proto` service/method extraction (ADR-123). gRPC used to engage only at
// service grain — the client-stub detector in calls/grpc.ts maps a
// `new OrderServiceClient()` to one `infra:grpc-service:*` node, and nothing read
// the method surface at all. This producer reads the `.proto` service contract
// as DATA (a bounded line-scan, no tree-sitter grammar — polyglot files are read
// as data, CLAUDE.md) and materialises each `rpc` as a `GrpcMethodNode`, owned by
// the service the proto lives in through a `service ──CONTAINS──▶ method` edge.
//
// This is the static half of two-sided gRPC observation: the node is keyed on the
// fully-qualified `<package>.<Service>` name — the exact `rpc.service` an OBSERVED
// execution span carries — so a declared method and its observed counterpart fuse
// onto one node into a method-grain divergence (docs/contracts/otel-ingest.md
// §gRPC methods). Scope is the service/method definitions only; message/field
// grain, `import` resolution across proto files, and error-detail enrichment are
// out of scope for this slice.

const PROTO_EXTENSION = '.proto'

// A `.proto` service/method definition parsed out of one file.
export interface ExtractedGrpcMethod {
  rpcService: string // fully-qualified `<package>.<Service>` (or bare `<Service>` when the file declares no package)
  rpcMethod: string // bare method name, e.g. `GetOrder`
  line: number // 1-indexed line the `rpc` is declared on
}

// ── `.proto` parsing (data, not a grammar) ──────────────────────────────────

// The file-level `package foo.bar;` declaration, if present. gRPC fully-qualifies
// `rpc.service` as `<package>.<Service>`, so the package prefixes every service
// name in the file. proto2/proto3 both use this single-line form.
function packageOf(content: string): string | null {
  const m = content.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m)
  return m ? m[1]! : null
}

// The 1-indexed line an absolute character offset falls on.
function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length
}

// Scan a `.proto` file's `service X { rpc M(Req) returns (Res); }` blocks and
// emit one method per `rpc`. Brace-balanced so a service body is read to its
// close; the `rpc` scan is confined to that body. Streaming qualifiers
// (`rpc M(stream Req) returns (stream Res)`) don't change the method identity, so
// they're accepted and ignored. Comment-only or option lines that merely mention
// `rpc`/`service` don't match — both anchors require the keyword followed by an
// identifier and the structural token (`{` for a service, `(` for an rpc).
export function grpcMethodsFromProto(content: string, fqPackage: string | null): ExtractedGrpcMethod[] {
  const out: ExtractedGrpcMethod[] = []
  const serviceRe = /\bservice\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g
  let sm: RegExpExecArray | null
  while ((sm = serviceRe.exec(content)) !== null) {
    const serviceName = sm[1]!
    const rpcService = fqPackage ? `${fqPackage}.${serviceName}` : serviceName
    // Walk from the opening brace to its matching close, tracking depth so a
    // nested block (an inline `option`/message) doesn't end the service early.
    const bodyStart = serviceRe.lastIndex // index just past the `{`
    let depth = 1
    let i = bodyStart
    for (; i < content.length && depth > 0; i++) {
      const ch = content[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    const body = content.slice(bodyStart, i - 1)
    const rpcRe = /\brpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    let rm: RegExpExecArray | null
    while ((rm = rpcRe.exec(body)) !== null) {
      const rpcMethod = rm[1]!
      const line = lineAt(content, bodyStart + rm.index)
      out.push({ rpcService, rpcMethod, line })
    }
    // Continue the outer scan past this service body.
    serviceRe.lastIndex = i
  }
  return out
}

// ── file discovery ──────────────────────────────────────────────────────────

// Walk a service directory for `.proto` files, honouring the shared ignore set
// (node_modules, .git, …) and Python venvs the same way walkSourceFiles does.
// `.proto` isn't a SERVICE_FILE_EXTENSION, so the source-file walker skips it —
// this is a dedicated pass over the proto contract surface.
async function walkProtoFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        if (await isPythonVenvDir(full)) continue
        await walk(full)
      } else if (entry.isFile() && path.extname(entry.name) === PROTO_EXTENSION) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

// ── producer ─────────────────────────────────────────────────────────────────

export async function addGrpcMethods(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const protoPaths = await walkProtoFiles(service.dir)
    for (const protoPath of protoPaths) {
      // ADR-065 #1 — test-scope exclusion. A `.proto` under a test tree isn't the
      // service's declared contract surface.
      if (isTestPath(protoPath)) continue
      const relFile = toPosix(path.relative(service.dir, protoPath))

      let content: string
      try {
        content = await fs.readFile(protoPath, 'utf8')
      } catch (err) {
        recordExtractionError('proto extraction', protoPath, err)
        continue
      }

      let methods: ExtractedGrpcMethod[]
      try {
        methods = grpcMethodsFromProto(content, packageOf(content))
      } catch (err) {
        recordExtractionError('proto extraction', protoPath, err)
        continue
      }
      if (methods.length === 0) continue

      for (const method of methods) {
        const mid = grpcMethodId(method.rpcService, method.rpcMethod)
        if (!graph.hasNode(mid)) {
          const node: GrpcMethodNode = {
            id: mid,
            type: NodeType.GrpcMethodNode,
            name: `${method.rpcService}/${method.rpcMethod}`,
            rpcService: method.rpcService,
            rpcMethod: method.rpcMethod,
            path: relFile,
            line: method.line,
            discoveredVia: 'static',
          }
          graph.addNode(mid, node)
          nodesAdded++
        }
        // `service ──CONTAINS──▶ method` — the service owns the methods its
        // `.proto` declares, the same structural verb it has over its routes
        // (ADR-119) and files (file-awareness.md §2). Evidence pinned to the
        // `rpc` line. The node id is the wire-canonical FQN, so an OBSERVED
        // execution span lands on this same node — declared and observed fuse.
        const containsId = extractedEdgeId(service.node.id, mid, EdgeType.CONTAINS)
        if (!graph.hasEdge(containsId)) {
          const edge: GraphEdge = {
            id: containsId,
            source: service.node.id,
            target: mid,
            type: EdgeType.CONTAINS,
            provenance: Provenance.EXTRACTED,
            confidence: confidenceForExtracted('structural'),
            evidence: {
              file: relFile,
              line: method.line,
              snippet: snippet(content, method.line),
            },
          }
          graph.addEdgeWithKey(containsId, service.node.id, mid, edge)
          edgesAdded++
        }
      }
    }
  }

  return { nodesAdded, edgesAdded }
}

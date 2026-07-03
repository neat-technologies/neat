// Identity helpers — the single source of truth for node and edge id wire
// format. See ADR-028 (nodes), ADR-029 (edges), and docs/contracts/identity.md
// + docs/contracts/provenance.md.
//
// Producers construct ids via these helpers; consumers parse via the inverses.
// Hand-rolled template literals like `service:${name}` or
// `${type}:OBSERVED:${source}->${target}` are contract violations
// (caught by packages/core/test/audits/contracts.test.ts).

const SERVICE_PREFIX = 'service:'
const DATABASE_PREFIX = 'database:'
const CONFIG_PREFIX = 'config:'
const INFRA_PREFIX = 'infra:'
const FRONTIER_PREFIX = 'frontier:'
const FILE_PREFIX = 'file:'
const ROUTE_PREFIX = 'route:'
const GRAPHQL_OP_PREFIX = 'graphql:'
const GRPC_METHOD_PREFIX = 'grpc:'
const WEBSOCKET_CHANNEL_PREFIX = 'ws:'

// ServiceNode id: `service:<name>` for env-unknown nodes (the default,
// produced by static extraction or by ingest when the span carries no env
// signal) and `service:<name>:<env>` for env-tagged nodes (produced by
// ingest when the span carries `deployment.environment(.name)`).
//
// <name> is the manifest name verbatim (package.json#name for JS/TS,
// pyproject [project].name for Python). Names with slashes (e.g. scoped
// npm packages `@org/foo`) are kept as-is — no transformation. See
// ADR-028 §5 for workspace-collision deferral.
//
// The env discriminator is ADR-074 §2. `env === 'unknown'` is the honest
// "no signal" sentinel; emitting it as the env-less wire format keeps
// pre-v0.3.9 snapshots byte-stable on disk.
const ENV_UNKNOWN = 'unknown'

export function serviceId(name: string, env?: string): string {
  if (env === undefined || env === ENV_UNKNOWN) return `${SERVICE_PREFIX}${name}`
  return `${SERVICE_PREFIX}${name}:${env}`
}

// Parse a service id into its (name, env) tuple. Returns null when the
// input is not a service id. env is `'unknown'` when the id carries no
// env segment (the env-less wire format).
export function parseServiceId(id: string): { name: string; env: string } | null {
  if (!id.startsWith(SERVICE_PREFIX)) return null
  const rest = id.slice(SERVICE_PREFIX.length)
  if (rest.length === 0) return null
  const colon = rest.indexOf(':')
  if (colon === -1) return { name: rest, env: ENV_UNKNOWN }
  return { name: rest.slice(0, colon), env: rest.slice(colon + 1) }
}

// DatabaseNode id: `database:<host>`. Port is intentionally excluded; two DBs
// on the same host different ports collide. See ADR-028 §6 for deferral.
export function databaseId(host: string): string {
  return `${DATABASE_PREFIX}${host}`
}

export function parseDatabaseId(id: string): string | null {
  return id.startsWith(DATABASE_PREFIX) ? id.slice(DATABASE_PREFIX.length) : null
}

// In-process / embedded DatabaseNode id: `database:<service>/<name>`. An
// embedded database (SQLite, better-sqlite3, an in-memory store) crosses no
// network boundary, so a span for it carries no peer host to key `databaseId`
// on. Two services each reading their own `app.db` would then collapse onto one
// node; scoping the id by the observing service keeps them distinct. `name` is
// the logical database (`db.name`) when the span carries one, the engine string
// otherwise. Env-unscoped like `databaseId` (env-dimension.md). See ADR-118.
export function localDatabaseId(service: string, name: string): string {
  return `${DATABASE_PREFIX}${service}/${name}`
}

// ConfigNode id: `config:<relPath>` where <relPath> is the path relative to
// the scan root, with forward slashes regardless of platform. ConfigNodes
// record file existence only (ADR-016).
export function configId(relPath: string): string {
  return `${CONFIG_PREFIX}${relPath}`
}

export function parseConfigId(id: string): string | null {
  return id.startsWith(CONFIG_PREFIX) ? id.slice(CONFIG_PREFIX.length) : null
}

// InfraNode id: `infra:<kind>:<name>`. <kind> is a free string sub-type
// (kafka-topic, redis, grpc-service, lambda, queue, etc.) per ADR-022.
export function infraId(kind: string, name: string): string {
  return `${INFRA_PREFIX}${kind}:${name}`
}

export function parseInfraId(id: string): { kind: string; name: string } | null {
  if (!id.startsWith(INFRA_PREFIX)) return null
  const rest = id.slice(INFRA_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon === -1) return null
  return { kind: rest.slice(0, colon), name: rest.slice(colon + 1) }
}

// FrontierNode id: `frontier:<host>` where <host> is host:port from the OTel
// peer attribute. Promoted to a typed node id (typically serviceId(...)) once
// an alias resolves; the FrontierNode is removed and edges are rewritten.
export function frontierId(host: string): string {
  return `${FRONTIER_PREFIX}${host}`
}

export function parseFrontierId(id: string): string | null {
  return id.startsWith(FRONTIER_PREFIX) ? id.slice(FRONTIER_PREFIX.length) : null
}

// FileNode id: `file:<service>:<relPath>` (ADR-089 / file-awareness.md §1).
// The `service` segment is the owning service's manifest name — the same token
// `serviceId(name)` carries — so a shared relative path across monorepo
// packages stays distinct. `relPath` is the service-relative path with forward
// slashes. Files belong to a package, not an environment, so the id is
// env-unscoped (unlike ServiceNode): EXTRACTED (env-less) and OBSERVED
// (env-tagged source service) edges land on the same FileNode, which is what
// makes the file-grained divergence comparison possible (file-awareness.md §7).
export function fileId(service: string, relPath: string): string {
  return `${FILE_PREFIX}${service}:${relPath}`
}

// Parse a file id into its (service, relPath) tuple. Returns null when the
// input isn't a file id. Splits on the first colon after the prefix: service
// names never contain a colon (scoped npm names use `/`), and relPath is
// normalised to forward slashes with any drive letter stripped before the id
// is built, so the first colon is unambiguously the service/path boundary.
export function parseFileId(id: string): { service: string; relPath: string } | null {
  if (!id.startsWith(FILE_PREFIX)) return null
  const rest = id.slice(FILE_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon === -1) return null
  const service = rest.slice(0, colon)
  const relPath = rest.slice(colon + 1)
  if (service.length === 0 || relPath.length === 0) return null
  return { service, relPath }
}

// RouteNode id: `route:<service>:<METHOD> <pathTemplate>` (ADR-119). The
// `service` segment is the owning (server) service's manifest name, matching
// the FileNode / ServiceNode convention so a shared path across monorepo
// packages stays distinct. `method` is upper-cased (`GET`, `POST`, or `ALL`
// for a method-agnostic route); `pathTemplate` is the route's declared template
// verbatim (`/users/:id`), lightly canonicalised (leading slash, no trailing
// slash). The space between method and template is unambiguous — a method token
// never contains a space and a service name never contains a colon. Routes are
// a server-side artifact of a package, not an environment, so the id is
// env-unscoped like FileNode: an EXTRACTED route and a future OBSERVED server
// span land on the same node, which is what makes a two-sided divergence
// possible at route grain.
export function routeId(service: string, method: string, pathTemplate: string): string {
  return `${ROUTE_PREFIX}${service}:${method.toUpperCase()} ${pathTemplate}`
}

// Parse a route id into its (service, method, pathTemplate) tuple. Returns null
// when the input isn't a route id. Splits service on the first colon after the
// prefix (service names carry no colon), then method on the first space.
export function parseRouteId(
  id: string,
): { service: string; method: string; pathTemplate: string } | null {
  if (!id.startsWith(ROUTE_PREFIX)) return null
  const rest = id.slice(ROUTE_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon === -1) return null
  const service = rest.slice(0, colon)
  const tail = rest.slice(colon + 1)
  const space = tail.indexOf(' ')
  if (space === -1) return null
  const method = tail.slice(0, space)
  const pathTemplate = tail.slice(space + 1)
  if (service.length === 0 || method.length === 0 || pathTemplate.length === 0) return null
  return { service, method, pathTemplate }
}

// GraphQLOperationNode id: `graphql:<service>:<type> <operationName>` (ADR-122).
// The `service` segment is the serving service's manifest name, matching the
// FileNode / RouteNode convention so a shared operation name across monorepo
// packages stays distinct. `type` is lower-cased (`query` / `mutation` /
// `subscription`); `operationName` is the client-supplied operation name
// verbatim. The space between type and name is unambiguous — a GraphQL operation
// type never contains a space and a service name never contains a colon. A
// GraphQL operation is a server-side artifact of a package, not an environment,
// so the id is env-unscoped like FileNode / RouteNode: an OBSERVED execution
// span and a future EXTRACTED schema/resolver land on the same node, which is
// what makes an operation-grained two-sided divergence possible.
export function graphqlOperationId(
  service: string,
  operationType: string,
  operationName: string,
): string {
  return `${GRAPHQL_OP_PREFIX}${service}:${operationType.toLowerCase()} ${operationName}`
}

// Parse a GraphQL operation id into its (service, operationType, operationName)
// tuple. Returns null when the input isn't a GraphQL operation id. Splits
// service on the first colon after the prefix (service names carry no colon),
// then type on the first space.
export function parseGraphqlOperationId(
  id: string,
): { service: string; operationType: string; operationName: string } | null {
  if (!id.startsWith(GRAPHQL_OP_PREFIX)) return null
  const rest = id.slice(GRAPHQL_OP_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon === -1) return null
  const service = rest.slice(0, colon)
  const tail = rest.slice(colon + 1)
  const space = tail.indexOf(' ')
  if (space === -1) return null
  const operationType = tail.slice(0, space)
  const operationName = tail.slice(space + 1)
  if (service.length === 0 || operationType.length === 0 || operationName.length === 0) {
    return null
  }
  return { service, operationType, operationName }
}

// GrpcMethodNode id: `grpc:<rpcService>/<rpcMethod>` (ADR-123). Unlike the
// RouteNode / GraphQLOperationNode ids, this one is NOT scoped to the NEAT
// manifest service name — it keys on the fully-qualified gRPC `rpc.service`
// (`orders.OrderService`, the proto's `<package>.<Service>`) instead. That FQN is
// the wire contract: an OTel span and a `.proto` definition both carry it
// verbatim, and it is globally unique across a gRPC mesh (the package qualifier
// disambiguates), so keying on it — rather than on whoever happens to serve or
// call the method — is exactly what fuses the OBSERVED span and the EXTRACTED
// `.proto` onto one node. The implementing service's ownership is a separate
// `CONTAINS` edge, not part of identity. `/` separates service from method
// unambiguously: an `rpc.service` FQN carries dots but never a slash, and a
// method name is a bare identifier.
export function grpcMethodId(rpcService: string, rpcMethod: string): string {
  return `${GRPC_METHOD_PREFIX}${rpcService}/${rpcMethod}`
}

// Parse a gRPC method id into its (rpcService, rpcMethod) tuple. Returns null
// when the input isn't a gRPC method id. Splits on the first slash after the
// prefix — the service FQN carries no slash, the method is a bare identifier.
export function parseGrpcMethodId(
  id: string,
): { rpcService: string; rpcMethod: string } | null {
  if (!id.startsWith(GRPC_METHOD_PREFIX)) return null
  const rest = id.slice(GRPC_METHOD_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash === -1) return null
  const rpcService = rest.slice(0, slash)
  const rpcMethod = rest.slice(slash + 1)
  if (rpcService.length === 0 || rpcMethod.length === 0) return null
  return { rpcService, rpcMethod }
}

// WebSocketChannelNode id: `ws:<service>:<channel>` (ADR-125). The `service`
// segment is the serving service's manifest name, matching the FileNode /
// RouteNode / GraphQLOperationNode convention. Unlike the gRPC id — which keys on
// the globally-unique fully-qualified `rpc.service` — a WebSocket channel path
// (`/chat`, `/socket.io`) carries no package qualifier and is not unique across a
// mesh, so it is scoped to the serving service exactly as a route path is. The
// channel is a server-side artifact of a package, not an environment, so the id
// is env-unscoped like FileNode / RouteNode. The `channel` follows the first
// colon after the prefix; a service name carries no colon, so a channel path that
// itself contains a colon stays intact on the channel side.
export function websocketChannelId(service: string, channel: string): string {
  return `${WEBSOCKET_CHANNEL_PREFIX}${service}:${channel}`
}

// Parse a WebSocket channel id into its (service, channel) tuple. Returns null
// when the input isn't a WebSocket channel id. Splits on the first colon after
// the prefix — the service name carries no colon, the channel is the remainder.
export function parseWebsocketChannelId(
  id: string,
): { service: string; channel: string } | null {
  if (!id.startsWith(WEBSOCKET_CHANNEL_PREFIX)) return null
  const rest = id.slice(WEBSOCKET_CHANNEL_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon === -1) return null
  const service = rest.slice(0, colon)
  const channel = rest.slice(colon + 1)
  if (service.length === 0 || channel.length === 0) return null
  return { service, channel }
}

// ──────────────────────────────────────────────────────────────────────────
// Edge ids (ADR-029, ADR-068)
// ──────────────────────────────────────────────────────────────────────────
//
// Edge id wire format per provenance:
//   EXTRACTED: `${type}:${source}->${target}`
//   OBSERVED:  `${type}:OBSERVED:${source}->${target}`
//   INFERRED:  `${type}:INFERRED:${source}->${target}`
//   STALE never appears in an edge id; STALE is a transition of an existing
//   OBSERVED edge (ADR-024), not a creation pattern.
//
// Per ADR-068, edges to FrontierNodes carry whatever provenance describes
// how the edge was learned — span-derived edges use observedEdgeId with the
// FrontierNode id as the target string. Node-type is orthogonal to
// provenance; the wire format reflects provenance only.
//
// Multiple edges between the same node pair coexist under distinct provenance
// ids — that's what makes the EXTRACTED+OBSERVED coexistence rule
// (contracts.md Rule 2) mechanically possible.

const EDGE_ARROW = '->'

export function extractedEdgeId(source: string, target: string, type: string): string {
  return `${type}:${source}${EDGE_ARROW}${target}`
}

export function observedEdgeId(source: string, target: string, type: string): string {
  return `${type}:OBSERVED:${source}${EDGE_ARROW}${target}`
}

export function inferredEdgeId(source: string, target: string, type: string): string {
  return `${type}:INFERRED:${source}${EDGE_ARROW}${target}`
}

// Parse an edge id into its parts. Returns null if the input is not a
// well-formed edge id — covers all three creation variants (STALE rides on
// the OBSERVED id format). Useful for consumers (traversal, MCP, persist)
// that need to walk back from an id.
//
// Note: EXTRACTED ids have no provenance segment, so we detect them by
// checking whether the second segment matches a known provenance marker.
export function parseEdgeId(id: string): {
  type: string
  provenance: 'EXTRACTED' | 'OBSERVED' | 'INFERRED'
  source: string
  target: string
} | null {
  const arrowIdx = id.lastIndexOf(EDGE_ARROW)
  if (arrowIdx === -1) return null
  const left = id.slice(0, arrowIdx)
  const target = id.slice(arrowIdx + EDGE_ARROW.length)
  if (!left || !target) return null

  // left is one of:
  //   `${type}:${source}`             → EXTRACTED
  //   `${type}:OBSERVED:${source}`    → OBSERVED
  //   `${type}:INFERRED:${source}`    → INFERRED
  const firstColon = left.indexOf(':')
  if (firstColon === -1) return null
  const type = left.slice(0, firstColon)
  const rest = left.slice(firstColon + 1)

  for (const prov of ['OBSERVED', 'INFERRED'] as const) {
    if (rest.startsWith(`${prov}:`)) {
      return { type, provenance: prov, source: rest.slice(prov.length + 1), target }
    }
  }
  return { type, provenance: 'EXTRACTED', source: rest, target }
}

// ──────────────────────────────────────────────────────────────────────────
// Provenance ranking (ADR-029, ADR-068)
// ──────────────────────────────────────────────────────────────────────────
//
// Canonical priority used by traversal and any consumer that needs to pick
// a single edge between two nodes when multiple provenance variants exist.
// Higher number = higher trust = preferred.
//
// Four entries match the four-value Provenance enum (ADR-068). Node-type
// gating (e.g. "stop at FrontierNodes" per contracts.md Rule 3) is enforced
// at the node level by traversal, independent of edge rank.
export const PROV_RANK: Readonly<Record<'OBSERVED' | 'INFERRED' | 'EXTRACTED' | 'STALE', number>> = Object.freeze({
  OBSERVED: 3,
  INFERRED: 2,
  EXTRACTED: 1,
  STALE: 0,
})

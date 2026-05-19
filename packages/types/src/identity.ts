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

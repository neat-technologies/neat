import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import cors from '@fastify/cors'
import type {
  ErrorEvent,
  GraphEdge,
  GraphNode,
  Policy,
  PolicyViolation,
  RegistryEntry,
} from '@neat.is/types'
import { DivergenceTypeSchema, PoliciesCheckBodySchema, PolicySeveritySchema } from '@neat.is/types'
import type { DivergenceType } from '@neat.is/types'
import {
  applyExtension,
  describeProjectInstrumentation,
  dryRunExtension,
  listUninstrumented,
  lookupInstrumentation,
  rollbackExtension,
} from './extend/index.js'
import { computeDivergences } from './divergences.js'
import {
  evaluateAllPolicies,
  loadPolicyFile,
  PolicyViolationsLog,
  selectApplicablePolicies,
} from './policy.js'
import type { NeatGraph } from './graph.js'
import { DEFAULT_PROJECT } from './graph.js'
import { extractFromDirectory } from './extract.js'
import { readErrorEvents, readStaleEvents } from './ingest.js'
import {
  getBlastRadius,
  getObservedDependencies,
  getRootCause,
  getTransitiveDependencies,
  TRANSITIVE_DEPENDENCIES_DEFAULT_DEPTH,
  TRANSITIVE_DEPENDENCIES_MAX_DEPTH,
} from './traverse.js'
import { computeGraphDiff, loadSnapshotForDiff } from './diff.js'
import { mergeSnapshot, SnapshotValidationError } from './ingest.js'
import { SCHEMA_VERSION, type PersistedGraph } from './persist.js'
import type { SearchIndex } from './search.js'
import type { Projects, ProjectContext } from './projects.js'
import { Projects as ProjectsClass, pathsForProject } from './projects.js'
import { getProject as getRegistryProject, listProjects as listRegistryProjects } from './registry.js'
import { handleSse } from './streaming.js'
import { mountBearerAuth, readAuthEnv } from './auth.js'

export interface BuildApiOptions {
  // Multi-project shape. Optional — when absent we synthesise a single-
  // project registry from the legacy fields below so existing callers
  // (mainly tests) keep working unchanged.
  projects?: Projects
  startedAt?: number

  // Legacy single-project shape. Mapped to project=`default` if `projects`
  // isn't provided.
  graph?: NeatGraph
  scanPath?: string
  errorsPath?: string
  staleEventsPath?: string
  searchIndex?: SearchIndex

  // ADR-073 §3 — bearer token required on `/api/*` and `/events`. Undefined
  // leaves the middleware off (loopback-only callers; the bind-authority
  // gate in startDaemon refuses to bind publicly without one).
  authToken?: string
  // ADR-073 §3 — when the operator runs behind a reverse proxy that already
  // authenticates the request, the daemon-side check is bypassed.
  trustProxy?: boolean
  // ADR-073 §3 amendment — public-read mode. When `true`, GET / HEAD / OPTIONS
  // bypass the bearer check; writes still require it. OTLP ingest is gated
  // independently and is unaffected by this flag.
  publicRead?: boolean
  // Issue #340 — per-project bootstrap status. When provided, project-scoped
  // routes for projects still extracting return 503 with `{ready: false}`
  // instead of 404.
  bootstrap?: {
    status: (name: string) => 'bootstrapping' | 'active' | 'broken' | undefined
    list: () => Array<{ name: string; status: 'bootstrapping' | 'active' | 'broken'; elapsedMs: number }>
  }
  // ADR-096 §4/§5 — the per-project daemon's identity. When set, this daemon
  // serves exactly this one project: `GET /projects` reports only it (the
  // dashboard pins to "the project this daemon serves," not a machine-wide
  // list), and the daemon-wide `/health` carries it at the top level for the
  // spawn-reuse identity check. Absent → the legacy multi-project daemon, whose
  // `/projects` is the machine-wide registry passthrough.
  singleProject?: { name: string; path: string }
}

interface SerializedGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

function serializeGraph(graph: NeatGraph): SerializedGraph {
  const nodes: GraphNode[] = []
  graph.forEachNode((_id, attrs) => {
    nodes.push(attrs)
  })
  const edges: GraphEdge[] = []
  graph.forEachEdge((_id, attrs) => {
    edges.push(attrs)
  })
  return { nodes, edges }
}

function projectFromReq(req: FastifyRequest, singleProject?: string): string {
  // `:project` is optional in the URL — the request hits either
  // /projects/:project/X or the unprefixed /X.
  const params = req.params as { project?: string }
  const named = params.project
  // ADR-096 §4 — "the daemon is the project." On a per-project daemon a bare
  // /X needs no project name to disambiguate: it means this daemon's one
  // project. The legacy `default` alias maps to it too, so an agent wired with
  // only NEAT_CORE_URL (no project arg, no NEAT_DEFAULT_PROJECT) reaches the
  // real project without naming it. An explicit real name still routes as
  // given. A non-single-project daemon keeps coercing a missing param to the
  // `default` project.
  if (singleProject) {
    return named === undefined || named === DEFAULT_PROJECT ? singleProject : named
  }
  return named ?? DEFAULT_PROJECT
}

function resolveProject(
  registry: Projects,
  req: FastifyRequest,
  reply: FastifyReply,
  bootstrap?: BuildApiOptions['bootstrap'],
  singleProject?: string,
): ProjectContext | null {
  const name = projectFromReq(req, singleProject)
  const ctx = registry.get(name)
  if (!ctx) {
    // Issue #340 — registered but still bootstrapping: surface 503 so the
    // probe consumer knows the project is real and incoming, not missing.
    const phase = bootstrap?.status(name)
    if (phase === 'bootstrapping') {
      void reply.code(503).send({ ready: false, project: name, status: 'bootstrapping' })
      return null
    }
    if (phase === 'broken') {
      void reply.code(503).send({ ready: false, project: name, status: 'broken' })
      return null
    }
    void reply.code(404).send({ error: 'project not found', project: name })
    return null
  }
  return ctx
}

function buildLegacyRegistry(opts: BuildApiOptions): Projects {
  if (opts.projects) return opts.projects
  if (!opts.graph) {
    throw new Error('buildApi: either `projects` or `graph` must be provided')
  }
  const registry = new ProjectsClass()
  // pathsForProject only matters here for the snapshot/embeddings paths
  // routes never read; the ingest paths come from explicit options below.
  const paths = pathsForProject(DEFAULT_PROJECT, '')
  registry.set(DEFAULT_PROJECT, {
    graph: opts.graph,
    scanPath: opts.scanPath,
    paths: {
      snapshotPath: paths.snapshotPath,
      errorsPath: opts.errorsPath ?? paths.errorsPath,
      staleEventsPath: opts.staleEventsPath ?? paths.staleEventsPath,
      embeddingsCachePath: paths.embeddingsCachePath,
      policyViolationsPath: paths.policyViolationsPath,
    },
    searchIndex: opts.searchIndex,
  })
  return registry
}

interface RouteContext {
  registry: Projects
  startedAt: number
  // Where the routes are getting mounted. `'root'` is the legacy unprefixed
  // mount that historically resolved every request to the `default` project;
  // `'project'` is the `/projects/:project` plugin scope where the project
  // segment is always present. The /health handler branches on this so the
  // root mount can answer daemon-wide while the scoped mount stays
  // per-project (issue #343).
  scope: 'root' | 'project'
  // Legacy callers passed `errorsPath`/`staleEventsPath` explicitly and
  // expected absent values to disable the read. Track that intent so the
  // /incidents handlers don't accidentally read a phantom file.
  errorsPathFor: (ctx: ProjectContext) => string | undefined
  staleEventsPathFor: (ctx: ProjectContext) => string | undefined
  // policy.json lives at the project root (per ADR-042 §File location), not
  // under neat-out/. Routes that read it map a project context to the path.
  policyFilePathFor: (ctx: ProjectContext) => string | undefined
  // Issue #340 — flips per-project routes from 404 to 503 while a slot is
  // still extracting.
  bootstrap?: BuildApiOptions['bootstrap']
  // ADR-096 §4 — the per-project daemon's one project. When set, unprefixed
  // (and `default`-named) requests resolve to it instead of the `default`
  // project. Absent for the legacy multi-project daemon.
  singleProject?: string
}

// Registers every project-scoped route on `scope`. Called twice from
// buildApi: once on the root app (so /graph etc. land at default), once
// inside a `register(_, { prefix: '/projects/:project' })` plugin so the
// same handlers run when the URL names a project explicitly.
function registerRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { registry, startedAt, errorsPathFor, staleEventsPathFor } = ctx

  // SSE event stream (ADR-051 #1). Dual-mounted: hits /events for default
  // project and /projects/:project/events when scoped. The handler keeps
  // the connection open and writes one frame per bus envelope whose
  // `project` matches.
  scope.get<{ Params: { project?: string } }>('/events', (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    handleSse(req, reply, { project: proj.name })
  })

  // Per-project /health stays scoped. The unscoped `/health` at the root
  // mount is handled by the daemon-wide handler below (issue #343) —
  // daemon-wide readiness mustn't pivot on whether the `default` project
  // exists. The scoped variant carries the bootstrap-aware shape from
  // issue #340.
  if (ctx.scope === 'project') {
    scope.get<{ Params: { project?: string } }>('/health', async (req, reply) => {
      const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
      if (!proj) return
      const uptimeMs = Date.now() - startedAt
      return {
        ok: true,
        project: proj.name,
        uptimeMs,
        // Legacy fields kept additively. The web shell's StatusBar reads
        // nodeCount / edgeCount; ADR-061's HealthResponseSchema validates
        // the canonical triple and lets the extras pass through.
        uptime: Math.floor(uptimeMs / 1000),
        nodeCount: proj.graph.order,
        edgeCount: proj.graph.size,
        lastUpdated: new Date().toISOString(),
      }
    })
  }

  scope.get<{ Params: { project?: string } }>('/graph', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    return serializeGraph(proj.graph)
  })

  scope.get<{ Params: { project?: string; id: string } }>(
    '/graph/node/:id',
    async (req, reply) => {
      const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
      if (!proj) return
      const { id } = req.params
      if (!proj.graph.hasNode(id)) {
        return reply.code(404).send({ error: 'node not found', id })
      }
      return { node: proj.graph.getNodeAttributes(id) as GraphNode }
    },
  )

  scope.get<{ Params: { project?: string; id: string } }>(
    '/graph/edges/:id',
    async (req, reply) => {
      const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
      if (!proj) return
      const { id } = req.params
      if (!proj.graph.hasNode(id)) {
        return reply.code(404).send({ error: 'node not found', id })
      }
      const inbound = proj.graph
        .inboundEdges(id)
        .map((e) => proj.graph.getEdgeAttributes(e) as GraphEdge)
      const outbound = proj.graph
        .outboundEdges(id)
        .map((e) => proj.graph.getEdgeAttributes(e) as GraphEdge)
      return { inbound, outbound }
    },
  )

  // Transitive dependencies (issue #144). BFS outbound to depth N, returning
  // a flat list with distance + edgeType + provenance per dependency.
  // Default depth 3, max 10. The MCP get_dependencies tool calls this.
  scope.get<{
    Params: { project?: string; nodeId: string }
    Querystring: { depth?: string }
  }>('/graph/dependencies/:nodeId', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const { nodeId } = req.params
    if (!proj.graph.hasNode(nodeId)) {
      return reply.code(404).send({ error: 'node not found', id: nodeId })
    }
    const depth = req.query.depth ? Number(req.query.depth) : TRANSITIVE_DEPENDENCIES_DEFAULT_DEPTH
    if (!Number.isFinite(depth) || depth < 1 || depth > TRANSITIVE_DEPENDENCIES_MAX_DEPTH) {
      return reply.code(400).send({
        error: `depth must be an integer in [1, ${TRANSITIVE_DEPENDENCIES_MAX_DEPTH}]`,
      })
    }
    return getTransitiveDependencies(proj.graph, nodeId, depth)
  })

  // Observed-only dependencies (issue #578). The runtime CALLS a node makes,
  // file-grained — and, for a ServiceNode, the OBSERVED edges of the files it
  // owns, since the call-site processor lands them on files, not the service
  // root. REST parity for the MCP get_observed_dependencies tool (issue #593);
  // the CLI observed-dependencies verb reads it too.
  scope.get<{ Params: { project?: string; nodeId: string } }>(
    '/graph/observed-dependencies/:nodeId',
    async (req, reply) => {
      const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
      if (!proj) return
      const { nodeId } = req.params
      if (!proj.graph.hasNode(nodeId)) {
        return reply.code(404).send({ error: 'node not found', id: nodeId })
      }
      return getObservedDependencies(proj.graph, nodeId)
    },
  )

  // Divergence query — the thesis surface (ADR-060). Read-only, derived,
  // dual-mounted via registerRoutes. Query params filter the result set;
  // body shape is DivergenceResult.
  scope.get<{
    Params: { project?: string }
    Querystring: { type?: string; minConfidence?: string; node?: string }
  }>('/graph/divergences', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    let typeFilter: Set<DivergenceType> | undefined
    if (req.query.type) {
      const candidates = req.query.type
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      const parsed: DivergenceType[] = []
      for (const c of candidates) {
        const r = DivergenceTypeSchema.safeParse(c)
        if (!r.success) {
          return reply.code(400).send({
            error: `unknown divergence type "${c}"`,
            allowed: DivergenceTypeSchema.options,
          })
        }
        parsed.push(r.data)
      }
      typeFilter = new Set(parsed)
    }
    let minConfidence: number | undefined
    if (req.query.minConfidence !== undefined) {
      const n = Number(req.query.minConfidence)
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return reply.code(400).send({
          error: 'minConfidence must be a number in [0, 1]',
        })
      }
      minConfidence = n
    }
    return computeDivergences(proj.graph, {
      ...(typeFilter ? { type: typeFilter } : {}),
      ...(minConfidence !== undefined ? { minConfidence } : {}),
      ...(req.query.node ? { node: req.query.node } : {}),
    })
  })

  // ADR-061 envelope rule: list endpoints return { count, total, events }.
  // `total` is the size of the underlying collection; `count` is the size of
  // the slice we're handing back. The web shell counts on both.
  scope.get<{
    Params: { project?: string }
    Querystring: { limit?: string }
  }>('/incidents', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const epath = errorsPathFor(proj)
    if (!epath) return { count: 0, total: 0, events: [] }
    const events = await readErrorEvents(epath)
    const total = events.length
    const limit = req.query.limit ? Number(req.query.limit) : 50
    const safeLimit =
      Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50
    const sliced = events.slice(0, safeLimit)
    return { count: sliced.length, total, events: sliced }
  })

  scope.get<{
    Params: { project?: string }
    Querystring: { limit?: string; edgeType?: string }
  }>('/stale-events', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const spath = staleEventsPathFor(proj)
    if (!spath) return { count: 0, total: 0, events: [] }
    const events = await readStaleEvents(spath)
    const filtered = req.query.edgeType
      ? events.filter((e) => e.edgeType === req.query.edgeType)
      : events
    const ordered = [...filtered].reverse()
    const total = ordered.length
    const limit = req.query.limit ? Number(req.query.limit) : 50
    const sliced = ordered.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50)
    return { count: sliced.length, total, events: sliced }
  })

  // One handler, two paths: `/incidents/:nodeId` is the original REST name and
  // `/graph/incident-history/:nodeId` mirrors the MCP get_incident_history tool
  // so the two surfaces answer under matching names (issue #593).
  const incidentHistoryHandler = async (
    req: FastifyRequest<{ Params: { project?: string; nodeId: string } }>,
    reply: FastifyReply,
  ): Promise<{ count: number; total: number; events: ErrorEvent[] } | undefined> => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const { nodeId } = req.params
    if (!proj.graph.hasNode(nodeId)) {
      reply.code(404).send({ error: 'node not found', id: nodeId })
      return
    }
    const epath = errorsPathFor(proj)
    if (!epath) return { count: 0, total: 0, events: [] }
    const events = await readErrorEvents(epath)
    const filtered = events.filter(
      (e) =>
        e.affectedNode === nodeId || e.service === nodeId.replace(/^service:/, ''),
    )
    return { count: filtered.length, total: filtered.length, events: filtered }
  }
  scope.get<{ Params: { project?: string; nodeId: string } }>(
    '/incidents/:nodeId',
    incidentHistoryHandler,
  )
  scope.get<{ Params: { project?: string; nodeId: string } }>(
    '/graph/incident-history/:nodeId',
    incidentHistoryHandler,
  )

  scope.get<{
    Params: { project?: string; nodeId: string }
    Querystring: { errorId?: string }
  }>('/graph/root-cause/:nodeId', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const { nodeId } = req.params
    if (!proj.graph.hasNode(nodeId)) {
      return reply.code(404).send({ error: 'node not found', id: nodeId })
    }
    // Load the incident store so root-cause can localize an in-process failure
    // that never crossed a graph edge (#584). When errorId is supplied the
    // named incident colours the reason; the full set is the fallback the graph
    // walk consults when no edge carried an incompatibility.
    const epath = errorsPathFor(proj)
    const incidents = epath ? await readErrorEvents(epath) : []
    let errorEvent: ErrorEvent | undefined
    if (req.query.errorId) {
      errorEvent = incidents.find((e) => e.id === req.query.errorId)
      if (!errorEvent) {
        return reply
          .code(404)
          .send({ error: 'error event not found', id: req.query.errorId })
      }
    }
    const result = getRootCause(proj.graph, nodeId, errorEvent, incidents)
    if (!result) return reply.code(404).send({ error: 'no root cause found', id: nodeId })
    return result
  })

  scope.get<{
    Params: { project?: string; nodeId: string }
    Querystring: { depth?: string }
  }>('/graph/blast-radius/:nodeId', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const { nodeId } = req.params
    if (!proj.graph.hasNode(nodeId)) {
      return reply.code(404).send({ error: 'node not found', id: nodeId })
    }
    const depth = req.query.depth ? Number(req.query.depth) : undefined
    if (depth !== undefined && (!Number.isFinite(depth) || depth < 0)) {
      return reply.code(400).send({ error: 'depth must be a non-negative number' })
    }
    return getBlastRadius(proj.graph, nodeId, depth)
  })

  scope.get<{
    Params: { project?: string }
    Querystring: { q?: string; limit?: string }
  }>('/search', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const raw = (req.query.q ?? '').trim()
    if (!raw) return reply.code(400).send({ error: 'query parameter `q` is required' })
    const limit = req.query.limit ? Number(req.query.limit) : undefined
    const safeLimit =
      limit !== undefined && Number.isFinite(limit) && limit > 0 ? limit : undefined
    if (proj.searchIndex) {
      const result = await proj.searchIndex.search(raw, safeLimit)
      return {
        query: result.query,
        provider: result.provider,
        matches: result.matches.map((m) => ({ ...m.node, score: m.score })),
      }
    }
    const q = raw.toLowerCase()
    const matches: (GraphNode & { score: number })[] = []
    proj.graph.forEachNode((id, attrs) => {
      const name = (attrs as { name?: string }).name ?? ''
      if (id.toLowerCase().includes(q) || name.toLowerCase().includes(q)) {
        matches.push({ ...(attrs as GraphNode), score: 1 })
      }
    })
    return {
      query: q,
      provider: 'substring' as const,
      matches: matches.slice(0, safeLimit),
    }
  })

  scope.get<{ Params: { project?: string }; Querystring: { against?: string } }>(
    '/graph/diff',
    async (req, reply) => {
      const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
      if (!proj) return
      const against = req.query.against
      if (!against) {
        return reply.code(400).send({ error: 'query parameter `against` is required' })
      }
      // Security (#693): `against` used to be handed straight to
      // `loadSnapshotForDiff`, which `fetch()`es any `http(s)` URL and
      // otherwise reads whatever filesystem path it's given — a live
      // SSRF/LFI vector once this route is reachable without auth (public-read
      // mode). `against` now only ever resolves to a snapshot the server
      // already manages: `self` (this project's own on-disk snapshot, written
      // by the persist loop / `neat sync`) or the name of another project
      // this same daemon is tracking. Either way the string is looked up in
      // the registry map, never concatenated into a path or handed to
      // `fetch()` — anything that doesn't match a known project is a 400.
      const targetProjectName = against === 'self' ? proj.name : against
      const targetProject = registry.get(targetProjectName)
      if (!targetProject) {
        return reply.code(400).send({
          error:
            'unknown snapshot id — `against` must be `self` or the name of a project this server has a snapshot for',
          against,
        })
      }
      try {
        const snapshot = await loadSnapshotForDiff(targetProject.paths.snapshotPath)
        return computeGraphDiff(proj.graph, snapshot)
      } catch (err) {
        return reply
          .code(400)
          .send({ error: 'failed to load snapshot', against, detail: (err as Error).message })
      }
    },
  )

  // Snapshot push (ADR-074 §1). `neat sync` POSTs a snapshot here; we merge
  // it into the live graph through `mergeSnapshot`, which preserves any
  // accumulated OBSERVED edges per the Rule 2 coexistence contract. Body
  // shape is the same JSON `persist.ts` writes to disk. Dual-mounted at
  // `/snapshot` and `/projects/:project/snapshot` via registerRoutes.
  scope.post<{
    Params: { project?: string }
    Body: { snapshot?: PersistedGraph }
  }>('/snapshot', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const body = req.body
    if (!body || typeof body !== 'object' || !body.snapshot) {
      return reply
        .code(400)
        .send({ error: 'request body must be { snapshot: <persisted-graph> }' })
    }
    const snap = body.snapshot
    if (typeof snap.schemaVersion !== 'number' || snap.schemaVersion !== SCHEMA_VERSION) {
      return reply.code(400).send({
        error: `unsupported snapshot schemaVersion ${snap.schemaVersion} (expected ${SCHEMA_VERSION})`,
      })
    }
    try {
      const result = mergeSnapshot(proj.graph, snap)
      return {
        project: proj.name,
        nodesAdded: result.nodesAdded,
        edgesAdded: result.edgesAdded,
        nodeCount: proj.graph.order,
        edgeCount: proj.graph.size,
      }
    } catch (err) {
      // A malformed node/edge (wrong `type` literal, missing required field,
      // ...) fails GraphNodeSchema/GraphEdgeSchema validation inside
      // mergeSnapshot and rejects the whole snapshot rather than merging the
      // valid entries and silently dropping the rest. `issues` carries one
      // entry per invalid node/edge so the caller can see exactly what was
      // wrong instead of guessing from a single summary string.
      if (err instanceof SnapshotValidationError) {
        return reply.code(400).send({
          error: 'snapshot merge failed',
          details: err.message,
          issues: err.issues,
        })
      }
      return reply.code(400).send({
        error: 'snapshot merge failed',
        details: (err as Error).message,
      })
    }
  })

  scope.post<{ Params: { project?: string } }>('/graph/scan', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    if (!proj.scanPath) {
      return reply
        .code(409)
        .send({ error: 'scan path not configured for this project', project: proj.name })
    }
    const result = await extractFromDirectory(proj.graph, proj.scanPath)
    return {
      project: proj.name,
      scanned: proj.scanPath,
      nodesAdded: result.nodesAdded,
      edgesAdded: result.edgesAdded,
      nodeCount: proj.graph.order,
      edgeCount: proj.graph.size,
    }
  })

  // Policy surface (ADR-045 / contract #18). /policies returns the parsed
  // policy.json; /policies/violations is the persistent log; /policies/check
  // is dry-run evaluation. All dual-mounted via registerRoutes.
  scope.get<{ Params: { project?: string } }>('/policies', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const policyPath = ctx.policyFilePathFor(proj)
    if (!policyPath) {
      // No policy file configured for this project — return the empty file
      // shape so consumers don't have to special-case "no policies yet."
      return { version: 1, policies: [] }
    }
    try {
      const policies = await loadPolicyFile(policyPath)
      return { version: 1, policies }
    } catch (err) {
      return reply.code(400).send({
        error: 'policy.json failed to parse',
        details: (err as Error).message,
      })
    }
  })

  scope.get<{
    Params: { project?: string }
    Querystring: { severity?: string; policyId?: string }
  }>('/policies/violations', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const log = new PolicyViolationsLog(proj.paths.policyViolationsPath)
    let violations = await log.readAll()
    if (req.query.severity) {
      const sev = PolicySeveritySchema.safeParse(req.query.severity)
      if (!sev.success) {
        return reply.code(400).send({
          error: 'invalid severity',
          details: sev.error.format(),
        })
      }
      violations = violations.filter((v) => v.severity === sev.data)
    }
    if (req.query.policyId) {
      violations = violations.filter((v) => v.policyId === req.query.policyId)
    }
    return { violations }
  })

  // Soft guardrail read path (ADR-108 / policies-soft-guardrail.md). Returns
  // the policies APPLICABLE to a node — the rules an agent should be aware of
  // while working there. This INFORMS; it never blocks and carries no verdict.
  // Matching is a direct subject/region match (see selectApplicablePolicies),
  // not the full overlay traversal (ADR-105 §5), which is still unbuilt.
  scope.get<{
    Params: { project?: string }
    Querystring: { node?: string }
  }>('/policies/applicable', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const nodeId = req.query.node
    if (!nodeId) {
      return reply.code(400).send({ error: 'missing required query param "node"' })
    }
    const policyPath = ctx.policyFilePathFor(proj)
    let policies: Policy[] = []
    if (policyPath) {
      try {
        policies = await loadPolicyFile(policyPath)
      } catch (err) {
        return reply.code(400).send({
          error: 'policy.json failed to parse',
          details: (err as Error).message,
        })
      }
    }
    const applicable = selectApplicablePolicies(proj.graph, policies, nodeId)
    return { node: nodeId, applicable }
  })

  scope.post<{
    Params: { project?: string }
    Body: { hypotheticalAction?: unknown }
  }>('/policies/check', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const parsed = PoliciesCheckBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid /policies/check body',
        details: parsed.error.format(),
      })
    }

    const policyPath = ctx.policyFilePathFor(proj)
    let policies: Policy[] = []
    if (policyPath) {
      try {
        policies = await loadPolicyFile(policyPath)
      } catch (err) {
        return reply.code(400).send({
          error: 'policy.json failed to parse',
          details: (err as Error).message,
        })
      }
    }

    // No hypothetical → return current violations against the live graph.
    // With a hypothetical → simulate the action against a deep-copy graph
    // (avoids mutation authority concerns), evaluate, return the delta.
    const evalCtx = { now: () => Date.now() }
    if (!parsed.data.hypotheticalAction) {
      const violations = evaluateAllPolicies(proj.graph, policies, evalCtx)
      const blocking = violations.filter((v) => v.onViolation === 'block')
      return { allowed: blocking.length === 0, violations }
    }

    // For now the dry-run simulation re-uses evaluateAllPolicies on the
    // current graph. Full hypothetical simulation (e.g. "what if I added
    // this OBSERVED edge?") is the v0.2.4-δ scope; #117 ships the surface,
    // #118 fills in the action shapes' simulation logic.
    const violations = evaluateAllPolicies(proj.graph, policies, evalCtx)
    const blocking = violations.filter((v) => v.onViolation === 'block')
    return {
      allowed: blocking.length === 0,
      hypotheticalAction: parsed.data.hypotheticalAction,
      violations,
    } as { allowed: boolean; hypotheticalAction: unknown; violations: PolicyViolation[] }
  })

  // ── /extend — surgical instrumentation tools (ADR-081, ADR-086) ─────────
  // Six routes. Three read-only (list-uninstrumented, lookup, describe),
  // three operative (apply, dry-run, rollback). File-scope restricted per
  // the extend-skill contract: only instrumentation/otel-init files and
  // package.json. Dual-mounted via registerRoutes.

  scope.get<{ Params: { project?: string } }>('/extend/list-uninstrumented', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    if (!proj.scanPath) {
      return reply.code(409).send({ error: 'scan path not configured for this project', project: proj.name })
    }
    try {
      const results = await listUninstrumented({ project: proj.name, scanPath: proj.scanPath })
      return { libraries: results }
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  scope.get<{
    Params: { project?: string }
    Querystring: { library?: string; version?: string }
  }>('/extend/lookup', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    const { library, version } = req.query
    if (!library) {
      return reply.code(400).send({ error: 'query parameter `library` is required' })
    }
    const result = lookupInstrumentation(library, version)
    if (!result) {
      return reply.code(404).send({ error: 'library not found in registry', library })
    }
    return result
  })

  scope.get<{ Params: { project?: string } }>('/extend/describe', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    if (!proj.scanPath) {
      return reply.code(409).send({ error: 'scan path not configured for this project', project: proj.name })
    }
    try {
      const state = await describeProjectInstrumentation({ project: proj.name, scanPath: proj.scanPath })
      return state
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  scope.post<{
    Params: { project?: string }
    Body: { library?: string; instrumentation_package?: string; version?: string; registration_snippet?: string }
  }>('/extend/apply', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    if (!proj.scanPath) {
      return reply.code(409).send({ error: 'scan path not configured for this project', project: proj.name })
    }
    const { library, instrumentation_package, version, registration_snippet } = req.body ?? {}
    if (!library || !instrumentation_package || !version || !registration_snippet) {
      return reply.code(400).send({ error: 'body must include library, instrumentation_package, version, registration_snippet' })
    }
    try {
      const result = await applyExtension(
        { project: proj.name, scanPath: proj.scanPath },
        { library, instrumentation_package, version, registration_snippet },
      )
      return result
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  scope.post<{
    Params: { project?: string }
    Body: { library?: string; instrumentation_package?: string; version?: string; registration_snippet?: string }
  }>('/extend/dry-run', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    if (!proj.scanPath) {
      return reply.code(409).send({ error: 'scan path not configured for this project', project: proj.name })
    }
    const { library, instrumentation_package, version, registration_snippet } = req.body ?? {}
    if (!library || !instrumentation_package || !version || !registration_snippet) {
      return reply.code(400).send({ error: 'body must include library, instrumentation_package, version, registration_snippet' })
    }
    try {
      const result = await dryRunExtension(
        { project: proj.name, scanPath: proj.scanPath },
        { library, instrumentation_package, version, registration_snippet },
      )
      return result
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  scope.post<{
    Params: { project?: string }
    Body: { library?: string }
  }>('/extend/rollback', async (req, reply) => {
    const proj = resolveProject(registry, req, reply, ctx.bootstrap, ctx.singleProject)
    if (!proj) return
    if (!proj.scanPath) {
      return reply.code(409).send({ error: 'scan path not configured for this project', project: proj.name })
    }
    const { library } = req.body ?? {}
    if (!library) {
      return reply.code(400).send({ error: 'body must include library' })
    }
    try {
      const result = await rollbackExtension(
        { project: proj.name, scanPath: proj.scanPath },
        { library },
      )
      return result
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })
}

export async function buildApi(opts: BuildApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cors, { origin: true })

  // ADR-073 §3/§4 — `buildApi` owns auth enforcement so every listener that
  // serves the REST surface gets the same gate, whoever builds it. When a
  // caller doesn't pass auth options explicitly, they resolve from the
  // environment (`NEAT_AUTH_TOKEN` / `NEAT_AUTH_PROXY` / `NEAT_PUBLIC_READ`)
  // through the single `readAuthEnv` reader. A caller that does pass them
  // wins, so the daemon and `serve` keep their explicit wiring; a caller that
  // omits them — `neat watch` — inherits the same token rather than serving
  // open by omission. The bind-host loopback refusal stays with the binding
  // caller via `assertBindAuthority`, which reads the same env.
  const env = readAuthEnv()
  const authToken = opts.authToken ?? env.authToken
  const trustProxy = opts.trustProxy ?? env.trustProxy
  const publicRead = opts.publicRead ?? env.publicRead

  // ADR-073 §3 — bearer middleware sits ahead of every route handler. No-op
  // when the resolved token is undefined; loopback-only callers (the laptop
  // dev path) hit that branch. `publicRead` opens GET / HEAD / OPTIONS to
  // anonymous callers while keeping writes gated.
  mountBearerAuth(app, {
    token: authToken,
    trustProxy,
    publicRead,
  })

  // ADR-073 §3 amendment — `/api/config` is always unauthenticated. The web
  // shell hits it before any bearer-carrying request to learn which mode the
  // daemon is in. Exposes exactly two booleans — `publicRead` and
  // `authProxy` — and nothing else; no project list, no version, no env.
  app.get('/api/config', async () => ({
    publicRead: publicRead === true,
    authProxy: trustProxy === true,
  }))

  const startedAt = opts.startedAt ?? Date.now()
  const registry = buildLegacyRegistry(opts)

  const legacyErrorsExplicit = !opts.projects && opts.errorsPath !== undefined
  const legacyStaleExplicit = !opts.projects && opts.staleEventsPath !== undefined

  const errorsPathFor = (proj: ProjectContext): string | undefined => {
    if (proj.name === DEFAULT_PROJECT && !opts.projects) {
      return legacyErrorsExplicit ? opts.errorsPath : undefined
    }
    return proj.paths.errorsPath
  }
  const staleEventsPathFor = (proj: ProjectContext): string | undefined => {
    if (proj.name === DEFAULT_PROJECT && !opts.projects) {
      return legacyStaleExplicit ? opts.staleEventsPath : undefined
    }
    return proj.paths.staleEventsPath
  }

  // policy.json lives at the project's scanPath root per ADR-042. Without a
  // scanPath we have nowhere to read it from — those projects show as
  // "no policies configured" via the empty-file response.
  const policyFilePathFor = (proj: ProjectContext): string | undefined => {
    if (!proj.scanPath) return undefined
    return `${proj.scanPath}/policy.json`
  }

  const routeCtx: RouteContext = {
    registry,
    startedAt,
    scope: 'root',
    errorsPathFor,
    staleEventsPathFor,
    policyFilePathFor,
    bootstrap: opts.bootstrap,
    singleProject: opts.singleProject?.name,
  }

  // Daemon-wide /health (issue #343). Per ADR-049 the daemon is the unit of
  // readiness; the response answers "is this process up and what's it
  // currently serving?" without depending on a `default` project. Probes —
  // orchestrator, kubelet readiness, systemd, supervisors — read this.
  //
  // The `projects` array surfaces every slot the daemon knows about. When
  // the bootstrap tracker is wired (issue #340), the per-entry `status`
  // and `elapsedMs` come from there so the orchestrator's wait loop can
  // tell `bootstrapping` apart from `active` without per-project probes.
  app.get('/health', async () => {
    const uptimeMs = Date.now() - startedAt
    const bootstrapList = opts.bootstrap?.list() ?? []
    const byName = new Map(bootstrapList.map((p) => [p.name, p]))
    const names = new Set<string>([
      ...registry.list(),
      ...bootstrapList.map((p) => p.name),
    ])
    const projects = [...names].sort().map((name) => {
      const proj = registry.get(name)
      const tracked = byName.get(name)
      return {
        name,
        nodeCount: proj?.graph.order ?? 0,
        edgeCount: proj?.graph.size ?? 0,
        ...(tracked ? { status: tracked.status, elapsedMs: tracked.elapsedMs } : {}),
      }
    })
    return {
      ok: true,
      uptimeMs,
      // ADR-096 §7 — a per-project daemon carries its project at the top level
      // so a spawn can confirm a daemon found on a reused port is serving THIS
      // project before reusing it. The legacy multi-project daemon omits it and
      // is matched against the `projects` array instead.
      ...(opts.singleProject ? { project: opts.singleProject.name } : {}),
      projects,
    }
  })

  // ADR-096 §4 — "the daemon is the project." A per-project daemon reports only
  // its own project here, so the dashboard pins to the project this daemon
  // serves rather than to whichever machine-registered project happens to be
  // active. The legacy multi-project daemon hands back the machine-level
  // registry (ADR-048) — the one documented bare-array GET. Either way the
  // response is `Array<RegistryEntry>`, which the dashboard and the CLI's
  // bare-verb resolver treat as a list primitive.
  app.get('/projects', async (_req, reply) => {
    if (opts.singleProject) {
      const phase = opts.bootstrap?.status(opts.singleProject.name)
      const entry: RegistryEntry = {
        name: opts.singleProject.name,
        path: opts.singleProject.path,
        registeredAt: new Date(startedAt).toISOString(),
        languages: [],
        // The daemon is serving this project, so it's active unless its
        // bootstrap broke. ('bootstrapping' still reads as active — the project
        // is the one to land on; its graph route answers 503 until ready.)
        status: phase === 'broken' ? 'broken' : 'active',
      }
      return [entry]
    }
    try {
      return await listRegistryProjects()
    } catch (err) {
      return reply.code(500).send({
        error: 'failed to read project registry',
        details: (err as Error).message,
      })
    }
  })

  // Singular project lookup (ADR-061 #7). Distinct route from the
  // `/projects/:project/...` dual-mount prefix because Fastify matches on
  // the full path; the trailing-segment-less request lands here.
  app.get<{ Params: { project: string } }>('/projects/:project', async (req, reply) => {
    try {
      const entry = await getRegistryProject(req.params.project)
      if (!entry) {
        return reply
          .code(404)
          .send({ error: 'project not found', project: req.params.project })
      }
      return { project: entry }
    } catch (err) {
      return reply.code(500).send({
        error: 'failed to read project registry',
        details: (err as Error).message,
      })
    }
  })

  // Default mount: /graph, /incidents, etc. resolve to project=default.
  // `/health` at this scope is the daemon-wide handler registered above,
  // not the per-project one (issue #343).
  registerRoutes(app, routeCtx)

  // Project-scoped mount: same handlers, URL params include `:project`,
  // and `/health` answers per project.
  await app.register(
    async (scope) => {
      registerRoutes(scope, { ...routeCtx, scope: 'project' })
    },
    { prefix: '/projects/:project' },
  )

  return app
}

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
} from '@neat.is/types'
import { DivergenceTypeSchema, PoliciesCheckBodySchema, PolicySeveritySchema } from '@neat.is/types'
import type { DivergenceType } from '@neat.is/types'
import { computeDivergences } from './divergences.js'
import {
  evaluateAllPolicies,
  loadPolicyFile,
  PolicyViolationsLog,
} from './policy.js'
import type { NeatGraph } from './graph.js'
import { DEFAULT_PROJECT } from './graph.js'
import { extractFromDirectory } from './extract.js'
import { readErrorEvents, readStaleEvents } from './ingest.js'
import {
  getBlastRadius,
  getRootCause,
  getTransitiveDependencies,
  TRANSITIVE_DEPENDENCIES_DEFAULT_DEPTH,
  TRANSITIVE_DEPENDENCIES_MAX_DEPTH,
} from './traverse.js'
import { computeGraphDiff, loadSnapshotForDiff } from './diff.js'
import type { SearchIndex } from './search.js'
import type { Projects, ProjectContext } from './projects.js'
import { Projects as ProjectsClass, pathsForProject } from './projects.js'
import { getProject as getRegistryProject, listProjects as listRegistryProjects } from './registry.js'
import { handleSse } from './streaming.js'
import { mountBearerAuth } from './auth.js'

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

function projectFromReq(req: FastifyRequest): string {
  // `:project` is optional in the URL — the request hits either
  // /projects/:project/X or /X (which means default). Coerce the missing
  // param to DEFAULT_PROJECT here so handlers don't repeat the fallback.
  const params = req.params as { project?: string }
  return params.project ?? DEFAULT_PROJECT
}

function resolveProject(
  registry: Projects,
  req: FastifyRequest,
  reply: FastifyReply,
): ProjectContext | null {
  const name = projectFromReq(req)
  const ctx = registry.get(name)
  if (!ctx) {
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
  // Legacy callers passed `errorsPath`/`staleEventsPath` explicitly and
  // expected absent values to disable the read. Track that intent so the
  // /incidents handlers don't accidentally read a phantom file.
  errorsPathFor: (ctx: ProjectContext) => string | undefined
  staleEventsPathFor: (ctx: ProjectContext) => string | undefined
  // policy.json lives at the project root (per ADR-042 §File location), not
  // under neat-out/. Routes that read it map a project context to the path.
  policyFilePathFor: (ctx: ProjectContext) => string | undefined
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
    const proj = resolveProject(registry, req, reply)
    if (!proj) return
    handleSse(req, reply, { project: proj.name })
  })

  scope.get<{ Params: { project?: string } }>('/health', async (req, reply) => {
    const proj = resolveProject(registry, req, reply)
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

  scope.get<{ Params: { project?: string } }>('/graph', async (req, reply) => {
    const proj = resolveProject(registry, req, reply)
    if (!proj) return
    return serializeGraph(proj.graph)
  })

  scope.get<{ Params: { project?: string; id: string } }>(
    '/graph/node/:id',
    async (req, reply) => {
      const proj = resolveProject(registry, req, reply)
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
      const proj = resolveProject(registry, req, reply)
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
    const proj = resolveProject(registry, req, reply)
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

  // Divergence query — the thesis surface (ADR-060). Read-only, derived,
  // dual-mounted via registerRoutes. Query params filter the result set;
  // body shape is DivergenceResult.
  scope.get<{
    Params: { project?: string }
    Querystring: { type?: string; minConfidence?: string; node?: string }
  }>('/graph/divergences', async (req, reply) => {
    const proj = resolveProject(registry, req, reply)
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
    const proj = resolveProject(registry, req, reply)
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
    const proj = resolveProject(registry, req, reply)
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

  scope.get<{ Params: { project?: string; nodeId: string } }>(
    '/incidents/:nodeId',
    async (req, reply) => {
      const proj = resolveProject(registry, req, reply)
      if (!proj) return
      const { nodeId } = req.params
      if (!proj.graph.hasNode(nodeId)) {
        return reply.code(404).send({ error: 'node not found', id: nodeId })
      }
      const epath = errorsPathFor(proj)
      if (!epath) return { count: 0, total: 0, events: [] }
      const events = await readErrorEvents(epath)
      const filtered = events.filter(
        (e) =>
          e.affectedNode === nodeId || e.service === nodeId.replace(/^service:/, ''),
      )
      return { count: filtered.length, total: filtered.length, events: filtered }
    },
  )

  scope.get<{
    Params: { project?: string; nodeId: string }
    Querystring: { errorId?: string }
  }>('/graph/root-cause/:nodeId', async (req, reply) => {
    const proj = resolveProject(registry, req, reply)
    if (!proj) return
    const { nodeId } = req.params
    if (!proj.graph.hasNode(nodeId)) {
      return reply.code(404).send({ error: 'node not found', id: nodeId })
    }
    let errorEvent: ErrorEvent | undefined
    const epath = errorsPathFor(proj)
    if (req.query.errorId && epath) {
      const events = await readErrorEvents(epath)
      errorEvent = events.find((e) => e.id === req.query.errorId)
      if (!errorEvent) {
        return reply
          .code(404)
          .send({ error: 'error event not found', id: req.query.errorId })
      }
    }
    const result = getRootCause(proj.graph, nodeId, errorEvent)
    if (!result) return reply.code(404).send({ error: 'no root cause found', id: nodeId })
    return result
  })

  scope.get<{
    Params: { project?: string; nodeId: string }
    Querystring: { depth?: string }
  }>('/graph/blast-radius/:nodeId', async (req, reply) => {
    const proj = resolveProject(registry, req, reply)
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
    const proj = resolveProject(registry, req, reply)
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
      const proj = resolveProject(registry, req, reply)
      if (!proj) return
      const against = req.query.against
      if (!against) {
        return reply.code(400).send({ error: 'query parameter `against` is required' })
      }
      try {
        const snapshot = await loadSnapshotForDiff(against)
        return computeGraphDiff(proj.graph, snapshot)
      } catch (err) {
        return reply
          .code(400)
          .send({ error: 'failed to load snapshot', against, detail: (err as Error).message })
      }
    },
  )

  scope.post<{ Params: { project?: string } }>('/graph/scan', async (req, reply) => {
    const proj = resolveProject(registry, req, reply)
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
    const proj = resolveProject(registry, req, reply)
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
    const proj = resolveProject(registry, req, reply)
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

  scope.post<{
    Params: { project?: string }
    Body: { hypotheticalAction?: unknown }
  }>('/policies/check', async (req, reply) => {
    const proj = resolveProject(registry, req, reply)
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
}

export async function buildApi(opts: BuildApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cors, { origin: true })

  // ADR-073 §3 — bearer middleware sits ahead of every route handler. No-op
  // when `authToken` is undefined; loopback-only callers (the laptop dev
  // path) hit that branch.
  mountBearerAuth(app, { token: opts.authToken, trustProxy: opts.trustProxy })

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
    errorsPathFor,
    staleEventsPathFor,
    policyFilePathFor,
  }

  // Multi-project switcher (ADR-051 #4). Direct passthrough of the
  // machine-level registry from registry.ts (ADR-048) — distinct from the
  // dual-mount routing in ADR-026, which exposes per-project endpoints.
  // Returns Array<{ name, path, status, registeredAt, lastSeenAt?, languages }>.
  app.get('/projects', async (_req, reply) => {
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

  // Default mount: /health, /graph, /incidents, etc. all hit project=default.
  registerRoutes(app, routeCtx)

  // Project-scoped mount: same handlers, URL params include `:project`.
  await app.register(
    async (scope) => {
      registerRoutes(scope, routeCtx)
    },
    { prefix: '/projects/:project' },
  )

  return app
}

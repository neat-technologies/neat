import { z } from 'zod'
import { GraphEdgeSchema } from './edges.js'
import { GraphNodeSchema } from './nodes.js'
import { ErrorEventSchema, LogEntrySchema, StaleEventSchema } from './events.js'
import { PolicyViolationSchema } from './policy.js'
import { RegistryEntrySchema } from './registry.js'

// ADR-061 envelope rule: every GET response is a JSON object. List endpoints
// wrap in plural-noun fields plus a count; single-item endpoints wrap the
// item in a singular field. Bare arrays are a contract violation.

// `count` is the length of the returned array; `total` is the size of the
// underlying collection before filtering / limiting.
const listEnvelope = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    events: z.array(itemSchema),
  })

export const IncidentsResponseSchema = listEnvelope(ErrorEventSchema)
export type IncidentsResponse = z.infer<typeof IncidentsResponseSchema>

export const StaleEventsResponseSchema = listEnvelope(StaleEventSchema)
export type StaleEventsResponse = z.infer<typeof StaleEventsResponseSchema>

// GET /logs response (docs/contracts/logs.md Rule 5, ADR-132). `total` is
// the size of the filtered-but-unlimited collection (after source/service/
// since filtering); `count` is the length of the returned, limit-capped
// `logs` array.
export const LogsResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  logs: z.array(LogEntrySchema),
})
export type LogsResponse = z.infer<typeof LogsResponseSchema>

export const PoliciesViolationsResponseSchema = z.object({
  violations: z.array(PolicyViolationSchema),
})
export type PoliciesViolationsResponse = z.infer<typeof PoliciesViolationsResponseSchema>

export const GraphNodeResponseSchema = z.object({
  node: GraphNodeSchema,
})
export type GraphNodeResponse = z.infer<typeof GraphNodeResponseSchema>

export const GraphEdgesResponseSchema = z.object({
  inbound: z.array(GraphEdgeSchema),
  outbound: z.array(GraphEdgeSchema),
})
export type GraphEdgesResponse = z.infer<typeof GraphEdgesResponseSchema>

// `.passthrough()` because the handler keeps legacy fields (uptime,
// nodeCount, edgeCount, lastUpdated) for the web shell's StatusBar. The
// canonical triple is what's required; the extras ride along.
// Extraction coverage for the most recent full pass (#883). Per-file parse
// failures already land in errors.ndjson + the init/watch banner, but nothing
// carried the count into the query surface — so `dependencies` / `blast-radius`
// / `divergences` answered from a silently-incomplete graph. A daemon surfaces
// this on /health so a caller can tell the graph is partial. `skippedFiles: 0`
// is a positive signal; the field is absent only when no pass has recorded it.
export const ExtractionCoverageSchema = z.object({
  skippedFiles: z.number().int().nonnegative(),
  byProducer: z.record(z.number().int().nonnegative()),
  // Up to a bounded sample of the files that failed to parse this pass.
  files: z.array(z.string()),
  updatedAt: z.string(),
})
export type ExtractionCoverage = z.infer<typeof ExtractionCoverageSchema>

export const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
    project: z.string(),
    uptimeMs: z.number().int().nonnegative(),
    // Present when the most recent extraction pass recorded its coverage (#883).
    coverage: ExtractionCoverageSchema.optional(),
  })
  .passthrough()
export type HealthResponse = z.infer<typeof HealthResponseSchema>

// Daemon-wide /health (issue #343). Distinct from `HealthResponseSchema`
// because the unscoped probe doesn't have a single project to report on —
// readiness lives at the daemon level. `projects` is a flat array of every
// slot currently loaded so a probe consumer can decide which subset to
// poll per-project /health on.
export const DaemonHealthResponseSchema = z
  .object({
    ok: z.boolean(),
    uptimeMs: z.number().int().nonnegative(),
    projects: z.array(
      z.object({
        name: z.string(),
        nodeCount: z.number().int().nonnegative(),
        edgeCount: z.number().int().nonnegative(),
      }).passthrough(),
    ),
  })
  .passthrough()
export type DaemonHealthResponse = z.infer<typeof DaemonHealthResponseSchema>

// GET /projects annotates each registry entry with whether the responding
// daemon actually serves it. The registry (`~/.neat/projects.json`) is shared
// across every daemon on the machine, so a single core's /projects lists
// projects other daemons own; `hostedHere: false` is the signal a caller needs
// to avoid trusting per-project answers from a core that doesn't host the
// project (#884). GET /projects predates the ADR-061 envelope rule and stays a
// bare array (the CLI and web switcher read that shape); the field is additive.
export const ProjectListEntrySchema = RegistryEntrySchema.extend({
  hostedHere: z.boolean(),
})
export type ProjectListEntry = z.infer<typeof ProjectListEntrySchema>

// Where a project the responding daemon does not host actually lives — the
// owning daemon's project root and REST port, discovered from ~/.neat/daemons/
// (#884). `live` reconciles the discovery record's pid.
export const ProjectServedBySchema = z.object({
  path: z.string(),
  restPort: z.number().int(),
  live: z.boolean(),
})
export type ProjectServedBy = z.infer<typeof ProjectServedBySchema>

export const SingleProjectResponseSchema = z.object({
  project: ProjectListEntrySchema,
  // Present only when this daemon does not host the project but another daemon
  // on the machine does — names where it actually lives (#884).
  servedBy: ProjectServedBySchema.optional(),
})
export type SingleProjectResponse = z.infer<typeof SingleProjectResponseSchema>

// GET /:project/connectors response (docs/contracts/rest-api.md, connectors.md
// §8, ADR-136). One entry per `~/.neat/connectors.json` connector matching the
// project, credential redacted to its env-ref pointer (never a resolved value),
// carrying the live poll health the in-process status tracker records.

// The derived poll state the endpoint reports:
//   idle    — no poll tick has run yet
//   healthy — the most recent tick succeeded within the stale window
//   error   — the most recent tick threw
//   stale   — no successful poll within the stale window (a wedged/silent loop)
export const ConnectorPollStateSchema = z.enum(['idle', 'healthy', 'error', 'stale'])
export type ConnectorPollState = z.infer<typeof ConnectorPollStateSchema>

// The per-connector live health block. `lastPollAt`/`lastOutcome`/`lastError`
// are null until the first tick; `lastError` is null on a successful tick and a
// short, secret-free string on a failing one (connectors.md §6 — never a
// credential). `signalsLastPoll` is the count the last tick returned (0 before
// any poll).
export const ConnectorStatusSchema = z.object({
  state: ConnectorPollStateSchema,
  lastPollAt: z.string().nullable(),
  lastOutcome: z.enum(['ok', 'error']).nullable(),
  lastError: z.string().nullable(),
  signalsLastPoll: z.number().int().nonnegative(),
})
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>

// `credentialRef` is the redacted env-ref pointer — a single string
// (`"$CF_TOKEN"`) for a single-field credential, or a field→pointer map for a
// multi-field one. A plaintext literal redacts to `"****"`. Never a resolved
// secret (ADR-136 §3).
export const ConnectorStatusEntrySchema = z.object({
  id: z.string(),
  provider: z.string(),
  credentialRef: z.union([z.string(), z.record(z.string(), z.string())]),
  status: ConnectorStatusSchema,
})
export type ConnectorStatusEntry = z.infer<typeof ConnectorStatusEntrySchema>

export const ConnectorsStatusResponseSchema = z.object({
  connectors: z.array(ConnectorStatusEntrySchema),
})
export type ConnectorsStatusResponse = z.infer<typeof ConnectorsStatusResponseSchema>

// /search matches are graph nodes with an added per-match score. The
// schema keeps `score` mandatory and lets the underlying node shape pass
// through — GraphNodeSchema is a discriminated union and tightening here
// would force every match into one variant.
export const SearchMatchSchema = z
  .object({ score: z.number() })
  .passthrough()
export type SearchMatch = z.infer<typeof SearchMatchSchema>

export const SearchResponseSchema = z.object({
  query: z.string(),
  provider: z.string(),
  matches: z.array(SearchMatchSchema),
})
export type SearchResponse = z.infer<typeof SearchResponseSchema>

// Live snapshot returned by GET /graph. Mirrors the in-memory graphology
// instance; nothing reads graph.json at request time (Rule 6).
export const SerializedGraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
})
export type SerializedGraph = z.infer<typeof SerializedGraphSchema>

// GET /graph/diff response. The diff module owns the implementation;
// the schema mirrors its current GraphDiff interface.
export const GraphDiffResultSchema = z.object({
  base: z.object({ exportedAt: z.string().optional() }),
  current: z.object({ exportedAt: z.string() }),
  added: z.object({
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
  }),
  removed: z.object({
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
  }),
  changed: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        before: GraphNodeSchema,
        after: GraphNodeSchema,
      }),
    ),
    edges: z.array(
      z.object({
        id: z.string(),
        before: GraphEdgeSchema,
        after: GraphEdgeSchema,
      }),
    ),
  }),
})
export type GraphDiffResult = z.infer<typeof GraphDiffResultSchema>

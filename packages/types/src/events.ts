import { z } from 'zod'

// Passthrough of OTel span attributes. Records source-attribution
// (`code.filepath`, `code.lineno`, `code.function`), HTTP context
// (`http.method`, `http.target`, `http.status_code`), DB context
// (`db.system`, `db.statement`), and any other span attribute the SDK
// emitted. Consumers (incident UI, MCP getRootCause) filter what they
// surface. Schema growth per ADR-031 — optional, additive only.
export const SpanAttributesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string()), z.array(z.number()), z.array(z.boolean())]),
)
export type SpanAttributes = z.infer<typeof SpanAttributesSchema>

export const ErrorEventSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),
  service: z.string(),
  traceId: z.string(),
  spanId: z.string(),
  errorType: z.string().optional(),
  errorMessage: z.string(),
  // OTLP span events with name="exception" carry richer error data than
  // status.message. When present, these fields capture the exception type
  // and stacktrace from the SDK that recorded the error. ADR-031 schema
  // growth — added without a shape change because both fields are optional.
  exceptionType: z.string().optional(),
  exceptionStacktrace: z.string().optional(),
  // Span attributes passthrough (ADR-068 follow-up). Surfaces `code.*`
  // semconv attributes for source attribution, plus the rest of the
  // attribute set for downstream filtering.
  attributes: SpanAttributesSchema.optional(),
  affectedNode: z.string(),
  // Failing-response incidents (issue #481). A span that completes 5xx, or a
  // coalesced run of 4xx CLIENT/PRODUCER spans against one peer, records an
  // incident even though OTel leaves the CLIENT span's status UNSET. These
  // fields carry the response code and the burst shape; ADR-031 schema growth —
  // all optional, so the statusCode === 2 and exception paths keep their shape.
  //   httpStatusCode — the response status (the dominant code for a burst).
  //   incidentCount  — how many failing responses this incident coalesces
  //                    (1 for a 5xx, N for a flushed 4xx burst).
  //   firstTimestamp / lastTimestamp — the burst's span-time bounds.
  httpStatusCode: z.number().int().optional(),
  incidentCount: z.number().int().positive().optional(),
  firstTimestamp: z.string().datetime().optional(),
  lastTimestamp: z.string().datetime().optional(),
})
export type ErrorEvent = z.infer<typeof ErrorEventSchema>

// Appended one-per-line to stale-events.ndjson whenever ingest.ts demotes
// an OBSERVED edge to STALE (per-edge-type thresholds, ADR-024). Surfaces
// on GET /stale-events for incident triage.
export const StaleEventSchema = z.object({
  edgeId: z.string(),
  source: z.string(),
  target: z.string(),
  edgeType: z.string(),
  thresholdMs: z.number().nonnegative(),
  ageMs: z.number().nonnegative(),
  lastObserved: z.string(),
  transitionedAt: z.string(),
})
export type StaleEvent = z.infer<typeof StaleEventSchema>

// The one shape every log producer emits (docs/contracts/logs.md Rule 1,
// ADR-132) — a native OTLP `/v1/logs` receiver (source: 'native') and each
// connector's provider-specific mapping layer (source: '<provider>') both
// produce this. `logs-store.ts` holds these in a bounded per-(project,
// source) ring buffer; GET /logs is the only REST surface that reads it.
// `source` is extensible the same way the connector provider dispatch table
// grows one entry per provider.
export const LogSourceSchema = z.enum([
  'native',
  'supabase',
  'railway',
  'firebase',
  'cloudflare',
  'vercel',
])
export type LogSource = z.infer<typeof LogSourceSchema>

export const LogEntrySchema = z.object({
  id: z.string(),
  projectName: z.string(),
  source: LogSourceSchema,
  serviceName: z.string().optional(),
  nodeId: z.string().optional(),
  // ISO8601, the event's own time — never ingest/poll time.
  timestamp: z.string().datetime(),
  // Normalized upstream to 'debug' | 'info' | 'warn' | 'error' by whichever
  // producer wrote the entry; kept as a plain string here rather than a
  // locked enum because normalization is a producer concern, not this
  // schema's.
  severity: z.string().optional(),
  message: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
})
export type LogEntry = z.infer<typeof LogEntrySchema>

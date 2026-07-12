import { z } from 'zod'

// The connector status view (docs/contracts/web-shell.md, ADR-137) — a
// read-only surface over the connectors plane's own runtime state. Mirrors
// `neat connector list` exactly: the credential rides as its redacted
// env-ref pointer (`$CF_TOKEN`), never a resolved secret. `state` is the
// same STALE vocabulary the canvas legend already teaches, applied to a
// connector's own liveness rather than an edge's.
export const ConnectorStateSchema = z.enum(['idle', 'polling', 'healthy', 'error', 'stale'])
export type ConnectorState = z.infer<typeof ConnectorStateSchema>

export const ConnectorStatusSchema = z.object({
  state: ConnectorStateSchema,
  // ISO8601, or null before the connector's first poll tick.
  lastPollAt: z.string().datetime().nullable(),
  // Short failure message, no secrets — null when the last poll (or every
  // poll so far) succeeded.
  lastError: z.string().nullable(),
  // Signals minted on the most recent poll tick; null before a first poll.
  signalsLastPoll: z.number().int().nonnegative().nullable(),
})
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>

export const ConnectorSummarySchema = z.object({
  // addressable handle, auto-slugged from provider (connector-config.md §1)
  id: z.string(),
  // free string, same discipline as LogSource / ServiceNode.platform — a
  // future provider is a new dispatch-table entry, not a schema change.
  provider: z.string(),
  // the redacted env-ref pointer ("$CF_TOKEN") or, for a multi-field
  // credential, its flattened display form — never a resolved value.
  credentialRef: z.string(),
  status: ConnectorStatusSchema,
})
export type ConnectorSummary = z.infer<typeof ConnectorSummarySchema>

// GET /:project/connectors response (ADR-137).
export const ConnectorsResponseSchema = z.object({
  connectors: z.array(ConnectorSummarySchema),
})
export type ConnectorsResponse = z.infer<typeof ConnectorsResponseSchema>

// The connector status view (docs/contracts/web-shell.md, ADR-137) reads the same
// shape the GET /:project/connectors endpoint returns (ADR-136). Those types are
// the endpoint's contract, defined once in responses.ts; re-exported here under
// the view's own names so the view and the endpoint can never drift.
//
// `ConnectorSummary` is a per-connector entry — the redacted credential pointer
// (`$CF_TOKEN`, or a field→pointer map for a multi-field credential; never a
// resolved secret, connector-config.md §1) plus its live poll `status`.
// `ConnectorState` is the STALE vocabulary the canvas legend teaches, applied to
// a connector's own liveness rather than an edge's.
export {
  ConnectorPollStateSchema as ConnectorStateSchema,
  ConnectorStatusEntrySchema as ConnectorSummarySchema,
  ConnectorsStatusResponseSchema as ConnectorsResponseSchema,
} from './responses.js'
export type {
  ConnectorPollState as ConnectorState,
  ConnectorStatusEntry as ConnectorSummary,
  ConnectorsStatusResponse as ConnectorsResponse,
} from './responses.js'

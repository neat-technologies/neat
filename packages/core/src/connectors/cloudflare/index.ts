// Cloudflare Workers/Pages connector (docs/connectors/cloudflare.md, ADR-129).
// Ships at whole-file grain by default, sharpening to route grain when a
// static router recognizer covers the Worker (ADR-133 §5) — see connector.ts
// and map.ts. Re-exports the module's public surface for daemon/CLI wiring
// and for tests.

export { CloudflareConnector, createCloudflareResolveTarget } from './connector.js'
export { queryWorkerInvocations, type TelemetryWindow } from './client.js'
export { mapEventToSignal, parseHttpMethodFromTrigger, parsePathFromTrigger } from './map.js'
export {
  CLOUDFLARE_TARGET_KIND,
  type CloudflareConnectorConfig,
  type CloudflareObservedSignal,
  type CloudflareTelemetryEvent,
  type CloudflareTelemetryEventMetadata,
  type CloudflareTelemetryQueryResponse,
  type CloudflareTelemetryWorkersMetadata,
  type CloudflareWorkerMapping,
} from './types.js'

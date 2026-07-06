// Cloudflare Workers/Pages connector (docs/connectors/cloudflare.md, ADR-129).
// v1 ships at whole-file grain, deliberately — see connector.ts and map.ts
// for why. Re-exports the module's public surface for daemon/CLI wiring and
// for tests.

export { CloudflareConnector, createCloudflareResolveTarget } from './connector.js'
export { queryWorkerInvocations, type TelemetryWindow } from './client.js'
export { mapEventToLogEntry, mapEventToSignal, parseHttpMethodFromTrigger } from './map.js'
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

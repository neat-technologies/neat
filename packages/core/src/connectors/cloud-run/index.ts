// The Cloud Run connector (docs/connectors/cloud-run.md, ADR-165) — sixth
// connectors-plane pull provider.
//
// poll() pulls Cloud Logging's `entries.list` (client.ts), filtered to Cloud
// Run's own request log (`run.googleapis.com/requests`), and maps each entry to
// an ObservedSignal (map.ts). Target resolution — a mapped service's RouteNode
// via the shared route normalisation, or an honest `cloud-run-service` InfraNode
// fallback when none resolves — lives in resolve.ts. Everything downstream of
// resolution (minting the OBSERVED edge, the `ensureInfraNode` fallback) is the
// shared connectors/index.ts pipeline; this module never touches the graph
// directly (ADR-030).

import type { NeatGraph } from '../../graph.js'
import type { ConnectorContext, ObservedConnector, ObservedSignal } from '../types.js'
import type { ResolveConnectorTarget } from '../index.js'
import { DEFAULT_LOOKBACK_MS, fetchCloudRunRequestLogEntries } from './client.js'
import { mapLogEntriesToSignals } from './map.js'
import { createCloudRunResolveTarget } from './resolve.js'
import { readCloudRunCredentials, type CloudRunConnectorConfig } from './types.js'

export * from './client.js'
export * from './map.js'
export * from './resolve.js'
export * from './types.js'

export class CloudRunConnector implements ObservedConnector {
  readonly provider = 'cloud-run'

  constructor(private readonly config: CloudRunConnectorConfig = {}) {}

  async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
    const creds = readCloudRunCredentials(ctx.credentials)
    const maxLookbackMs = this.config.maxLookbackMs ?? DEFAULT_LOOKBACK_MS
    const sinceIso = boundedSinceIso(ctx.since, new Date(), maxLookbackMs)
    const entries = await fetchCloudRunRequestLogEntries(creds, sinceIso, this.config.apiUrl)
    return mapLogEntriesToSignals(entries)
  }
}

// `since` bounded by the provider's max lookback window (connectors.md "Poll
// cadence and backfill") — a gap wider than the window (a laptop off for a
// week) backfills from `now - maxLookbackMs`, never an unbounded full-history
// replay. An absent or unparseable `since` (no prior poll) gets the same floor.
export function boundedSinceIso(since: string | undefined, now: Date, maxLookbackMs: number): string {
  const floor = new Date(now.getTime() - maxLookbackMs)
  if (!since) return floor.toISOString()
  const sinceMs = new Date(since).getTime()
  if (Number.isNaN(sinceMs)) return floor.toISOString()
  return sinceMs < floor.getTime() ? floor.toISOString() : new Date(sinceMs).toISOString()
}

/**
 * Wires up a ready-to-register Cloud Run connector: the `ObservedConnector`
 * plus the `resolveTarget` callback the shared pipeline needs alongside it.
 * Both are built together because `resolveTarget` closes over `graph` — the
 * shared scaffold's `ResolveConnectorTarget` signature never receives it
 * directly.
 */
export function createCloudRunConnector(
  graph: NeatGraph,
  config: CloudRunConnectorConfig = {},
): { connector: ObservedConnector; resolveTarget: ResolveConnectorTarget } {
  return {
    connector: new CloudRunConnector(config),
    resolveTarget: createCloudRunResolveTarget(graph, config),
  }
}

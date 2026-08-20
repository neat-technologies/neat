// The GCP HTTP(S) Load Balancer connector (docs/connectors/gcp-lb.md, ADR-208)
// — eleventh connectors-plane pull provider and the second GCP request-log
// surface after Cloud Run (ADR-165).
//
// poll() pulls Cloud Logging's `entries.list` (client.ts), filtered to the
// external ALB's own request log (`http_load_balancer`), and maps each entry to
// an ObservedSignal (map.ts). Target resolution — a mapped backend's RouteNode
// via the shared route normalisation, or an honest `gcp-lb-backend` InfraNode
// fallback when none resolves — lives in resolve.ts. Everything downstream of
// resolution (minting the OBSERVED edge, the `ensureInfraNode` fallback) is the
// shared connectors/index.ts pipeline; this module never touches the graph
// directly (ADR-030).

import type { NeatGraph } from '../../graph.js'
import type { ConnectorContext, ObservedConnector, ObservedSignal } from '../types.js'
import type { ResolveConnectorTarget } from '../index.js'
import { DEFAULT_LOOKBACK_MS, fetchGcpLbRequestLogEntries } from './client.js'
import { mapLogEntriesToSignals } from './map.js'
import { createGcpLbResolveTarget } from './resolve.js'
import { readGcpLbCredentials, type GcpLbConnectorConfig } from './types.js'

export * from './client.js'
export * from './map.js'
export * from './resolve.js'
export * from './types.js'

export class GcpLbConnector implements ObservedConnector {
  readonly provider = 'gcp-lb'

  constructor(private readonly config: GcpLbConnectorConfig = {}) {}

  async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
    const creds = readGcpLbCredentials(ctx.credentials)
    const maxLookbackMs = this.config.maxLookbackMs ?? DEFAULT_LOOKBACK_MS
    const sinceIso = boundedSinceIso(ctx.since, new Date(), maxLookbackMs)
    const entries = await fetchGcpLbRequestLogEntries(creds, sinceIso, this.config.apiUrl)
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
 * Wires up a ready-to-register GCP LB connector: the `ObservedConnector` plus
 * the `resolveTarget` callback the shared pipeline needs alongside it. Both are
 * built together because `resolveTarget` closes over `graph` — the shared
 * scaffold's `ResolveConnectorTarget` signature never receives it directly.
 */
export function createGcpLbConnector(
  graph: NeatGraph,
  config: GcpLbConnectorConfig = {},
): { connector: ObservedConnector; resolveTarget: ResolveConnectorTarget } {
  return {
    connector: new GcpLbConnector(config),
    resolveTarget: createGcpLbResolveTarget(graph, config),
  }
}

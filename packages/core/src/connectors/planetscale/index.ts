// PlanetScale connector (ADR-175, docs/connectors/planetscale.md) — a data-grain
// pull provider on the connectors plane (ADR-124, connectors/index.ts). Reads
// PlanetScale's own Query Insights telemetry and fuses per-table query stats
// onto the `sql-table` nodes the static SQL/ORM extractor already builds, the
// same fusion target Neon and Supabase's table-grain connectors use.
//
// The connector owns only poll() (fetch + map); the graph-reading target
// resolution is a separate `resolveTarget` built with the graph, mirroring the
// Supabase pairing the registry normalizes.

import type { NeatGraph } from '../../graph.js'
import type { ResolveConnectorTarget } from '../index.js'
import type { ConnectorContext, ObservedConnector, ObservedSignal } from '../types.js'
import {
  DEFAULT_MAX_LOOKBACK_MS,
  boundedPlanetscaleStartTime,
  fetchPlanetscaleInsights,
} from './client.js'
import { mapInsightsToSignals } from './map.js'
import { createPlanetscaleResolveTarget } from './resolve.js'
import { readPlanetscaleCredentials, type PlanetscaleConnectorConfig } from './types.js'

export * from './client.js'
export * from './map.js'
export * from './resolve.js'
export * from './types.js'

export interface PlanetscaleConnectorDeps {
  fetchImpl?: typeof fetch
  now?: () => Date
}

export class PlanetscaleConnector implements ObservedConnector {
  readonly provider = 'planetscale'

  constructor(
    private readonly config: PlanetscaleConnectorConfig,
    private readonly deps: PlanetscaleConnectorDeps = {},
  ) {}

  async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
    const credentials = readPlanetscaleCredentials(ctx.credentials)
    const now = this.deps.now?.() ?? new Date()
    const maxLookbackMs = this.config.maxLookbackMs ?? DEFAULT_MAX_LOOKBACK_MS
    const from = boundedPlanetscaleStartTime(ctx.since, now, maxLookbackMs)
    const to = now.toISOString()
    const rows = await fetchPlanetscaleInsights(this.config, credentials, from, to, this.deps.fetchImpl)
    return mapInsightsToSignals(rows, to)
  }
}

export function createPlanetscaleConnector(
  graph: NeatGraph,
  config: PlanetscaleConnectorConfig,
  deps: PlanetscaleConnectorDeps = {},
): { connector: ObservedConnector; resolveTarget: ResolveConnectorTarget } {
  return {
    connector: new PlanetscaleConnector(config, deps),
    resolveTarget: createPlanetscaleResolveTarget(graph, config),
  }
}

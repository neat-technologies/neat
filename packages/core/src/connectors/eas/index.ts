// The EAS build-failure connector (ADR-185, docs/plans/eas-build-connector-plan.md)
// — the first incident-emitting connector (connectors.md §10).
//
// poll() pulls the Expo app's `ERRORED` builds (client.ts), keeps the ones newer
// than the last watermark, fetches-and-caps each one's logs, and maps each to an
// incident-bearing ObservedSignal (map.ts). Target resolution — the
// buildPhase → ConfigNode/ServiceNode table through the fused-node lookup — lives
// in resolve.ts. Everything downstream (writing the incident to the ledger) is
// the shared connectors/index.ts pipeline; this module never touches the graph or
// the ledger directly (ADR-030).

import type { NeatGraph } from '../../graph.js'
import type { ConnectorContext, ObservedConnector, ObservedSignal } from '../types.js'
import type { ResolveConnectorTarget } from '../index.js'
import {
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_MAX_LOOKBACK_MS,
  fetchBuildLogs,
  fetchErroredBuilds,
} from './client.js'
import { buildEventTime, mapBuildsToSignals } from './map.js'
import { createEasResolveTarget } from './resolve.js'
import { readEasCredentials, type EasBuild, type EasConnectorConfig } from './types.js'

export * from './client.js'
export * from './map.js'
export * from './resolve.js'
export * from './types.js'

// Whether a build's own event time is strictly after the poll watermark. An
// unparseable time (or watermark) can't be compared, so the build is kept rather
// than dropped — an honest miss favours surfacing the failure. Re-minting the
// same build across ticks is harmless: the incident id (`eas:build:<id>`)
// collapses it on read (ingest.ts `dedupeIncidents`).
function isBuildSince(build: EasBuild, sinceIso: string): boolean {
  const t = Date.parse(buildEventTime(build))
  const s = Date.parse(sinceIso)
  if (Number.isNaN(t) || Number.isNaN(s)) return true
  return t > s
}

// `since` bounded by the connector's max lookback window (connectors.md §Poll
// cadence and backfill) — a gap wider than the window backfills from
// `now - maxLookbackMs`, never an unbounded full-history replay; an absent or
// unparseable `since` (no prior poll) gets the same floor. Same shape
// cloud-run's `boundedSinceIso` keeps.
export function boundedSinceIso(since: string | undefined, now: Date, maxLookbackMs: number): string {
  const floor = new Date(now.getTime() - maxLookbackMs)
  if (!since) return floor.toISOString()
  const sinceMs = new Date(since).getTime()
  if (Number.isNaN(sinceMs)) return floor.toISOString()
  return sinceMs < floor.getTime() ? floor.toISOString() : new Date(sinceMs).toISOString()
}

export class EasConnector implements ObservedConnector {
  readonly provider = 'eas'

  constructor(
    private readonly config: EasConnectorConfig,
    // Test seam — a fake `fetch` stands in for the live Expo API and the log
    // URLs so poll() never needs a real account. Production leaves it undefined
    // and the connector uses the global fetch (through the junction for the API).
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
    const creds = readEasCredentials(ctx.credentials)
    // The mapped NEAT service, or the app id when unmapped (stays coarse, and a
    // native-phase incident then drops honestly since there's no extracted
    // service to land on — connector-config.md §7.1).
    const serviceName = this.config.serviceName ?? this.config.appId
    const maxLookbackMs = this.config.maxLookbackMs ?? DEFAULT_MAX_LOOKBACK_MS
    const sinceIso = boundedSinceIso(ctx.since, new Date(), maxLookbackMs)

    const builds = await fetchErroredBuilds(creds.token, this.config, this.fetchImpl)
    const fresh = builds.filter((b) => isBuildSince(b, sinceIso))

    // Fetch-and-cap logs only for the fresh failures — the signed URLs are
    // time-limited, so this is the one moment they're readable (client.ts).
    const maxLogBytes = this.config.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
    for (const build of fresh) {
      build.logsText = await fetchBuildLogs(build.logFileUrls, maxLogBytes, this.fetchImpl)
    }

    return mapBuildsToSignals(fresh, serviceName)
  }
}

/**
 * Wires up a ready-to-register EAS connector: the `ObservedConnector` plus the
 * `resolveTarget` callback the shared pipeline needs alongside it. Both are built
 * together because `resolveTarget` closes over `graph` — the shared scaffold's
 * `ResolveConnectorTarget` signature never receives it directly.
 */
export function createEasConnector(
  graph: NeatGraph,
  config: EasConnectorConfig,
  fetchImpl?: typeof fetch,
): { connector: ObservedConnector; resolveTarget: ResolveConnectorTarget } {
  return {
    connector: new EasConnector(config, fetchImpl),
    resolveTarget: createEasResolveTarget(graph),
  }
}

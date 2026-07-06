// The Cloudflare Workers/Pages connector (docs/connectors/cloudflare.md,
// ADR-129). Owns the two provider-specific steps README.md's pipeline
// diagram assigns to `connectors/<provider>/`: fetching signals off
// Cloudflare's own API (`poll`, via client.ts + map.ts) and mapping a
// signal's targetKind/targetName to a NEAT node id
// (`createCloudflareResolveTarget`). Everything downstream — resolving a
// static call site, minting the OBSERVED edge — is the shared pipeline in
// connectors/index.ts; this module never mutates the graph itself.

import path from 'node:path'
import { EdgeType, fileId } from '@neat.is/types'
import { appendLogEntry } from '../../logs-store.js'
import type { ResolveConnectorTarget, ResolvedConnectorTarget } from '../index.js'
import type { ConnectorContext, ObservedConnector } from '../types.js'
import { queryWorkerInvocations } from './client.js'
import { mapEventToLogEntry, mapEventToSignal } from './map.js'
import { CLOUDFLARE_TARGET_KIND, type CloudflareConnectorConfig, type CloudflareObservedSignal } from './types.js'

// Cloudflare's docs don't confirm the Telemetry Query API's own max lookback
// window (docs/connectors/cloudflare.md needs-endpoint-testing); a
// conservative hour, same discipline connectors.md's "Poll cadence and
// backfill" requires of every provider — a gap larger than this backfills
// from `now - maxLookbackMs`, never an unbounded full-history query.
const DEFAULT_MAX_LOOKBACK_MS = 60 * 60 * 1000

function resolveFromMs(since: string | undefined, maxLookbackMs: number | undefined): number {
  const cap = maxLookbackMs ?? DEFAULT_MAX_LOOKBACK_MS
  const now = Date.now()
  const floor = now - cap
  if (!since) return floor
  const parsed = Date.parse(since)
  if (Number.isNaN(parsed)) return floor
  return Math.max(parsed, floor)
}

export class CloudflareConnector implements ObservedConnector {
  readonly provider = 'cloudflare'

  constructor(private readonly config: CloudflareConnectorConfig) {}

  async poll(ctx: ConnectorContext): Promise<CloudflareObservedSignal[]> {
    const toMs = Date.now()
    const fromMs = resolveFromMs(ctx.since, this.config.maxLookbackMs)
    const events = await queryWorkerInvocations(ctx, this.config, { fromMs, toMs })

    // Raw-record retention alongside the graph-facing signal (docs/
    // contracts/logs.md, connectors.md §7, ADR-132) — additive, never gates
    // or alters the ObservedSignal[] this method returns.
    const projectName = ctx.projectName ?? path.basename(ctx.projectDir)

    const signals: CloudflareObservedSignal[] = []
    for (const event of events) {
      const signal = mapEventToSignal(event)
      if (signal) signals.push(signal)
      const logEntry = mapEventToLogEntry(event, this.config, projectName)
      if (logEntry) appendLogEntry(logEntry)
    }
    return signals
  }
}

// Provider-specific target resolution (README.md's pipeline step 2). Per
// docs/connectors/cloudflare.md §Fusion, the signal's target is the Worker's
// single entry FileNode — not the caller, since this API carries no caller
// identity at all, only "this script was invoked". The edge that results,
// `service --CALLS--> entryFile`, mirrors the WebSocket channel precedent
// (ADR-125): a liveness signal minted from a service onto its own child node,
// reusing an existing edge verb rather than inventing one for "this file got
// reached" (connectors.md §4's fusion identity applies the same way here as
// it does when a future extractor recognizes the same Worker's routes).
//
// A script with no entry in `config.workers` resolves to `null` — an honest
// miss (connectors.md's own "never fabricates a node or edge" discipline),
// not a guess at which service/file it might belong to.
export function createCloudflareResolveTarget(config: CloudflareConnectorConfig): ResolveConnectorTarget {
  return (signal): ResolvedConnectorTarget | null => {
    if (signal.targetKind !== CLOUDFLARE_TARGET_KIND) return null
    const mapping = config.workers[signal.targetName]
    if (!mapping) return null
    return {
      targetNodeId: fileId(mapping.service, mapping.entryFile),
      serviceName: mapping.service,
      edgeType: EdgeType.CALLS,
    }
  }
}

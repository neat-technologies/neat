// The Cloudflare Workers/Pages connector (docs/connectors/cloudflare.md,
// ADR-129). Owns the two provider-specific steps README.md's pipeline
// diagram assigns to `connectors/<provider>/`: fetching signals off
// Cloudflare's own API (`poll`, via client.ts + map.ts) and mapping a
// signal's targetKind/targetName to a NEAT node id
// (`createCloudflareResolveTarget`). Everything downstream — resolving a
// static call site, minting the OBSERVED edge — is the shared pipeline in
// connectors/index.ts; this module never mutates the graph itself (ADR-030 —
// the honest-fallback case below declares a need via `ensureInfraNode`
// instead of creating anything directly, docs/contracts/connectors.md §4a).

import { EdgeType, NodeType, fileId, infraId } from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import type { ResolveConnectorTarget, ResolvedConnectorTarget } from '../index.js'
import type { ConnectorContext, ObservedConnector } from '../types.js'
import { queryWorkerInvocations } from './client.js'
import { mapEventToSignal } from './map.js'
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

    const signals: CloudflareObservedSignal[] = []
    for (const event of events) {
      const signal = mapEventToSignal(event)
      if (signal) signals.push(signal)
    }
    return signals
  }
}

// Scan the live graph for the entry FileNode ADR-133's `extract/infra/
// cloudflare.ts` tagged with this exact Worker script name
// (`platform === 'cloudflare' && platformName === workerName`). A plain scan,
// not a cached index — mirrors `reconcileObservedRelPath`'s own
// `graph.forEachNode` walk (ingest.ts); per-project Worker counts are small
// enough that this isn't worth a cache the live graph would have to
// invalidate on every re-extraction.
function findTaggedWorkerFileNode(graph: NeatGraph, workerName: string): string | null {
  let found: string | null = null
  graph.forEachNode((id, attrs) => {
    if (found) return
    const a = attrs as { type?: string; platform?: string; platformName?: string }
    if (a.type === NodeType.FileNode && a.platform === 'cloudflare' && a.platformName === workerName) {
      found = id
    }
  })
  return found
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
// Resolution order (ADR-133 §3, docs/contracts/connectors.md §4a):
//   1. `config.workers[scriptName]` — an explicit override, wins outright.
//   2. The extracted graph's own `platform`/`platformName` tag — the derived
//      default, no config entry needed at all for a scanned project.
//   3. Honest fallback — Cloudflare observed a Worker this scan never
//      declared. Lands a real edge via `ensureInfraNode` (surfacing as a
//      `missing-extracted` divergence) instead of a silent `null` drop.
export function createCloudflareResolveTarget(
  config: CloudflareConnectorConfig,
  graph: NeatGraph,
): ResolveConnectorTarget {
  return (signal): ResolvedConnectorTarget | null => {
    if (signal.targetKind !== CLOUDFLARE_TARGET_KIND) return null
    const scriptName = signal.targetName

    const mapping = config.workers?.[scriptName]
    if (mapping) {
      return {
        targetNodeId: fileId(mapping.service, mapping.entryFile),
        serviceName: mapping.service,
        edgeType: EdgeType.CALLS,
      }
    }

    const taggedFileId = findTaggedWorkerFileNode(graph, scriptName)
    if (taggedFileId) {
      const fileNode = graph.getNodeAttributes(taggedFileId) as { service: string }
      return {
        targetNodeId: taggedFileId,
        serviceName: fileNode.service,
        edgeType: EdgeType.CALLS,
      }
    }

    return {
      targetNodeId: infraId('cloudflare-worker', scriptName),
      serviceName: scriptName,
      edgeType: EdgeType.CALLS,
      ensureInfraNode: { kind: 'cloudflare-worker', name: scriptName, provider: 'cloudflare' },
    }
  }
}

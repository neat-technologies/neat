// Connectors plane — the provider-agnostic pull/map/fuse pipeline
// (docs/contracts/connectors.md, docs/connectors/README.md, ADR-124).
//
// A provider module (packages/core/src/connectors/<provider>/, none shipped
// yet) owns exactly two things: fetching `ObservedSignal[]` off its own API
// (`ObservedConnector.poll`) and mapping a signal's targetKind/targetName to
// a NEAT node id (the `resolveTarget` callback below). Everything after that
// — resolving a static call site, minting the OBSERVED edge — is written
// once, here, and is identical for every provider: a connector-sourced edge
// and a span-sourced edge carry the same provenance and land through the
// same mutation primitives OTel ingest uses (README.md's opening paragraph).
//
// Mutation authority (ADR-030 — see contracts.test.ts's "Lifecycle contract"
// audit): only ingest.ts and extract/* may call a graph mutator directly.
// This module never does — every node/edge write below goes through an
// ingest.ts primitive (`ensureServiceNode`, `ensureObservedFileNode`,
// `upsertObservedEdge`), exported for exactly this reuse. A future
// provider's own target-node creation (a Supabase table InfraNode, say)
// belongs in ingest.ts too, for the same reason — this module only ever
// calls into it, never mutates the graph itself.

import { NodeType, parseFileId, Provenance, type EdgeTypeValue, type GraphEdge } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import {
  ensureInfraNode,
  ensureObservedFileNode,
  ensureServiceNode,
  reconcileObservedRelPath,
  upsertObservedEdge,
  type CallSite,
} from '../ingest.js'
import type { ConnectorContext, ObservedConnector, ObservedSignal } from './types.js'
import { recordConnectorPoll, sanitizePollError } from './status.js'

export type {
  ConnectorCallSite,
  ConnectorContext,
  ObservedConnector,
  ObservedSignal,
} from './types.js'

// env-unscoped, matching the sentinel identity.ts uses for "no deployment
// signal" (ADR-074 §2) — a connector signal carries no
// deployment.environment(.name) the way an OTel span might.
const NO_ENV = 'unknown'

/**
 * What a provider's target-resolution step hands back for one signal. The
 * generic pipeline needs both endpoints of the edge it's about to mint:
 *
 * - `serviceName` is the NEAT manifest service whose code produced the
 *   signal — the edge's source. The shared pipeline turns it into a plain
 *   ServiceNode id, or a FileNode id once the fuse step below resolves the
 *   signal's callSite against it.
 * - `targetNodeId` is the id the provider's own mapping already resolved —
 *   an `infraId(...)` sub-resource, a RouteNode, a ServiceNode, whatever
 *   (see each provider's docs/connectors/<provider>.md §Fusion).
 *
 * Returning `null` skips the signal honestly: an unresolvable target never
 * fabricates a node or edge (the same discipline file-awareness.md §6
 * states for OTel ingest).
 */
export interface ResolvedConnectorTarget {
  targetNodeId: string
  serviceName: string
  edgeType: EdgeTypeValue
  /**
   * Set when `targetNodeId` names an InfraNode no static extractor has (yet)
   * declared — the honest "observed but undeclared" fallback
   * (docs/contracts/connectors.md §4a, ADR-133). A provider's `resolveTarget`
   * has no mutation authority of its own (ADR-030), so it declares the need
   * here instead of creating the node itself; the generic pipeline below
   * calls `ensureInfraNode` before minting the edge. `targetNodeId` MUST equal
   * `infraId(kind, name)` when this is set.
   */
  ensureInfraNode?: { kind: string; name: string; provider: string }
}

export type ResolveConnectorTarget = (
  signal: ObservedSignal,
  ctx: ConnectorContext,
) => ResolvedConnectorTarget | null

export interface ConnectorPollResult {
  // Signals connector.poll() returned this tick.
  signalCount: number
  // Fresh OBSERVED edges minted.
  edgesCreated: number
  // Existing OBSERVED edges whose signal block advanced.
  edgesUpdated: number
  // Signals that resolved to no target (resolveTarget returned null, or the
  // resolved target/service node doesn't exist in the graph yet) — dropped
  // honestly rather than minting a fabricated edge.
  unresolved: number
}

// #803 — file-grain a connector observation by attribution. A pull-connector's
// signal carries the target (table / route) it observed but no source location —
// the provider telemetry never recorded which line called it. The static
// extractor does: `<client>.from('table')` mints a `file → target` EXTRACTED
// edge. So when a connector observes `service → target` with no call site of its
// own, land the OBSERVED edge on the file that statically makes that call —
// but only when exactly one file in the service does, so the attribution is a
// fact, not a guess. Ambiguous (several call sites) or none → service-coarse,
// honestly (connectors.md — never fabricate a source).
function staticCallSiteFor(
  graph: NeatGraph,
  serviceName: string,
  targetNodeId: string,
): CallSite | undefined {
  if (!graph.hasNode(targetNodeId)) return undefined
  const sites: CallSite[] = []
  for (const edgeId of graph.inboundEdges(targetNodeId)) {
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    if (edge.provenance !== Provenance.EXTRACTED) continue
    const parsed = parseFileId(edge.source)
    if (!parsed || parsed.service !== serviceName || !edge.evidence) continue
    const site: CallSite = { relPath: edge.evidence.file }
    if (edge.evidence.line !== undefined) site.line = edge.evidence.line
    sites.push(site)
  }
  return sites.length === 1 ? sites[0] : undefined
}

// #803 — file-grain an *ingress* observation whose target is a RouteNode.
// `staticCallSiteFor` can't reach a route: routes.ts owns a route via
// `service ──CONTAINS──▶ route`, not a `file → route` call-site edge, so there
// is nothing inbound to attribute through. But the RouteNode already records
// its own definition site — `path` (the service-relative source file routes.ts
// parsed the route from) and `line`. So a connector that observes a route being
// hit (Cloudflare Workers, Firebase Hosting) file-grains onto that recorded
// site directly: the route's own source location, a fact the static pass
// already established, never a guess. This generalizes what railway/index.ts
// does per-connector — it reads `route.path`/`route.line` into the signal's own
// `callSite` in its map layer — into the shared pipeline, so every
// route-targeting connector file-grains the same way without duplicating the
// lookup. (Railway keeps setting its own `callSite`, which still wins below;
// this only covers connectors that resolve a route target but carry no
// callSite of their own.)
function routeCallSiteFor(graph: NeatGraph, targetNodeId: string): CallSite | undefined {
  if (!graph.hasNode(targetNodeId)) return undefined
  const attrs = graph.getNodeAttributes(targetNodeId) as { type?: string; path?: string; line?: number }
  if (attrs.type !== NodeType.RouteNode || !attrs.path) return undefined
  const site: CallSite = { relPath: attrs.path }
  if (attrs.line !== undefined) site.line = attrs.line
  return site
}

/**
 * One poll cycle: fetch, map, fuse, mint. Pure with respect to `ctx` — the
 * caller (`startConnectorPollLoop` below, or a one-shot `neat sync`) owns
 * advancing `ctx.since` between calls.
 */
export async function runConnectorPoll(
  connector: ObservedConnector,
  ctx: ConnectorContext,
  graph: NeatGraph,
  resolveTarget: ResolveConnectorTarget,
): Promise<ConnectorPollResult> {
  const signals = await connector.poll(ctx)
  let edgesCreated = 0
  let edgesUpdated = 0
  let unresolved = 0

  for (const signal of signals) {
    const resolved = resolveTarget(signal, ctx)
    if (!resolved) {
      unresolved++
      continue
    }

    // Honest-fallback declaration (§ResolvedConnectorTarget doc) — ensure the
    // InfraNode exists before the upsert below needs it to. Idempotent no-op
    // once the node is created on a later poll.
    if (resolved.ensureInfraNode) {
      const { kind, name, provider } = resolved.ensureInfraNode
      ensureInfraNode(graph, kind, name, provider)
    }

    // Same shape ingest.ts's handleSpan uses for every span: auto-create a
    // minimal ServiceNode the first time this service is seen so the edge
    // upsert below always has a source endpoint, even for a service the
    // static extractor hasn't reached (or never will, in an OTel-less setup).
    const serviceNodeId = ensureServiceNode(graph, resolved.serviceName, NO_ENV)

    // File-grain fusion when the signal carries a call site, through the
    // same reconcileObservedRelPath path OTel ingest uses (file-awareness.md
    // §4) — service-level, honestly, when it doesn't (§6, never fabricated).
    const callSite: CallSite | undefined = signal.callSite
      ? { relPath: signal.callSite.file, line: signal.callSite.line }
      : routeCallSiteFor(graph, resolved.targetNodeId) ??
        staticCallSiteFor(graph, resolved.serviceName, resolved.targetNodeId)
    const sourceId = callSite
      ? ensureObservedFileNode(graph, resolved.serviceName, serviceNodeId, callSite)
      : serviceNodeId
    const evidence = callSite
      ? {
          file: reconcileObservedRelPath(graph, resolved.serviceName, callSite.relPath),
          line: callSite.line,
        }
      : undefined

    // upsertObservedEdge increments its signal block by exactly one call per
    // invocation — the right unit for a single span, but a connector signal
    // is already an aggregate over the whole poll window (`callCount` calls,
    // `errorCount` of them failing). Replay it that many times so the
    // edge's spanCount/errorCount — and the confidence grade derived from
    // them, ADR-066 — land the same as if `callCount` individual spans had
    // arrived, rather than undercounting a batched signal down to +1.
    const calls = Math.trunc(signal.callCount)
    // A non-finite count (NaN/Infinity from a provider's shape drift) is
    // neither an observation nor an honest miss — drop it rather than letting
    // a zero-iteration loop below tally a phantom edge update (gate #8).
    if (!Number.isFinite(calls) || calls < 1) continue
    const errors = Number.isFinite(signal.errorCount)
      ? Math.min(Math.max(Math.trunc(signal.errorCount), 0), calls)
      : 0

    let created = false
    let ok = true
    for (let i = 0; i < calls; i++) {
      const result = upsertObservedEdge(
        graph,
        resolved.edgeType,
        sourceId,
        resolved.targetNodeId,
        signal.lastObservedIso,
        i < errors,
        evidence,
      )
      if (!result) {
        // Target node doesn't exist yet — an extractor gap (supabase.md
        // §Static extractor gap documents exactly this case) or a provider
        // that hasn't minted it. Honest miss, not a crash.
        ok = false
        break
      }
      if (i === 0) created = result.created
    }
    if (!ok) {
      unresolved++
      continue
    }
    if (created) edgesCreated++
    else edgesUpdated++
  }

  return { signalCount: signals.length, edgesCreated, edgesUpdated, unresolved }
}

export interface ConnectorPollLoopOptions {
  intervalMs?: number
  onError?: (err: unknown) => void
  // The connector's config-entry id (ADR-130). When set, every tick — success
  // and failure — is recorded to the in-process status tracker (status.ts) the
  // connector-status endpoint reads (ADR-136). A programmatic connector with no
  // id records nothing and never appears on that endpoint.
  connectorId?: string
}

const DEFAULT_POLL_INTERVAL_MS = 60_000

/**
 * Recurring wrapper around `runConnectorPoll` — the same setInterval +
 * unref + try/catch + stop-closure shape `startStalenessLoop` (ingest.ts)
 * already uses for the daemon's per-project background tasks, reused here
 * rather than reinvented. `daemon.ts` wires this in exactly where it wires
 * `startStalenessLoop`, tearing both down together per project slot.
 *
 * Advances `since` to the tick's own start time after every successful
 * poll — the next tick asks the provider for "since last tick" rather than
 * replaying. A tick that throws logs and leaves `since` where it was, so a
 * transient provider outage doesn't silently skip the gap once it recovers.
 */
export function startConnectorPollLoop(
  connector: ObservedConnector,
  ctx: ConnectorContext,
  graph: NeatGraph,
  resolveTarget: ResolveConnectorTarget,
  options: ConnectorPollLoopOptions = {},
): () => void {
  let stopped = false
  let since = ctx.since
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const connectorId = options.connectorId
  const onError =
    options.onError ??
    ((err: unknown) => console.error(`[neatd] connector poll failed (${connector.provider})`, err))

  const tick = (): void => {
    if (stopped) return
    void (async () => {
      const tickStartedAt = new Date().toISOString()
      try {
        const result = await runConnectorPoll(connector, { ...ctx, since }, graph, resolveTarget)
        since = tickStartedAt
        // Record the successful tick for the status endpoint (ADR-136). This is
        // additive to the poll — it never changes what the tick mints or how
        // `since` advances.
        if (connectorId) {
          recordConnectorPoll(connectorId, {
            outcome: 'ok',
            at: tickStartedAt,
            signalsLastPoll: result.signalCount,
          })
        }
      } catch (err) {
        onError(err)
        // The failed tick becomes a queryable fact instead of only a log line.
        // `sanitizePollError` keeps the recorded message short and secret-free.
        if (connectorId) {
          recordConnectorPoll(connectorId, {
            outcome: 'error',
            at: tickStartedAt,
            error: sanitizePollError(err),
          })
        }
      }
    })()
  }

  const interval = setInterval(tick, intervalMs)
  if (typeof interval.unref === 'function') interval.unref()
  return () => {
    stopped = true
    clearInterval(interval)
  }
}

/**
 * One project's registered connector, ready for `daemon.ts` to poll on an
 * interval. Deliberately thin — no config-loading or credential-broker logic
 * lives here (that's provider- and profile-specific, later work per
 * docs/contracts/connectors.md §3); this is just the seam a daemon slot
 * wires a connector through.
 */
export interface ConnectorRegistration {
  // The config-entry id this registration was built from, when it came from
  // ~/.neat/connectors.json (ADR-130). The daemon threads it into the poll loop
  // so every tick is recorded per-id for the connector-status endpoint
  // (ADR-136). Absent for a programmatic registration a caller passes directly.
  id?: string
  connector: ObservedConnector
  credentials: Record<string, unknown>
  resolveTarget: ResolveConnectorTarget
  intervalMs?: number
}

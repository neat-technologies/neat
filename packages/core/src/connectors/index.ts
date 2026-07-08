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

import type { EdgeTypeValue } from '@neat.is/types'
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
      : undefined
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
    if (calls < 1) continue // nothing observed this window — not even a miss
    const errors = Math.min(Math.max(Math.trunc(signal.errorCount), 0), calls)

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
  const onError =
    options.onError ??
    ((err: unknown) => console.error(`[neatd] connector poll failed (${connector.provider})`, err))

  const tick = (): void => {
    if (stopped) return
    void (async () => {
      const tickStartedAt = new Date().toISOString()
      try {
        await runConnectorPoll(connector, { ...ctx, since }, graph, resolveTarget)
        since = tickStartedAt
      } catch (err) {
        onError(err)
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
  connector: ObservedConnector
  credentials: Record<string, unknown>
  resolveTarget: ResolveConnectorTarget
  intervalMs?: number
}

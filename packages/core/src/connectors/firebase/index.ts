// The Firebase connector (docs/connectors/firebase.md, ADR-128) — third
// connectors-plane provider, after Supabase (ADR-124) and Railway (ADR-127).
//
// Scoped to Cloud Functions / Cloud Run / Firebase Hosting request logs only.
// Firestore and Firebase Auth are named non-goals (firebase.md §Scope — no
// least-privilege telemetry path exists for either, not merely unbuilt); this
// module never reads or references either surface.
//
// poll() pulls Cloud Logging's `entries.list` (logging-api.ts), filtered to
// entries carrying an `httpRequest`, and maps each one to an ObservedSignal
// (map.ts). Target resolution — matching a signal onto a statically-
// extracted RouteNode via the shared route-match.ts normalisation, or an
// honest miss when none resolves — lives in resolve.ts. Everything
// downstream of resolution (minting the OBSERVED edge) is the shared
// connectors/index.ts pipeline; this module never touches the graph
// directly (ADR-030).

import type { NeatGraph } from '../../graph.js'
import type { ConnectorContext, ObservedConnector, ObservedSignal } from '../types.js'
import type { ResolveConnectorTarget } from '../index.js'
import { fetchHttpRequestLogEntries, readFirebaseCredentials, DEFAULT_LOOKBACK_MS } from './logging-api.js'
import { mapLogEntriesToSignals } from './map.js'
import { createFirebaseResolveTarget, type FirebaseServiceMap } from './resolve.js'

export type { FirebaseCredentials, FirebaseResourceType } from './logging-api.js'
export type { FirebaseServiceMap } from './resolve.js'
export { createFirebaseResolveTarget } from './resolve.js'
export type { FirebaseTargetIdentity } from './map.js'
export { mapLogEntryToSignal, mapLogEntriesToSignals, packFirebaseTargetName, parseFirebaseTargetName } from './map.js'

export class FirebaseConnector implements ObservedConnector {
  readonly provider = 'firebase'

  async poll(ctx: ConnectorContext): Promise<ObservedSignal[]> {
    const creds = readFirebaseCredentials(ctx.credentials)
    const sinceIso = ctx.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString()
    const entries = await fetchHttpRequestLogEntries(creds, sinceIso)
    return mapLogEntriesToSignals(entries)
  }
}

/**
 * Wires up a ready-to-register Firebase connector: the `ObservedConnector`
 * plus the `resolveTarget` callback `runConnectorPoll` /
 * `startConnectorPollLoop` (connectors/index.ts) need alongside it. Both are
 * built together because `resolveTarget` closes over `graph` — the shared
 * scaffold's `ResolveConnectorTarget` signature (index.ts) never receives it
 * directly.
 */
export function createFirebaseConnector(
  graph: NeatGraph,
  serviceMap: FirebaseServiceMap,
): { connector: ObservedConnector; resolveTarget: ResolveConnectorTarget } {
  return {
    connector: new FirebaseConnector(),
    resolveTarget: createFirebaseResolveTarget(graph, serviceMap),
  }
}

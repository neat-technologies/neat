# Connectors plane

Governed by [`contracts/connectors.md`](../contracts/connectors.md) (ADR-124). This doc is the
implementation-level spec; the contract is the binding-rules summary.

## Why a second ingestion path

OTLP ingest requires the observed application to be instrumented — an SDK exporting spans.
That's the right default when NEAT controls the instrumentation story, but several
production platforms already run their own server-side telemetry independent of app code:
Supabase's Management API exposes request logs and query stats for a project regardless of
whether the app ever imports an OTel SDK; Vercel's own request logs and analytics work the
same way. A connector pulls that existing telemetry instead of waiting for a push. The two
paths are equally first-class members of the OBSERVED layer — a connector-sourced edge and a
span-sourced edge carry the same provenance, land through the same mutation primitives
(`otel-ingest.md` §Connector-sourced OBSERVED edges), and are indistinguishable to traversal,
divergence, and staleness.

## Provider interface

```ts
interface ObservedConnector {
  readonly provider: string
  poll(ctx: ConnectorContext): Promise<ObservedSignal[]>
}

interface ConnectorContext {
  projectDir: string          // for resolving static call sites during mapping
  credentials: ConnectorCreds // profile-scoped, never logged, never snapshotted
  since?: string              // ISO8601 — last successful poll's high-water mark
}

interface ObservedSignal {
  targetKind: string          // provider-defined: 'table', 'rpc', 'bucket', ...
  targetName: string          // provider-defined identity within targetKind
  callCount: number
  errorCount: number
  lastObservedIso: string     // the provider's own event time, never poll-arrival time
  callSite?: { file: string; line: number }  // present only when the provider signal
                                              // itself carries file/line (rare); usually
                                              // resolved by the mapping layer below, not here
}
```

`poll()` is the only method a provider must implement. Everything downstream —
turning an `ObservedSignal[]` into graph mutations — is shared, generic code:

```
poll() → ObservedSignal[]
   ↓
provider-specific mapping: targetKind/targetName → NEAT node id
   (this is the part that differs per provider; see each provider's own doc)
   ↓
shared fuse step: resolve a static call site for that node id if one exists
   (reuses the same call-site index static extraction already builds)
   ↓
shared mint step: upsertObservedEdge(...) — identical to the span-derived path
```

A provider module owns steps 1–2 (`packages/core/src/connectors/<provider>/`); `neatd` owns
steps 3–4 once, in `packages/core/src/connectors/index.ts`, calling the exact same
`upsertObservedEdge` / `reconcileObservedRelPath` primitives OTel ingest calls.

## Credential profiles

| | Local | Hosted |
|---|---|---|
| Runs on | developer's machine | NEAT-operated infrastructure |
| Credential source | developer's own, provided directly | brokered on the customer's behalf |
| Credential scope | whatever the developer already holds | narrowest read grant the provider's auth model allows — see each provider's doc for what that grant actually is |
| Poll cadence | on-demand (daemon tick / `neat sync`) | continuous, metered, fixed interval |
| Pull/map/fuse logic | identical | identical |

The hosted profile's least-privilege requirement is not aspirational — a provider whose
*only* read path for some signal is an unscoped, high-privilege credential means that signal
is out of scope for the hosted profile until the provider exposes something narrower, even
if the local profile can use it today (the developer already holds the broad credential for
their own project; NEAT holding it on their behalf on shared infrastructure is the different,
disqualifying risk).

## Poll cadence and backfill

Every provider's log/telemetry API bounds how far back a single query can look (a connector
must never assume unbounded lookback). `since` is the connector's own high-water mark, capped
by the provider's maximum window; a gap larger than that window (a laptop off for a week) is
an honest, bounded backfill from `now - maxWindow`, not a full-history replay.

## Providers

- [Supabase](./supabase.md) — first provider, ADR-124.
- [Railway](./railway.md) — second provider, ADR-127.
- [Firebase](./firebase.md) — third provider, ADR-128; scoped to Cloud Functions, Cloud Run,
  and Firebase Hosting.
- Vercel — next; no spec yet.

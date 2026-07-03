# Firebase connector

Third implementation of the [connectors plane](./README.md) (ADR-128), following the
hosting-platform pattern [ADR-127](../decisions.md#adr-127--the-railway-connector)
established for Railway. Pulls Cloud Logging's request-log signal for the surfaces where
Firebase's own code runs on Google's infrastructure — Cloud Functions, Cloud Run, and
Firebase Hosting — and fuses it onto the `RouteNode`s `packages/core/src/extract/routes.ts`
already resolves, at file grain where an Express app is recognizable.

## Scope

- **Hosting-platform half only.** Firebase splits architecturally into two shapes: a
  client-SDK half (Firestore, Realtime Database, Auth, Storage — the same shape Supabase's
  connector targets) and a hosting-platform half (Cloud Functions, Cloud Run, Firebase
  Hosting — the same shape Railway's connector targets, since 2nd-gen Cloud Functions run on
  Cloud Run as their execution substrate). This connector covers the hosting-platform half
  only. The client-SDK half is not a future phase of this same connector — see Out of scope
  below for why each piece there is a named non-goal or a separately-scoped deferral, not a
  todo.
- **Firestore and Firebase Auth are non-goals, not scope convenience.** Firestore's Cloud
  Monitoring metrics are database-aggregate with zero collection-level dimension — worse than
  even Supabase's aggregate-only Metrics API, which this connector's design already ruled out
  for the same reason. Firestore's only read-only predefined IAM role,
  `roles/datastore.viewer`, grants actual document access rather than usage statistics, so
  there is no least-privilege telemetry-only role for Firestore at all — the credential
  problem, not just the signal-shape problem, rules it out. Firebase Auth has essentially no
  audit trail on the free tier, and even the paid Identity Platform upgrade excludes routine
  sign-in events. These are documented here so a future contributor doesn't re-survey the same
  dead end.
- **Cloud Storage and Realtime Database are deferred to a later, separately-scoped cut.**
  Unlike Firestore/Auth, these genuinely have per-path signal: GCS Data Access audit logs
  carry `storage.objects.get` with the object path, and RTDB's carry operation + path — both
  matchable against static `ref(storage, 'path')` / `ref(db, 'path')` literals the way
  Supabase's `infra:supabase-table` node matches a `.from('orders')` literal
  (`docs/connectors/supabase.md`). Held back because (a) that audit logging is opt-in and
  Google's own docs flag it as high-volume and cost-bearing, not a default-on signal, and
  (b) fusing it needs a new client-SDK-shape extractor — a `firebase.ts` analogous to
  `extract/calls/supabase.ts` — which is a scoping exercise of its own, not a rider on this
  connector's v1.

## Surfaces used

### Cloud Logging `entries.list`, filtered to `httpRequest` (both profiles)

Cloud Functions (2nd gen) and Cloud Run structured request logs carry a full `httpRequest`
object — method, path, status, latency — on the `cloud_function` and `cloud_run_revision`
monitored resource types (`cloud.google.com/monitoring` /
`cloud.google.com/logging` docs). Firebase Hosting adds its own request logging,
`webrequests`, on the `firebase_domain` monitored resource — this is opt-in per site but
real and per-path, which refutes a "static CDN, no telemetry" assumption someone might
otherwise bring to a hosting connector. `poll()` runs `entries.list` against these resource
types, filtered to entries carrying `httpRequest`, since the last high-water mark.

- **Auth (both profiles):** GCP predefined IAM roles — `roles/monitoring.viewer`,
  `roles/logging.viewer`, `roles/cloudfunctions.viewer`, `roles/firebasehosting.viewer`.
  These are genuinely metrics/logs-only with no path to customer data, so unlike Supabase's
  `pg_stat_statements` gap (`docs/connectors/supabase.md`), there is no Fork-A-style
  local/hosted split to resolve here — both profiles use the same narrow grant from day one.
- **Poll cadence:** on-demand for local (daemon tick / `neat sync`); fixed interval for
  hosted, candidate value needs-endpoint-testing against `entries.list`'s live rate limits and
  Cloud Logging's own ingest latency before locking in a number.
- **No native OTel emission.** Google Cloud is an OTel sink (via the Cloud Trace/Monitoring
  OTLP endpoints), not a source — nothing in Cloud Functions, Cloud Run, or Firebase Hosting
  emits OTel on its own. An app that wants push-based traces still has to instrument and
  export itself, same as any other unobserved app; this connector's pull path is what closes
  the gap for apps that haven't. Noted here as a survey finding this connector's existence
  doesn't change, not a constraint the connector works around.

## Fusion — node identity

Fusion targets the existing `RouteNode`, the same hosting-platform-fusion pattern ADR-127
established for Railway (`docs/connectors/README.md` §Provider interface, step 3): resolve a
static call site if one exists, mint file-grained; fall back honestly to service-level
attribution when none does.

- **Express-wrapped function (the common case):** `functions.https.onRequest(app)` handing an
  Express app to a Cloud Function is the dominant real-world pattern for anything beyond a
  single-route function. `packages/core/src/extract/routes.ts`'s existing Express recognizer
  already resolves the route from that `app`, so a Cloud Logging `httpRequest` entry whose
  path matches a known route template lands as a file-grained OBSERVED `CALLS` edge on that
  `RouteNode` — no new extractor work needed for this shape.
- **Raw handler, no Express app:** a bare `onRequest((req, res) => ...)` or `onCall(...)`
  handler has no Express route for `routes.ts` to have already resolved. The connector falls
  back to function-name/service-level attribution, honestly — the same missing-extracted gap
  every OBSERVED surface in NEAT already surfaces rather than papers over. Closing this gap
  would need a `firebase-functions`-specific static recognizer (parsing `onRequest`/`onCall`
  handler bodies for path-shaped routing of their own, where present); that recognizer is a
  future, separately-scoped static-extraction addition, not part of this connector's v1.

No new `NodeType` — this is additive schema growth onto the `RouteNode` fusion pattern
ADR-127 already established, the same way GraphQL operations and gRPC methods extended the
graph without a new node type (ADR-122, ADR-123).

## Testing constraint

The Firebase Local Emulator Suite has zero telemetry parity with production — Firebase's own
docs describe it as unsuitable for production use, with no relationship to Cloud Monitoring
or Cloud Logging. Connector tests therefore need a real GCP project fixture, the same shape
`docs/contracts/observed-e2e.md` already accepts for Brief, rather than an emulator-backed
fixture. Stated plainly here rather than promising an emulator-based test suite that the
emulator's own design can't support.

## Out of scope for this cut

Firestore and Firebase Auth (named non-goals, see Scope above — no least-privilege telemetry
path exists for either, not merely unbuilt). Cloud Storage and Realtime Database (deferred to
a later, separately-scoped cut — real per-path signal exists but needs opt-in audit logging
plus a new client-SDK-shape extractor). Native OTel emission (Google Cloud has no OTel source
surface for these products today; an instrumented app already gets full fidelity over the
push path this connector doesn't touch).

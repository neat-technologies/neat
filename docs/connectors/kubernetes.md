# Kubernetes deploy-state connector

The second incident-emitting implementation of the [connectors plane](./README.md) (#1124), after
EAS ([ADR-185](../decisions.md#adr-185--eas-build-failures-as-observed-commit-grain-incidents-on-the-repo)).
It pulls read-only Kubernetes cluster state and mints an OBSERVED incident on a service node when a
workload is down for a **deployment** reason — a bad image, zero replicas, a crashloop.

## Why

NEAT sees what's instrumented. It goes blind when a service is down because of its deployment: a
dead pod emits no spans, so a `ImagePullBackOff`, a `replicas: 0`, or a `CrashLoopBackOff` is
invisible to the graph — even though it's the whole reason a caller's requests fail. This connector
reads that state straight from the cluster and turns each fault into a first-class OBSERVED incident
on the affected service node, fused with the code deps and the observed connection-refused edges
already there — so an agent root-causes the outage from the graph instead of reaching for `kubectl`.

## Scope

- **Target: the Kubernetes REST API, read-only, one namespace.** `GET` on `apps/v1` Deployments and
  `core/v1` Pods — the two objects that together yield all three faults. No writes, no synthetic
  workloads, no probes (connectors.md §2). Read-only RBAC only: `get`/`list` on deployments + pods.
- **Incident-emitting, not edge-counting.** Like EAS, an unhealthy workload maps to a
  `ConnectorIncident`-bearing signal the shared pipeline writes as an OBSERVED incident
  (`get_incident_history` / `get_root_cause` read it), not a traffic edge. A healthy workload mints
  nothing in v1 — the value is the faults a dead pod can't report.
- **Both credential profiles.** Local: the same access `kubectl` has (a kubeconfig). Hosted: an
  in-cluster service-account token + the API-server URL. The read-only grant reaches cluster state,
  never application data.

## Surfaces used

### Deployments + Pods, one namespace (read-only)

Every field is a stable part of the Kubernetes API, confirmed against the API reference
(ADR-150/152 discipline):

- **Deployments** — `GET /apis/apps/v1/namespaces/<ns>/deployments`. Reads `spec.replicas` (desired),
  `status.readyReplicas`, and `spec.selector.matchLabels` (to find the workload's pods).
- **Pods** — `GET /api/v1/namespaces/<ns>/pods`. Reads `status.containerStatuses[]`:
  `state.waiting.reason` (`ImagePullBackOff` / `ErrImagePull` / `CrashLoopBackOff`),
  `lastState.terminated.reason`/`.message`/`.exitCode` (the crash line), `restartCount`, and `image`.
- **Transport.** The k8s API server presents a cluster-CA-signed (or self-signed) cert, and kind-style
  access authenticates with a client cert — so the outbound call uses a Node `https` agent (native
  `ca`/`cert`/`key`) wrapped as a `fetchImpl` and routed through the shared junction for the
  timeout/retry/rate-limit discipline every connector holds (ADR-131). No k8s SDK, no new dependency.

## Credential + least privilege

`credentials` carries the secret-bearing auth — a bearer token (`{ token }`, paired with
`options.apiServerUrl`) or a kubeconfig (`{ kubeconfig }`, a path or inline YAML whose current
context supplies the server, CA, and auth). Non-secret transport config (`apiServerUrl`, `caCert`,
`insecureSkipTlsVerify`, `namespace`, `serviceMap`) rides in `options`. The token flows into
`Authorization: Bearer` and the client key into the TLS agent, and nowhere else — never logged,
never written into a node/edge or the snapshot (connectors.md §6). Grant a read-only ClusterRole /
Role scoped to `get`/`list` on `deployments` + `pods` and nothing more.

## Fusion — node identity

A workload maps to its NEAT service by name: an explicit `options.serviceMap` wins (for when a
deployment's name doesn't equal the OTel `service.name` the extractor keyed on), else the deployment
name itself. The incident anchors on that service's `ServiceNode`, resolved through the same
fused-service lookup the OTLP incident path uses (`resolveFusedServiceId`), so it lands on the node
the extractor produced — one node carrying both the code deps and this OBSERVED deploy fault, never
a connector-minted twin. A deployment fault is service-wide (the image, the replica count, the crash
are not route- or file-scoped), so the ServiceNode is the honest grain.

## The faults it mints

| Signal | Fault | Incident |
|---|---|---|
| a container `waiting.reason` is `ImagePullBackOff` / `ErrImagePull` | `image-pull` | "cannot pull image `<tag>`" |
| `spec.replicas: 0` | `scaled-to-zero` | "scaled to 0 — no running pods" |
| a container `waiting.reason` is `CrashLoopBackOff` | `crash-loop` | "crashlooping (restarts: N); last terminated: `<reason>` — `<message>`" |
| desired > 0, ready 0, no pod names a cause | `no-ready-replicas` | "no ready replicas (desired N, ready 0)" |

The incident id is stable per `(namespace, deployment, fault)`, so re-polling the same fault collapses
to one incident on read (`dedupeIncidents`) and a changed fault mints a distinct one. The failure line
and cluster context (image, restart count, last-termination reason/message, desired/ready replicas)
ride in the incident attributes for an agent to read.

## Out of scope for this cut

- **Endpoints / EndpointSlices and Events.** `spec.replicas` and `readyReplicas` already yield the
  scaled-to-zero and down states directly; the ready-endpoint count and the `ScalingReplicaSet` /
  `BackOff` event lines are corroborating detail (and the precise scaled-at time) — a follow-on that
  adds an endpoint read and an event read to the same poll, not a new connector.
- **Healthy-workload deploy state.** Emitting a light OBSERVED "deploy state" (image, desired/ready)
  for a healthy workload is a follow-on; v1 is focused on the incidents.
- **StatefulSets / DaemonSets / Jobs, and cross-namespace reads.** One namespace, Deployments-first;
  the other workload kinds and multi-namespace are additive widenings on the same shape.
- **Any write to the cluster.** Read-only, always (connectors.md §2).

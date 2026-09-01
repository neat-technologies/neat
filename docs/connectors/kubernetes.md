# Kubernetes deployment substrate

Kubernetes is **not** a `neat connector` vendor. It is ubiquitous deployment infrastructure — one API GKE / EKS / AKS / kind all speak — with two sides NEAT cares about: a **declared** side (the repo's manifests: desired image, desired replicas, workload→service) and an **observed** side (live cluster state). The divergence between them — declared image ≠ running image, declared replicas ≠ ready — is NEAT's core value, and it is why Kubernetes earns first-class *substrate* treatment rather than a slot in the vendor connector list (#1124, ADR-224).

This doc covers the **observed** leg: a read-only reader of live cluster state that turns deployment faults into OBSERVED incidents. The declared leg (a static manifest extractor) and the declared/observed divergence are the substrate's other legs.

## Why the observed leg exists

NEAT sees what's instrumented, so it goes blind when a service is down for a *deployment* reason — a bad image, zero replicas, a crashloop — because the dead pod emits no spans. The bench proved it: graph-only NEAT scored 0–2/5 on those faults while an agent with `kubectl` read the cause straight from cluster state and got 5/5. The observed reader pulls that state into the graph so the fault becomes a first-class OBSERVED incident on the service node, fused with the code deps and the observed connection-refused edges already there.

The observed reader by design sees only **outages** (a pod actually down). A *stuck rollout* — a bad image that never took, the old ReplicaSet still serving — is not an outage and mints nothing here; that case is precisely the declared-image ≠ running-image divergence the declared leg + join cover. The two legs are complementary: outages from observed, silent bad-deploys from the divergence.

## Enabled off a substrate surface, not `neat connector`

Because Kubernetes is not a vendor, its reader is **not** in `PROVIDER_DISPATCH` and has no `neat connector add` entry. It is enabled off a dedicated config, `~/.neat/k8s.json` (machine-level, same env-ref-by-default / `0600` / no-secret-at-rest discipline as `connectors.json`), which the daemon reads at slot bootstrap and runs through the **reused** connector poll/incident plumbing (`startConnectorPollLoop`, the junction, the incident pipeline). Entry shape:

```jsonc
{
  "version": 1,
  "deployments": [
    {
      "id": "otel-demo",
      "project": "<registered project name>",     // omitted binds to the bootstrapping project
      "credential": { "kubeconfig": "$KUBECONFIG" }, // or a bearer token: "$KUBE_SA_TOKEN"
      "namespace": "otel-demo",
      "serviceMap": { "productcatalogservice": "product-catalog" }, // only if names differ
      "expectedZero": ["load-generator"],           // intentionally scaled-0 workloads (no false incident)
      "insecureSkipTlsVerify": false                 // dogfood escape hatch for a self-signed local cluster
    }
  ]
}
```

## Reads: Deployments + Pods, one namespace (read-only)

Every field is a stable part of the Kubernetes API, confirmed against the API reference (ADR-150/152 discipline):

- **Deployments** — `GET /apis/apps/v1/namespaces/<ns>/deployments`. Reads `spec.replicas` (desired), `status.readyReplicas`, `spec.selector.matchLabels`.
- **Pods** — `GET /api/v1/namespaces/<ns>/pods`. Reads `status.containerStatuses[]`: `state.waiting.reason` (`ImagePullBackOff` / `ErrImagePull` / `CrashLoopBackOff`), `lastState.terminated.reason`/`.message`/`.exitCode`, `restartCount`, `image`.
- **Transport.** The API server presents a cluster-CA-signed (or self-signed) cert, and kind-style access authenticates with a client cert — so the read uses a Node `https` agent (native `ca`/`cert`/`key`) wrapped as a `fetchImpl` and routed through the shared junction for the timeout/retry/rate-limit discipline. No k8s SDK, no new dependency; the `yaml` dep already in the tree parses the kubeconfig.

## Credential + least privilege

`credential` carries the secret-bearing auth — a bearer token (a read-only service-account token, the hosted / in-cluster path), or a kubeconfig (a path or inline YAML whose current context supplies server + CA + auth). The token flows into `Authorization: Bearer` and the client key into the TLS agent, and nowhere else — never logged, never written into a node/edge or the snapshot. Grant a read-only Role/ClusterRole scoped to `get`/`list` on `deployments` + `pods` and nothing more.

## Fusion — node identity

A workload maps to its NEAT service by name: an explicit `serviceMap` wins (for when a deployment's name doesn't equal the OTel `service.name` the extractor keyed on), else the deployment name. The incident anchors on that service's `ServiceNode`, resolved through the same fused-service lookup the OTLP incident path uses (`resolveFusedServiceId`) — the node the extractor produced, never a twin. A deployment fault is service-wide (the image, the replica count, the crash are not route- or file-scoped), so the ServiceNode is the honest grain. *(Live-verified on a kind cluster running the OpenTelemetry Demo: the demo's deployment names matched the extracted service nodes, so no `serviceMap` was needed.)*

## The faults it mints

| Signal | Fault | Incident |
|---|---|---|
| a container `waiting.reason` is `ImagePullBackOff` / `ErrImagePull` | `image-pull` | "cannot pull image `<tag>`" |
| `spec.replicas: 0` (and not in `expectedZero`) | `scaled-to-zero` | "scaled to 0 — no running pods" |
| a container `waiting.reason` is `CrashLoopBackOff` | `crash-loop` | "crashlooping (restarts: N); last terminated: `<reason>` — `<message>`" |
| desired > 0, ready 0, no pod names a cause | `no-ready-replicas` | "no ready replicas (desired N, ready 0)" |

The incident id is stable per `(namespace, deployment, fault)`, so re-polling the same fault collapses to one incident on read (`dedupeIncidents`) and a changed fault mints a distinct one. `expectedZero` suppresses `scaled-to-zero` for a workload intentionally at zero (a demo load-generator, a paused job) — but a real image-pull / crashloop on one of those still reports.

## Out of scope for the observed leg

- **The declared leg + divergence.** Reading the repo's manifests (desired image / replicas / workload→service) as EXTRACTED, and joining declared vs observed into a divergence, are the substrate's other legs — the payoff and the reason k8s is first-class.
- **Endpoints / EndpointSlices and Events.** `spec.replicas` and `readyReplicas` already yield the scaled/down states; the ready-endpoint count and the `ScalingReplicaSet` / `BackOff` event lines (and the precise scaled-at time) are a follow-on that adds an endpoint read and an event read to the same poll.
- **Healthy-workload deploy state, StatefulSets / DaemonSets / Jobs, cross-namespace reads.** Additive widenings on the same shape.
- **Any write to the cluster.** Read-only, always.

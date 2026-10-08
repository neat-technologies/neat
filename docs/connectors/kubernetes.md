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
- **Pods** — `GET /api/v1/namespaces/<ns>/pods`. Reads `status.containerStatuses[]`: `state.waiting.reason` (`ImagePullBackOff` / `ErrImagePull` / `CrashLoopBackOff`), `lastState.terminated.reason`/`.message`/`.exitCode`, `restartCount`, `image`; and — for a faulted workload's process-&-config fusion (ADR-237) — `spec.containers[].{command, args, env}`.
- **Pod logs** — `GET /api/v1/namespaces/<ns>/pods/<name>/log?container=<c>&tailLines=N&previous=true`, **only for the pod of a crash-looped workload** (ADR-237). `previous=true` is essential: it returns the *last terminated instance's* stdout — the traceback / panic / OOM line — rather than the empty current one. The endpoint returns text, routed through the same junction the list reads use. A missing `pods/log` RBAC grant (403) degrades honestly: the incident still mints, only the process-log attribute is dropped.
- **Transport.** The API server presents a cluster-CA-signed (or self-signed) cert, and kind-style access authenticates with a client cert — so the read uses a Node `https` agent (native `ca`/`cert`/`key`) wrapped as a `fetchImpl` and routed through the shared junction for the timeout/retry/rate-limit discipline. No k8s SDK, no new dependency; the `yaml` dep already in the tree parses the kubeconfig.

## Process & config fusion — the OBSERVED "why" of a pre-span failure (ADR-237)

A workload that fails BEFORE it emits its first span — a crash-loop, a bootstrap hang, an OOM, a panic-on-boot, a wrong config value — leaves its cause in two places a span can't carry: the process stdout (the traceback the dying process printed) and the container's env/args. For a **faulted** workload the reader fuses both onto the incident the fault already mints, OBSERVED, as three attributes on the incident's `attributes` bag (so they flow to `get_incident_history` / `get_root_cause` unchanged):

- `k8s.processLog` — the last-terminated stdout tail (`previous=true`), kept to ~50 lines / ~2 KB (the cause sits at the end, so the tail is kept). Crash-loops only; an image-pull container never ran, so there's no log.
- `k8s.containerArgs` — the container's `command` + `args`, redacted.
- `k8s.containerEnv` — the container's env, each `NAME=value` **redacted**: a secret-keyed value (`*TOKEN*` / `*SECRET*` / `*KEY*` / `*PASSWORD*`) is masked whole; a credential URL (`scheme://user:pass@host`) has its inline password masked by shape; a `valueFrom` is captured as a reference descriptor only (`<from configMap <name> key <key>>` / `<from secret <name>>`) and **never resolved** — no ConfigMap or Secret is read, so a secret's value never enters NEAT.

A healthy workload mints nothing here, as always. This is live OBSERVED runtime state on the incident ledger — redacted, never a ConfigNode, never a persisted node attribute — the one carve-out from the "never write .env contents" rule, recorded in ADR-237 and noted in `connectors.md` §6/§10.

## Credential + least privilege

`credential` carries the secret-bearing auth — a bearer token (a read-only service-account token, the hosted / in-cluster path), or a kubeconfig (a path or inline YAML whose current context supplies server + CA + auth). The token flows into `Authorization: Bearer` and the client key into the TLS agent, and nowhere else — never logged, never written into a node/edge or the snapshot. Grant a read-only Role/ClusterRole scoped to `get`/`list` on `deployments` + `pods`, plus `get` on `pods/log` for the process-&-config fusion (ADR-237), and nothing more. The `pods/log` grant is a sharpener, not a hard dependency: without it the incident still mints, only the process-log attribute is dropped (403 degrades honestly).

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

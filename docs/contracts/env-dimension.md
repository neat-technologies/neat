---
name: env-dimension
description: Environment is a dimension of runtime evidence, not part of a code node's identity (ADR-280). A service static extraction knows is one node whatever environments run it; OBSERVED, INFERRED and STALE edges and incidents carry the environment, and a runtime edge id includes it. `deployment.environment(.name)` is read span-attr → resource-attr → `unknown` and normalised once at ingest (trim, lower-case). `unknown` is written as absence, so an unlabelled graph is byte-identical to before. Snapshot v10 → v11 folds env-tagged service twins. Built so far is slice one, the evidence; env-scoped reads, the default environment, and per-environment divergence, policies and baseline are not built yet.
governs:
  - "packages/types/src/identity.ts"
  - "packages/core/src/ingest.ts"
  - "packages/core/src/ingest"
  - "packages/core/src/otel.ts"
  - "packages/core/src/extract"
  - "packages/core/src/persist.ts"
adr: [ADR-280, ADR-074, ADR-028, ADR-031, ADR-066]
enforcement: [lint, review]
---

# Env-dimension contract

OTel spans carry `deployment.environment.name`, which tells production traffic from staging traffic on the same `service.name`. ADR-280 rules where that value lives: on the evidence, never on the code. A service, file, symbol or route extracted from source is one node, whatever environments run it. What production and staging did with that code is held apart on the runtime edges and the incidents, so a failure in staging lands on staging's evidence and production's answers stay production's.

ADR-280 amends ADR-074 §1, which made a service a distinct node per environment. That rule held only for a service static extraction never found, and #880 / #988 had already stopped ingest applying it to an extracted one. This contract now says what the code does.

ADR-280 is built in slices. **Slice one, built:** the evidence carries its environment (§1 to §6). **Not built yet:** every read that should take an environment (§7). Until §7 lands, no query reads `env`, and for a project whose telemetry is in one environment every answer is the one it was before slice one.

## 1. Code nodes have no environment

A node minted from source has no environment in its id or its attributes. File, symbol, route, GraphQL operation, WebSocket channel, server action, database, config and infra ids are env-less, and so is a ServiceNode static extraction found.

Ingest never mints `service:<name>:<env>` for a service static extraction knows. `resolveFusedServiceId` (`ingest/service.ts`) attaches a span to the extracted ServiceNode whatever environment the span names: the env-less `service:<name>` first, then the exact `service:<name>:<env>` if it exists, then any non-OTel ServiceNode whose name matches case-insensitively. A twin an older daemon left beside an extracted node of the same name is skipped, never reused, and the migration (§5) folds every twin on load. One gap stays until the next load: an OTel-only `service:orders:staging` minted in this run, before extraction found a differently-cased `Orders`, keeps receiving staging's spans, because checking for that case on every span would scan the graph per span.

A service NEAT has only seen at runtime (no extracted node to fuse onto) keeps the ADR-074 form: `serviceId(name, env)` gives `service:<name>:<env>` for a named environment and `service:<name>` for `unknown`. That node carries `discoveredVia: 'otel'` and its `env`. Static extraction does not know it, so there is no code node for it to share.

## 2. The environment value is read once and normalised once

At ingest (`otel.ts`, `pickEnv`) the environment is the first non-empty of:

1. span attribute `deployment.environment.name`
2. span attribute `deployment.environment`
3. resource attribute `deployment.environment.name`
4. resource attribute `deployment.environment`

and `unknown` when none is present.

The value is then normalised by `normalizeEnv` (`@neat.is/types`), once, at that point: trimmed and lower-cased, with nothing else rewritten (ADR-280 §9). `Prod` and `prod` are one environment; `prod` and `production` are two. A value that is empty after trimming, or is not 1 to 64 characters of `[a-z0-9._-]` starting with a letter or digit, is `unknown`, since an edge id has to carry it. Every consumer reads `span.env` as already normalised; nothing downstream normalises again.

`unknown` is an environment like any other and is never merged into another (ADR-280 §5). Every connector signal is `unknown` until that connector says otherwise.

## 3. Runtime edges carry the environment

An OBSERVED or INFERRED edge is one per `(type, source, target, env)`. The same call site seen in production and in staging is two edges on the same two nodes, and their `callCount`, `signal` counters, latency and last-error exemplar never merge.

- The edge carries `env` as an attribute.
- Its id carries it in the provenance segment: `CALLS:OBSERVED@staging:file:orders:src/pay.ts->service:billing`, built only by `observedEdgeId` / `inferredEdgeId` and read back by `parseEdgeId` ([provenance.md](./provenance.md)).
- A STALE edge is an OBSERVED edge after the staleness transition and keeps its id, so it keeps its environment.
- **`unknown` is written as absence:** no `env` attribute and the env-less id (`CALLS:OBSERVED:...`). Every graph built from unlabelled telemetry, which is every local project that has not set an environment, is byte-identical to one built before ADR-280.

The ingest sites that mint runtime edges (`ingest/peer.ts`, `serving.ts`, `database.ts`, `messaging.ts`, `route.ts`, `flag-evaluations.ts`) pass `span.env` to `upsertObservedEdge`. The trace stitcher mints its INFERRED edges in the failing span's environment, and suppresses one only when an OBSERVED edge in that same environment already covers the hop. FRONTIER edges carry no environment: a frontier proposal is not runtime evidence.

The structural `CONTAINS` edges ingest mints to hang an observed-only file or symbol under its service carry no environment either: they record ownership, not something that ran.

## 4. Incidents carry the environment

An `ErrorEvent` has an optional top-level `env`, set from the span's environment on every incident `handleSpan` and the receiver write. `unknown` is absence, as on edges, so a past incident with no `env` reads as `unknown` (ADR-280 §10).

A 4xx burst is per `(service, environment, peer)`: staging's run of 404s and production's are two bursts, never one coalesced incident.

## 5. Snapshot migration v10 → v11

`migrateV10ToV11` (`persist.ts`) brings a snapshot an older daemon wrote onto this shape:

- An env-tagged ServiceNode twin (`discoveredVia: 'otel'`, an `env`) beside an extracted ServiceNode of the same name (matched case-insensitively) is folded into the extracted node. When two extracted services share that name the fold cannot choose, and the twin is left as it is. Each of its OBSERVED, INFERRED and STALE edges is re-pointed at the extracted node and re-keyed with the twin's normalised environment. Where the re-keyed id already exists, the two edges merge: counters add, the later `lastObserved` wins.
- An OTel-only ServiceNode whose `env` is not normalised moves to its normalised id (`service:search:Prod` → `service:search:prod`), its edges with it.
- Every other edge keeps its id. An existing OBSERVED edge with no environment is already the `unknown` edge.

The step is idempotent. `SCHEMA_VERSION` is 11 ([persistence.md](./persistence.md)). Incidents in `errors.ndjson` are not rewritten: one whose `affectedNode` names a folded twin keeps that id.

## 6. ServiceNodes carry a `framework:` field

Unchanged from ADR-074. Static extraction records

```
framework: 'next' | 'remix' | 'sveltekit' | 'nuxt' | 'astro' | 'node' | 'python' | undefined
```

on the ServiceNode, aligned with the JS installer's detection ([framework-installers.md](./framework-installers.md)). It is enrichment, never identity, and `undefined` when the extractor cannot tell.

## 7. Reading runtime evidence for one environment

- **The accessor** (ADR-280 decision 3): `packages/core/src/runtime-env.ts`. `runtimeEdgesIn(graph, edgeIds, env)` returns only that environment's OBSERVED, INFERRED and STALE edges; it has no form that returns every environment's together. `isRuntimeEdgeIn`, `edgeEnv`, `hasObservedIn` and `runtimeEnvironments(graph)` sit beside it. `getObservedDependencies` and the stitcher's OBSERVED-twin check read through it. Staleness needs no environment: it ages each runtime edge on its own, and each environment's evidence is its own edge.
- **The default environment** (decision 4, ruling (c)): `resolveEnvironment(graph, { env?, productionEnv? })`. The named environment; else the project's production environment if the graph has evidence in it; else the only environment present (`unknown` for a project with no environment labels); else a refusal that lists them (`EnvironmentRequiredError`, code `environment_required`). The project's production environment is `productionEnv` in `<project>/.neat/environments.json`, starting as `production` when the file or the field is absent (`project-environments.ts`). An answer that reads runtime evidence carries `env` for the environment it is for, absent for `unknown`.
- **Policies per environment** (decision 7): see [`policy-evaluation.md`](./policy-evaluation.md).

## 8. Not built yet

ADR-280 decides these; no code does them yet, and nothing above should be read as if it did.

- **The other runtime reads taking an environment**: divergences, root cause, blast radius over observed edges, the incident card and incident lists, and the security card's observed step. Until then those reads see every environment's edges, so in a project with several environments their answers can mix them.
- **Divergence per environment** (§6), with the environment in a divergence's identity and in the ADR-279 finding id.
- **The healthy baseline per environment** (§8).
- **Runtime attributes on a static node held per environment** (§2): a service's observed image, replicas and similar still have one value.
- **A Kubernetes namespace as an environment only when configured** (ruling (a)).
- **REST `env` parameters, MCP tools taking an optional environment** (ruling (d)), and the web UI. Until then REST reads answer for the default environment and say which.

## Authority

- `packages/types/src/identity.ts`: `normalizeEnv`, `ENV_UNKNOWN`, `serviceId(name, env?)`, the environment segment in `observedEdgeId` / `inferredEdgeId`, and `parseEdgeId`.
- `packages/types/src/edges.ts`, `events.ts`: the optional `env` on an edge and on an `ErrorEvent`.
- `packages/core/src/otel.ts`: reading and normalising the environment.
- `packages/core/src/ingest/`: `resolveFusedServiceId`, the edge minting sites, the stitcher call, incident stamping and the burst key.
- `packages/core/src/persist.ts`: `migrateV10ToV11`, `SCHEMA_VERSION = 11`.
- `packages/core/src/runtime-env.ts`: the runtime-edge accessor, `resolveEnvironment`, `EnvironmentRequiredError`. `runtime-view.ts`: the per-environment and static views policy evaluation reads. `project-environments.ts`: `readProductionEnv`.

## Enforcement

`packages/core/test/env-evidence.test.ts` covers normalisation, the id grammar, ingest splitting one hop into an edge per environment, incidents, the stitcher, the no-twin rule, the per-environment burst, and the migration. `packages/core/test/env-evidence-answers.test.ts` holds the proof that no query answer changed for a single-environment project: answers recorded on `main` before slice one (`fixtures/env-evidence-answers.json`), compared byte for byte, and the two-environment proof: asked for one environment (or by default, for production), observed dependencies and policy violations equal that environment's answer alone, no answer lists a fact twice, and the ledger form names each environment with no id shared. `contracts.test.ts` pins the id round-trip and `SCHEMA_VERSION`.

Full rationale: [ADR-280](../decisions.md#adr-280--environment-is-a-dimension-of-runtime-evidence-not-part-of-a-code-nodes-identity), amending [ADR-074](../decisions.md#adr-074--neat-sync-env-dimension-at-ingest-framework-installer-paths).

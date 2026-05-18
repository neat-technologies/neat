# Decisions

Append-only ADR log. Each entry: what was decided, why, and the date. New decisions go to the bottom.

For the process — when to write an ADR, what shape, how supersession works, who ratifies — see [`docs/adr/README.md`](./adr/README.md). The starting shape for a new ADR is [`docs/adr/template.md`](./adr/template.md).

---

## ADR-001 — Monorepo with pnpm + Turborepo

**Date:** 2026-04-30  
**Status:** Superseded by ADR-007.

Original decision: pnpm 9 with `shamefully-hoist=true` workspaces, Turborepo for the task graph. Rationale was disk-store dedup and per-package filtering.

---

## ADR-002 — tree-sitter native bindings, not web-tree-sitter

**Date:** 2026-04-30  
**Status:** Active.

The seed design doc proposed `web-tree-sitter`. We're going with the native `tree-sitter` + `tree-sitter-javascript` + `tree-sitter-typescript` packages instead.

Reason: extraction runs in Node only, so the WASM loader and async init `web-tree-sitter` requires buy us nothing. Native bindings are faster, simpler, and don't pull WASM tooling into CI.

---

## ADR-003 — Dual ESM/CJS via tsup for every `@neat.is/*` package

**Date:** 2026-04-30  
**Status:** Active.

Every workspace package emits ESM + CJS + DTS via `tsup`. The MCP SDK and the OTel SDK both have CJS quirks; consumers shouldn't have to care which format they're loading. One config, dual emit.

---

## ADR-004 — No dashboard in MVP

**Date:** 2026-04-30  
**Status:** Active.

The seed design doc explicitly excludes a dashboard from the MVP. The GitHub M5 milestone has dashboard issues (#28–#31) — those should be relabeled `post-mvp-enhance` and not block the demo.

`packages/web` exists, but as a wordmark + `/api/health` shell. Graph rendering, node inspector, incident log — all post-MVP.

---

## ADR-005 — Branch per issue, manual issue close

**Date:** 2026-04-30  
**Status:** Active.

One issue → one branch named `<num>-<slug>` → one PR. PR body says `Refs #N`, not `Closes #N`. The user closes issues by hand after verifying the milestone.

Reason: a merged PR is not the same as a verified milestone. Manual close forces the verification gate to actually be run.

---

## ADR-006 — No `Co-Authored-By: Claude` trailer in commits

**Date:** 2026-04-30  
**Status:** Active.

Commit history attributes work to the human authors only. No Anthropic / Claude co-author trailer. User preference.

---

## ADR-007 — Switch from pnpm to npm workspaces

**Date:** 2026-05-01  
**Status:** Active. Supersedes ADR-001.

Mid-sprint we decided pnpm wasn't earning its keep at four packages. npm ships with Node, so onboarding is `git clone && npm install` instead of also installing pnpm via corepack. The content-addressable store and `shamefully-hoist` workarounds were solving problems we don't have yet.

What changed: `pnpm-workspace.yaml`, `.npmrc`, and `pnpm-lock.yaml` are gone. `workspaces: ["packages/*"]` lives in root `package.json`. `packageManager: "npm@11.11.0"` pins the tool. Turbo 2.x reads `packageManager` to resolve the workspace graph, so it has to be there.

`workspace:*` deps became `*` for npm-idiomatic syntax. `demo/*` is **not** in workspaces yet — those services don't run until M2; adding their pg/express/OTel trees would add ~80 packages to the lockfile for nothing. M2 puts them back.

---

## ADR-008 — Plain-English commits, PRs, comments

**Date:** 2026-05-01  
**Status:** Active.

Commit messages, PR bodies, code comments, and docs read like a colleague wrote them. Tech jargon is fine; release-notes-y bullets and "this commit introduces" phrasing are not. Short paragraphs over stiff lists.

---

## ADR-009 — Demo services not in npm workspaces during M0/M1

**Date:** 2026-05-01  
**Status:** Active.

`demo/service-a` and `demo/service-b` exist as source files only during M0/M1. The static extractor reads their `package.json` directly from disk; it doesn't need their deps resolved. Listing them as workspaces would force npm to resolve pg, express, and the OTel SDK — ~80 transitive packages — for no current benefit.

M2 brings them back into workspaces when docker-compose actually launches the services.

---

## ADR-010 — Node and edge ID conventions

**Date:** 2026-05-01
**Status:** Active.

Node ids are typed prefixes joined to a stable name:

- `service:<package.name>` for `ServiceNode`s. The package name is what the discovery phase reads from `package.json`, so it survives directory renames and matches what humans (and the MCP tools) will type.
- `database:<host>` for `DatabaseNode`s. The host comes from `db-config.yaml`; it's the same value services reach the database with, which makes deduplication trivial when multiple services connect to the same db.

Edge ids are `${type}:${source}->${target}`. This makes edges deterministic — two extracts that see the same relationship produce the same key, so re-running `extractFromDirectory` is idempotent without needing a separate dedup pass.

**Why it matters:** every traversal (M3) and every MCP tool argument (M4) keys off these ids. Changing the format breaks the contract with everything downstream. If a new node type appears, give it a new prefix (`config:`, `infra:`); don't repurpose existing ones.

---

## ADR-011 — Snapshot envelope with schemaVersion

**Date:** 2026-05-01
**Status:** Active.

`saveGraphToDisk` doesn't write the raw `graphology.export()` blob. It wraps it:

```json
{ "schemaVersion": 1, "exportedAt": "2026-05-01T...", "graph": <export> }
```

`loadGraphFromDisk` rejects mismatched `schemaVersion` rather than trying to migrate silently. The first time the graph shape changes incompatibly (new required attribute, edge type rename, etc.), bump to `schemaVersion: 2` and add a migration branch in `loadGraphFromDisk`.

The write itself is atomic: `<path>.tmp` first, then `fs.rename`. A crash mid-write leaves the previous snapshot intact rather than half-truncating the active file.

---

## ADR-012 — tree-sitter scope for M1: URL substring matching only

**Date:** 2026-05-01
**Status:** Active for M1. Revisit if M3+ traversal needs richer call graphs.

The M1 extractor uses tree-sitter only to walk the AST and collect string literals; it then searches those literals for URLs containing a known service hostname. That's enough for the demo (`axios.get('http://service-b:3001/...')`).

What it deliberately does **not** do: full import-graph analysis, dynamic-URL inference, or following config objects. Those would multiply the surface area of what the extractor can be wrong about, and the failure cases the design doc cares about don't need them.

If a future demo case requires richer call-graph extraction, that's a deliberate scope expansion — write tests against the new failure mode first, then extend `extract.ts`.

---

## ADR-013 — Compat threshold semantics: under-flag rather than over-flag

**Date:** 2026-05-01
**Status:** Active.

`compat.json` carries a `minEngineVersion` per pair. The driver constraint only fires once the engine reaches that major or higher — so `pg 7.4.0 / postgresql 13` returns `compatible: true` because PG 13 still supports md5 auth.

Driver versions go through `semver.coerce` so `"v7.4.0"` and `"7.4"` both work. If a version string is unparseable (a git SHA, a build label, etc.), the function returns `compatible: true`. We'd rather miss a real incompatibility than fabricate a false positive on input we genuinely can't reason about — false positives erode trust in everything else the system says.

---

## ADR-014 — Manual pg span in service-b is M2-only debt

**Date:** 2026-05-01
**Status:** Active until M3 trace stitching lands. Then: delete the workaround.

`@opentelemetry/instrumentation-pg` only hooks pg >= 8.x. service-b is pinned to pg 7.4.0 because that's the version that fails the SCRAM handshake against PG 15 — without the failure there is no demo. The auto-instrumenter therefore never wraps `pool.query`, no span carries `db.system: postgresql`, and ingest has nothing to turn into an OBSERVED `CONNECTS_TO` edge. M2's verification gate explicitly expects that edge.

Today we paper over this by hand-rolling the span in `demo/service-b/index.js` (`tracedQuery` wrapping `pool.query` with `@opentelemetry/api`). It's a fixture, not architecture: a real NEAT user with a modern instrumented driver gets the OBSERVED edge for free.

The systems-level fix is M3's planned trace stitcher (see #10 + the INFERRED row of the provenance table in `architecture.md`): when an upstream span errors, walk the static graph from that service along EXTRACTED edges and write INFERRED edges with `confidence: 0.6`. Root-cause traversal already prefers OBSERVED → INFERRED → EXTRACTED, so the missing CONNECTS_TO becomes invisible to the system, not a special case to patch.

When M3 ships:
- Remove `tracedQuery`, the `@opentelemetry/api` import, and the `@opentelemetry/api` dep in `demo/service-b/package.json`. Drop the call site back to `pool.query('SELECT now() …')`.
- Re-run M2's verification gate. The OBSERVED CALLS edge should still appear; the OBSERVED CONNECTS_TO disappears, but an INFERRED CONNECTS_TO with confidence 0.6 should take its place.
- Update M2's gate text in `milestones.md` to reflect that CONNECTS_TO is INFERRED, not OBSERVED, in the live demo.

---

## ADR-015 — Root-cause traversal is matrix-driven, not pg-specific

**Date:** 2026-05-01
**Status:** Active. Supersedes the temporary pg-only path in `traverse.ts` from M3.

`getRootCause` originally read `ServiceNode.pgDriverVersion` and called `checkCompatibility` with a hardcoded `driver: 'pg'`. That made the rest of `compat.json` (mysql2/mysql, mongoose/mongo) decorative — the data was indexed but never consulted.

M5 generalises the traversal: filter `compatPairs()` to the target database's engine once, then walk each `ServiceNode` in the path checking every `dependencies[driver]` declaration against the matched pairs. The first incompatibility wins, and the fix recommendation cites the driver name from the matched pair.

**Why this shape and not a per-engine handler:** The per-engine fan-out is what `compat.json` already encodes. Pulling that table into TypeScript would duplicate it. The matrix is the schema; traversal just executes against it.

**`pgDriverVersion` stayed on the schema** as a UI/lookup convenience after the M5 generalisation but was no longer load-bearing — the dependencies map became the source of truth. ADR-019 drops it.

---

## ADR-016 — `ConfigNode`s record file existence, not contents

**Date:** 2026-05-01
**Status:** Active.

Phase 3 of `extractFromDirectory` walks each service directory for `*.yaml`, `*.yml`, and `.env`-shaped files; each one becomes a `ConfigNode` with `id: config:<scan-relative-path>` and a `CONFIGURED_BY` edge from the owning service. The node carries `name`, `path`, and `fileType` — nothing from inside the file.

**Why no contents:** `.env` files routinely carry secrets (database passwords, API keys); pulling them into a graph that gets snapshotted to disk and queried by AI agents over MCP is exactly the wrong default. The graph needs to *know* the file exists so policy queries ("which services are configured by `.env.production`?", "which configs feed into the failing service?") can resolve, but it does not need the values.

`db-config.yaml` is the exception only in the sense that phase 2 already parses it for connection details to build `DatabaseNode`s. Phase 3 adds it back in the catalog as a `ConfigNode`; the two readings coexist because they answer different questions.

**ID format:** `config:<relative-path>` keeps the node deterministic across re-extracts and lets two services that legitimately share a config file converge on the same node. Matches ADR-010's "typed prefix joined to a stable name".

---

## ADR-017 — `neat init` writes its snapshot under the scanned path by default

**Date:** 2026-05-01
**Status:** Active.

`neat init <path>` saves the snapshot to `<path>/neat-out/graph.json` unless `NEAT_OUT_PATH` overrides it. The alternative would have been a fixed `~/.neat/<hash>/graph.json` cache.

The local default keeps the snapshot near the code it describes — easy to find, easy to gitignore (the demo already does), easy to delete by `rm -rf neat-out`. A user-home cache would be friendlier to multi-project workflows but adds a directory the user has to learn about and clean. The CLI is a M5 deliverable, not a daemon; the local-default trade-off can be revisited if `neat watch` lands later.

---

## ADR-018 — Railway deployment is documented, not codified

**Date:** 2026-05-01
**Status:** Active for the MVP. Revisit if deploys become routine.

The M6 deliverable for Railway is `docs/railway.md` plus a small set of supporting files (`demo/collector/Dockerfile`, `demo/collector/config.railway.yaml`). It is not a `railway.toml`-driven IaC setup, and it is not a one-button deploy.

**Why no Railway IaC.** The MVP has six services, four of them backed by simple Dockerfiles, one Postgres plugin, and one Next.js auto-detect. The Railway config language adds another file format the team has to keep in sync with the docker-compose source of truth. For a one-shot demo deploy, a runbook is more honest about the manual steps (variables to wire, domains to generate, public/private toggles) than a `railway.toml` that elides them.

**The collector earns its own Dockerfile** because docker-compose mounts `config.yaml` into the upstream image, and Railway can't. Two configs coexist: `config.yaml` for local docker-compose, `config.railway.yaml` for the deployed collector (it parameterises the neat-core hostname via env). The Dockerfile copies the local one in by default; the runbook tells the operator to swap it for the Railway variant.

**When to revisit.** If a second deploy target lands, or if Railway deploys become routine enough that the runbook drift starts hurting, codify in `railway.toml` per service and lift the env wiring into Railway's variable references (it already supports `${{ payments-db.PGHOST }}`). Until then, prose + concrete commands beats config we don't actively maintain.

---

## ADR-019 — Drop `pgDriverVersion` from `ServiceNode`; bump snapshot to v2

**Date:** 2026-05-02
**Status:** Active. Closes the loop ADR-015 left open.

ADR-015 made `pgDriverVersion` non-load-bearing — `getRootCause` now reads `dependencies[driver]` for every driver in `compat.json`. The field stayed on `ServiceNodeSchema` as a UI/lookup convenience, but in practice it was a special case that only existed for one driver, and it would let a future contributor reintroduce pg-specific code paths without anyone noticing. v0.1.2-α removes it.

**What changes.**

- `pgDriverVersion` is gone from `ServiceNodeSchema` in `@neat.is/types`.
- Phase 1 of `extractFromDirectory` no longer sets it — `dependencies` carries the raw `package.json` map and that's the only declaration we ship.
- Snapshot `schemaVersion` bumps from `1` to `2`. `loadGraphFromDisk` migrates v1 snapshots in place by stripping `pgDriverVersion` from every node's attributes; the rest of the v1 payload flows through unchanged.
- Tests that previously asserted `serviceB.pgDriverVersion === '7.4.0'` now read `serviceB.dependencies?.pg`.

**Why migrate rather than hard-fail.** ADR-011 set the precedent that incompatible schema bumps throw on load; this bump is *forward-compatible*. Stripping a field that no consumer reads anymore is exactly the case where an automatic migration costs nothing and saves users a manual re-extract. The hard-fail path is reserved for genuinely incompatible changes (renaming an edge type, restructuring a node id format).

**One-way door check.** Adding `pgDriverVersion` back later would be trivial — it'd be a Zod field plus an extract-phase write. Nothing about removing it now traps the schema. If the v0.1.2 compat work (#74) ends up wanting per-driver hot-fields on `ServiceNode`, that's a generalised mechanism, not a re-litigation of this one field.

---

## ADR-020 — Bundle OTLP `.proto` files in-tree; opt-in gRPC receiver

**Date:** 2026-05-02
**Status:** Active.

The OTLP/gRPC receiver lives in `packages/core/src/otel-grpc.ts` and is only started when `NEAT_OTLP_GRPC=true`. It loads `.proto` files from `packages/core/proto/opentelemetry/proto/...` via `@grpc/proto-loader` at startup, decodes the binary wire format, reshapes the snake_case message into the same `OtlpTracesRequest` shape the HTTP receiver uses, and then reuses `parseOtlpRequest`.

**Why bundle the protos.** `@opentelemetry/proto` isn't published as an npm package, and the alternatives — pulling in `@opentelemetry/otlp-grpc-exporter-base` (the wrong direction; it's an exporter), hand-rolling protobuf decoding with `protobufjs`, or generating TypeScript stubs at build time — each carry more weight than four short `.proto` files copied verbatim from the upstream OpenTelemetry repo. The protos are Apache-2.0 / CC0 and stable across OTLP versions.

**Why opt-in.** Most NEAT installs run the HTTP path because that's what docker-compose's collector ships in this repo. Turning on a second listener by default would surprise existing operators and risk a port collision on `:4317`. `NEAT_OTLP_GRPC=true` is the explicit affordance; the documented flag means "I know I'm adding a transport." `NEAT_OTLP_GRPC_PORT` lets non-default deployments rebind.

**Why share `parseOtlpRequest`.** The HTTP and gRPC paths produce identical `ParsedSpan`s downstream. Anything past the receiver — `handleSpan`, `stitchTrace`, `upsertObservedEdge`, `markStaleEdges` — is transport-agnostic and stays that way. If the wire formats drift in a future OTLP rev, the divergence is contained in the receivers.

**When to revisit.** If a third transport lands (gRPC over Unix socket? OTLP/Arrow?), the reshape step starts looking like an interface rather than a function, and we extract a `Decoded → ParsedSpan[]` adapter type. Until then, two transports calling one decoder is the simpler shape.

---

## ADR-021 — Python extraction reads source via tree-sitter; NEAT's toolchain stays Node-only

**Date:** 2026-05-02
**Status:** Active.

v0.1.2-β #72 added Python service extraction. NEAT now reads `pyproject.toml`, `requirements.txt`, and Python source files (via `tree-sitter-python`), but the runtime stays pure Node 20 + TypeScript. No Python interpreter, no virtualenv, no `pip install`.

**Why tree-sitter, not the Python AST.** The actual Python `ast` module is the canonical parser, but using it would require shelling out to a Python interpreter (or pulling Python into the runtime). tree-sitter's Python grammar covers the surface area we care about — string literals for URL extraction, top-level `import` statements if we ever need them — and runs in-process via the same native binding pattern we already use for JavaScript. The cost is: tree-sitter-python doesn't model semantic Python (no type info, no scope analysis), but extraction never needed those.

**Why TOML via `smol-toml`.** `pyproject.toml` is the modern Python manifest and we need to read both PEP 621 `[project]` tables and the older Poetry `[tool.poetry.dependencies]` shape. `smol-toml` is a small, dep-free, spec-compliant parser. The alternative — regex — works for trivial cases but breaks on multi-line arrays and quoted keys; the dep is worth it.

**Why deps live in the same `dependencies` map.** `ServiceNode.dependencies` is `Record<string, string>` regardless of language. Python deps from `requirements.txt` (`name==version`) and pyproject (`name = "version"` or `["name==version", ...]`) get normalised into the same map. The compat matrix runs against both — `pg` checks JS services, `psycopg2` checks Python services — without per-language branching. `language: "javascript" | "python"` on the node is metadata, not a dispatch key.

**Where this could go wrong.** Unpinned deps (`requests>=2.0`) or non-`==` constraints record an empty version. The semver coercer in `compat.ts` already treats unparseable versions as "can't reason → don't flag," so we under-flag rather than over-flag. If γ's #74 wants stricter Python compat, the parser shape stays — only the matching logic changes.

**When to revisit.** When a third language lands (Go, Rust). At that point the per-language detector gets its own subdir like `extract/databases/` already does, and `services.ts` becomes a dispatcher. Two languages don't justify that split yet.

---

## ADR-022 — `infra:` taxonomy: one node type, kind-segmented ids

**Date:** 2026-05-02
**Status:** Active.

v0.1.2-β #73 populated `InfraNode` from docker-compose, Dockerfile, Terraform, and k8s. Every infra node uses the same id format: `infra:<kind>:<name>` (e.g. `infra:postgres:postgres`, `infra:container-image:node:20`, `infra:aws_s3_bucket:uploads`, `infra:k8s-deployment:default/web`).

**Why one node type, not many.** ADR-010 reserved the `infra:` prefix for a single `InfraNode` discriminant. The alternative — adding `Pg11Node`, `RedisNode`, `S3BucketNode`, etc. as separate top-level Zod variants — would duplicate the `id`/`name`/`provider` fields N times and force every traversal call site to know which variant to expect. A single `InfraNode` with an optional `kind: string` keeps `GraphNodeSchema`'s discriminated union at four members and lets sub-typing live in one place.

**Why `kind` is a free string, not an enum.** New infra sources land regularly (the four in #73 already span four different vocabularies — `postgres` from compose, `container-image` from Dockerfiles, `aws_s3_bucket` from Terraform, `k8s-deployment` from k8s). Locking `kind` to an enum would either (a) become stale instantly or (b) force every detector to register a new enum value before it can ship. A free string lets each detector pick its own naming, and the id format keeps it deterministic.

**Why the id segments matter.** Three pieces, in order: the prefix (`infra:`) so traversal can dispatch; the kind so consumers can group similar nodes (`get_dependencies` could filter "show only k8s objects"); the name so two services that both depend on `infra:postgres:postgres` collapse to the same node. ADR-010's "typed prefix joined to a stable name" generalises naturally — kind is just a sub-type within the prefix.

**Why no `DEPLOYS` / `RUNS_IN` edge types yet.** The issue floated those names. `RUNS_ON` (service → image) covers the Dockerfile case clearly; `DEPENDS_ON` (already in the enum) covers compose's `depends_on:` lists. Neither k8s nor Terraform needed new edge types in this pass — they emit cataloguing nodes only. If a later feature wants service-to-Deployment wiring, that's a new edge then, not now.

**Coexistence with DatabaseNode.** A docker-compose declaring Postgres produces both an `infra:postgres:<compose-name>` (from #73) and possibly a `database:<host>` (if a service's #70 parser reads that compose). They describe the same physical thing from different perspectives — the compose topology vs. the service's connection target — and they coexist. γ's #75 (FRONTIER population) is the natural place to deduplicate if it ever becomes a problem; right now it isn't.

**When to revisit.** If a `kind` value's vocabulary needs validation (e.g. compat reasoning that says "if `kind === 'postgres'` then..."), promote it to a constant set. The schema can stay a free string and just typecheck the values that matter.

---

## ADR-023 — `FrontierNode` as a fifth top-level node type

**Date:** 2026-05-02
**Status:** Active.

v0.1.2-γ #75 added a fifth member to `GraphNodeSchema`: `FrontierNode`. A frontier node is the placeholder ingest writes when an OTel span peer (`server.address`, `net.peer.name`, etc.) doesn't resolve to any known service. The id format is `frontier:<host>`. A later extraction round picks up the host as an alias on a real service, `promoteFrontierNodes` re-links the edges, and the placeholder goes away.

**Why a new node type, not an `InfraNode` kind.** ADR-022 deliberately kept the discriminated union at four. Frontier nodes broke that ceiling because they aren't classified by *what they are* — they're classified by *what they don't yet know*. They have a distinct lifecycle (placeholder → promoted → deleted), they carry temporal fields (`firstObserved`, `lastObserved`) that don't make sense on infra catalog entries, and a frontier node is supposed to disappear once extraction catches up. Cramming that into `InfraNode.kind = "frontier"` would have meant teaching every consumer of `InfraNode` to filter out a special case, and would have leaked frontier semantics into a node type whose whole job is to be permanent.

**Why a top-level type rather than a flag on `ServiceNode`.** A frontier doesn't have a language, dependencies, or a repo path — none of `ServiceNode`'s required fields apply. We considered making `ServiceNodeSchema` looser, but the schema's job is to fail loudly when something pretending to be a service isn't one. Promotion *converts* a frontier into the matching real service by re-linking edges and dropping the placeholder; the two never coexist as the same node.

**Why provenance `FRONTIER` already existed but the node type didn't.** The provenance enum has carried `FRONTIER` since M0 (it shipped in `@neat.is/types`'s constants). The original intent was always "we observed something but can't fully attribute it." γ #75 finally wired up the producer (ingest) and the consumer (extract's promotion phase). The provenance is set on the edge between the source service and the placeholder; once promoted, those edges flip to `OBSERVED` because the call certainty is real — only the target identity was the unknown.

**Aliases live on `ServiceNode`, not as a new edge type.** The alternative was an explicit `ALIASED_AS` edge from a service to each hostname. That would have grown the edge count linearly with cluster-DNS variants (`<name>`, `<name>.<ns>`, `<name>.<ns>.svc`, `<name>.<ns>.svc.cluster.local`) for every service every k8s manifest mentions. Storing them as a `string[]` on the service keeps the resolve path one map lookup and keeps the graph topology focused on real relationships.

**Where promotion runs.** At the end of every `extractFromDirectory` pass, after services + databases + configs + calls + infra. Promotion needs the full alias state from the latest extraction round, so it has to run last. Re-running ingest doesn't trigger promotion directly — it just keeps pinning frontier `lastObserved` — which is fine because the next extraction round will sweep them up.

**When to revisit.** If frontier nodes start sticking around (a host that never resolves no matter how many rounds pass), they become a UX signal: "you have unknown peers." That's a γ #76 concern (per-edge confidence) or δ ergonomics, not this ADR. The placeholder will continue to do its job until then.

---

## ADR-024 — Per-edge-type stale thresholds

**Date:** 2026-05-02
**Status:** Active.

A single 24h `STALE_THRESHOLD_MS` doesn't survive contact with diverse traffic. HTTP `CALLS` recur in seconds — 24h means a service could go down for the whole afternoon and the graph would still claim everything was fine. Infra `DEPENDS_ON` is the opposite — a docker-compose service idle overnight isn't a problem. v0.1.2-γ #78 splits the threshold per edge type: `CALLS` go stale at 1h, `CONNECTS_TO` / `PUBLISHES_TO` / `CONSUMES_FROM` at 4h, infra `DEPENDS_ON` / `CONFIGURED_BY` / `RUNS_ON` at 24h.

**Why a hardcoded default map, not a single tunable.** The defaults encode operational knowledge — "HTTP traffic is chatty, infra dependencies aren't" — and shouldn't have to be rediscovered per deployment. The map lives next to `markStaleEdges` in `ingest.ts`; new edge types fall back to 24h via a single sentinel constant, so adding to `EdgeType` doesn't silently bypass staleness sweeps.

**Why `NEAT_STALE_THRESHOLDS` is JSON, not per-flag env vars.** The variable count grows with `EdgeType` cardinality, and most deployments won't override anything — a single JSON blob is the path of least resistance. The parser tolerates malformed input (warn + fall back to defaults) so a typo can't take down the staleness loop.

**Why a stale-events ndjson log, not just edge mutations.** The graph stores the *current* state — once an edge flips to STALE, the OBSERVED → STALE transition is gone. That transition is the load-bearing fact (oncall wants to know "what just stopped working", not "what's currently quiet"). A per-line ndjson log is the same shape as `errors.ndjson`, replays cleanly, and a downstream consumer (alerting, dashboard) can tail it without touching the graph.

**Why expose it as `/incidents/stale` rather than another resource.** Stale-edge transitions *are* incidents in the operational sense — something stopped, oncall might care. Co-locating with `/incidents` keeps the surface coherent. The MCP tool `get_recent_stale_edges` mirrors `get_incident_history` so the questions ("what just broke?" / "what just went quiet?") have parallel answers.

**Where this could go wrong.** A flapping integration that calls every 65 minutes will oscillate between OBSERVED and STALE under the 1h `CALLS` default. The fix is to nudge the threshold (`NEAT_STALE_THRESHOLDS={"CALLS":7200000}`); the ndjson log will record both transitions so the oscillation itself is observable.

**When to revisit.** When δ #79's `neat watch` daemon runs continuously, the stale-events log will grow unbounded. Rotation / TTL belongs there, not here — this ADR's job is to define the shape; that one will define the lifecycle.

---

## ADR-025 — `semantic_search` embedding model: Ollama → Transformers.js → substring fallback chain

**Date:** 2026-05-03
**Status:** Active.

`semantic_search` shipped in M4 as a substring match over `id` and `name`. It works for "show me the payments service" — but loses to "what handles checkout payments?" because the literal token doesn't appear. v0.1.2-δ #82 replaces the keyword path with real embeddings while keeping the substring path as the lowest-tier fallback so the tool never disappears even on minimal hosts.

The embedding choice is the load-bearing decision in this work. We pick *one* default model and a fallback chain rather than a configurable provider matrix.

**The chain.** First match wins:

1. **Ollama** with `nomic-embed-text`, when `OLLAMA_HOST` is set (or `http://localhost:11434` is reachable on first use). 768-dim, 8K context, MIT-licensed, designed for retrieval. The user already pays the Ollama install cost; we just embed.
2. **Transformers.js** running `Xenova/all-MiniLM-L6-v2` in-process, when Ollama isn't around. 384-dim, ~25MB on-disk, fully offline, no model server needed. Cold-start cost is the model download (~25MB once, cached in `~/.neat/models/`) plus ~1s of WASM init.
3. **Substring fallback** — the existing M4 implementation, kept verbatim. Whatever was returned before still gets returned when neither embedder is available.

Every tier returns the same MCP-shaped response, so consumers don't branch on which one ran.

**Why Ollama as the default top tier.** It's the path of least resistance for users who already have it. Local, private, free, and the API surface (`POST /api/embeddings`) is small enough that we don't need an SDK dependency. `nomic-embed-text` consistently wins on retrieval benchmarks at its size class, and 768-dim cosine over a ≤10K-node graph is ~30ms — graph scale isn't the bottleneck.

**Why Transformers.js as the in-process fallback, not a server-side embed.** The fallback exists for the case "the user hasn't installed Ollama and we don't want to make them." Anything that requires a separate process or network call would just become the new "you have to install X" friction. Transformers.js runs inside Node via WASM/ONNX with no external server. The chosen model (`all-MiniLM-L6-v2`) is the de facto default for "I need embeddings, I don't have infrastructure." It's smaller and weaker than nomic, which is exactly why we order Ollama first.

**Why not OpenAI / Voyage / Cohere as defaults.** A hosted API would be the easiest to integrate but introduces an outbound network dependency and a credit cost on a tool that should "just work" against a local repo. NEAT runs against private codebases — sending node names to a third-party embedding endpoint is a category of decision a project should opt into, not inherit. Hosted providers can land later as a fourth tier (`NEAT_EMBED_PROVIDER=openai`) without changing the default.

**Why a flat in-memory cosine, not a vector DB.** The graph caps out at ~10K nodes for any realistic repo. A `Float32Array` per node and a linear scan is ~3ms at 10K × 768. Indexing structures (HNSW, IVF) are faster only above ~100K vectors and add a dependency that has to compile native bindings. ADR-002 already paid that price for tree-sitter; we don't pay it twice.

**What gets embedded.** Per node: `id + name + (description fragments — `language` for services, `engine`/`engineVersion` for databases, `kind` for infra)`. Edges are not embedded. Frontier nodes are not embedded — they're noise by design. The embed input is deterministic from node attrs so re-extracts hash-identical, and we use that hash to skip re-embedding nodes whose attrs didn't change.

**Cache shape.** A sidecar cache at `<scanPath>/neat-out/embeddings.json` keyed by `{ provider, model, dim }` plus per-entry `{ nodeId, attrsHash, vector }`. On startup the search index loads the cache, drops entries whose `attrsHash` doesn't match the current node, and embeds anything new. The cache is regenerable, gitignore-friendly (lives under `neat-out/` with the snapshot), and never touches the snapshot's `schemaVersion: 2` envelope.

**What this ADR isn't deciding.** Whether the substring tier should compute Jaro-Winkler or BM25 — the existing M4 substring code stays as-is. Whether the cache should be sqlite — JSON is fine at 10K vectors and the diff against an existing snapshot pattern works the same way. Whether `semantic_search` should accept a `provider` arg — let environment config drive the choice; the tool surface stays a one-arg `query`.

**When to revisit.** When (a) graph scale exceeds ~50K nodes (then the linear scan becomes the bottleneck and a vector index earns its complexity), (b) a hosted embedding provider lands as a tier (then the chain extends), or (c) the embed input materially changes (e.g. embedding evidence snippets from γ #71's edge metadata — a different decision than node-only embeddings).

---

## ADR-026 — Multi-project: dual-mounted routes, per-project paths, OTel stays single-project

**Date:** 2026-05-03
**Status:** Active.

v0.1.2-δ #83 replaces the `getGraph()` singleton with a `Map<string, NeatGraph>` keyed by project name. The shape is straightforward; three sub-decisions earn their own entries here because they're the parts a fresh agent will trip over.

**Routes are dual-mounted, not migrated.** Every project-scoped route is registered twice: once at the root (`/graph`, `/incidents/...`, etc.) and once under `/projects/:project/*`. A request hitting `/graph` runs the same handler as `/projects/default/graph`; `req.params.project ?? 'default'` is the only branch. Single-project users — anyone who installed pre-#83 — see no change to URL shape, response body, or status codes. The alternative (force every URL to carry the prefix and break old clients) was rejected because the "single-project" path is still the overwhelming majority of usage; making it the special case would inflate every command in the demo, the README, and every Claude Code prompt that doesn't care about projects.

**Default project keeps the legacy filenames.** `pathsForProject('default', baseDir)` returns `graph.json`, `errors.ndjson`, `stale-events.ndjson`, `embeddings.json` — byte-for-byte the paths β / γ shipped. Named projects fan out: `<project>.json`, `errors.<project>.ndjson`, `stale-events.<project>.ndjson`, `embeddings.<project>.json` — flat layout, one prefix per kind, parseable from a directory listing. We considered `neat-out/<project>/graph.json` per-project subdirs; rejected because (a) the snapshot files are the load-bearing artifact and the rest are sidecars, (b) flat files are easier to glob and `gh release` against, and (c) it would have moved the default project's snapshot from `neat-out/graph.json` to `neat-out/default/graph.json`, breaking every existing user.

**OTel ingest stays single-project.** Spans land in the default project's graph and write to its `errors.ndjson`. There's no project header on OTel resource attrs, no convention agents would know to set, and even if there were, agents emitting spans across multiple projects from one collector is a deployment shape we haven't seen. Multi-project users today run one `neat-core` per project, each pointing OTel at its own port. This ADR acknowledges that and makes the single-project ingest path explicit; revisiting means picking a span attribute (`neat.project`?) and threading it through `makeSpanHandler`.

**Server boot loads projects from `NEAT_PROJECTS=a,b,c`.** No filesystem scan. Each named project loads from `neat-out/<name>.json` if it exists, starts empty otherwise. Projects can also be wired to a scan path via `NEAT_PROJECT_SCAN_PATH_<NAME>` so `POST /projects/:name/graph/scan` works without a prior `neat init`. Filesystem-driven discovery (auto-load every `*.json` in `neat-out/`) was rejected because it conflates snapshot files with embeddings caches and other sidecars; the env var is explicit and forgettable in exactly the right cases.

**`neat init <path> --project <name>` writes the right snapshot file.** Default still goes to `<path>/neat-out/graph.json`; named projects to `<path>/neat-out/<name>.json`. `NEAT_OUT_PATH` overrides — if set, it wins. `neat watch <path> --project <name>` does the same plus boots a daemon; multi-project watch (one daemon serving multiple projects with its own chokidar per project) is deferred — the typical workflow is one daemon per project.

**MCP tools take an optional `project` arg.** Tools omit it by default, the HTTP client uses the legacy unprefixed URL, and the core resolves that to `default`. When `NEAT_DEFAULT_PROJECT=alpha` is set on the MCP server, every tool call without an explicit `project` routes through `/projects/alpha/...`. The arg can override per-call. Same shape for resources — `neat://node/<id>` always resolves against the configured project, and `neat://incidents/recent` polls `/projects/<project>/incidents` (or `/incidents` when no project is set) for change detection.

**When to revisit.** Per-project OTel ingest (when a real multi-project deployment surfaces and one collector emitting to multiple project graphs becomes a thing). Auto-loading projects from disk (when manual `NEAT_PROJECTS` becomes the source of bug reports). Per-project default thresholds, embedders, or scan depth (when a project actually needs to override these — none does today, so they all stay process-global).

---

## ADR-027 — MVP success is closing a real PR on an unfamiliar open-source codebase, not running the pg demo

**Date:** 2026-05-04
**Status:** Active.

The pg demo (a service running pg 7.4.0 against PostgreSQL 15) was stood up to prove the graph + provenance + traversal stack works end to end. It does. But the demo was scaffolded against a failure mode we engineered ourselves, in a controlled environment we built to fail in a specific shape. Closing a real PR on a codebase we did not engineer — where the bug is not pre-staged, the maintainers do not know about it, and the fix has to be correct enough to merge — is a different and much higher bar.

This ADR records that the second bar is the actual MVP success criterion. The pg demo was a stepping stone that became the destination by accident of incremental delivery.

**Why this is the right bar.** A static-only find on a real repo (e.g. the FastAPI lexicographic-version-comparison shape — `"3.10" < "3.9"` because string compare) is reproducible by any tree-sitter-based tool. Graphify in particular already does this category of thing for ~39K users. A NEAT PR that closes a static-shaped bug doesn't differentiate the product; it confirms a Graphify fork could match it. The PR that earns NEAT its category is one where the OBSERVED layer was load-bearing — runtime signal that tree-sitter alone could not have predicted, connected back to a code decision through the graph.

**The trace stitcher is evidence, not a workaround.** PROVENANCE.md records that pg 7.4.0 is too old for `@opentelemetry/instrumentation-pg`, so the demo's own database spans never emit; the INFERRED layer was added to bridge the gap. We had been treating that as a demo-environment compromise. It is in fact a small instance of the load-bearing fact NEAT exists to surface: in real systems, OBSERVED ground truth requires instrumentation that does not always exist, and the gap between what you can see and what you must infer is not a clean line. Every real codebase has a much larger version of this gap. NEAT's job is to make that gap navigable.

**What follows for the roadmap.** Two parallel tracks share `main`:

- **Track 1 — v0.3.0 (frontend).** Investor-legibility. Jed's work, against the stable v0.1.2 API. Doesn't gate the MVP success criterion; the headline metric is "PR merged on a repo we didn't engineer," not "graph renders pretty."
- **Track 2 — v0.2.0 (Sunrise, audit-driven cleanup) → v0.2.1 (policies) → v0.2.2 (`neat init` + Claude skill).** Engineering work. v0.2.0 redeems the prototype against the seven contract documents in `docs/audits/`. v0.2.1 closes the four-feature gap (OTel + graph + MCP + policies) and gives NEAT the data model that makes intent-vs-observed-reality first class. v0.2.2 collapses NEAT's installation to one command + a Claude skill so it can be pointed at any codebase. Together they are what makes the MVP-success PR experiment runnable.

The numbering communicates priority: engineering ships first as the v0.2.x cluster; frontend lands as v0.3.0. The two tracks remain technically independent — neither blocks the other.

**What's deferred until after the MVP-success PR.** Auto-PR generation (NEAT writes the patch, not just identifies the divergence). Hosted MCP. Multi-tenant policy stores. None of these change whether NEAT can find a real bug; they only matter once it can.

**What this ADR is not deciding.** Which open-source repo we point NEAT at first; that's a product call once the platform is in shape. Whether the codemod or eBPF route is the v0.2.2 default; that's the ADR that lands when v0.2.2 starts. Whether v0.3.0 frontend ships before or after v0.2.x; the tracks are independent.

**When to revisit.** When the first real PR closes — flip the framing from "can NEAT do this" to "what's the next bar." Until then this ADR stays the active project gravity.

---

## ADR-028 — Node identity is constructed via helpers, not string literals

**Date:** 2026-05-05
**Status:** Active.

Node identity is the deepest concern in the graph. Every edge connects two nodes by id; if two producers disagree on what id a service gets, OBSERVED edges from one never match EXTRACTED edges from the other and the coexistence contract (contracts.md Rule 2) silently fails.

Today identity is scattered across 12 hand-rolled sites in 9 files (services.ts, ingest.ts, configs.ts, databases/index.ts, infra/shared.ts, calls/{aws,kafka,redis,grpc}.ts). Each producer constructs its own id via template literal. Consistency holds by good behavior, not by the type system.

**Decision.**

1. **Id patterns are functions, not literals.** A new module `packages/types/src/identity.ts` exports `serviceId`, `databaseId`, `configId`, `infraId`, `frontierId` plus their inverses (`parseServiceId`, etc.). Producers call these. No producer constructs a node id by template literal.

2. **The id patterns themselves stay what they are today.** This ADR doesn't change the wire format — `service:<name>`, `database:<host>`, `config:<relPath>`, `infra:<kind>:<name>`, `frontier:<host>`. It just gives them a single source of truth.

3. **Auto-created and static-extracted nodes merge by id.** When OTel ingest auto-creates a `ServiceNode` for an unseen `span.service` (issue #134) and static extraction later produces a `ServiceNode` with the same id, they merge — they do not coexist as duplicates. The id is the merge key. Static-extracted fields (language, version, dependencies) override OTel-derived fields (which are absent or sparse) where both exist; OTel-derived fields (lastObserved on associated edges, span counts) survive untouched.

4. **FrontierNode promotion preserves identity continuity.** When a FrontierNode at `frontier:<host>` is promoted to a typed node — typically a ServiceNode at `service:<name>` after an alias resolves — the FrontierNode is removed and the typed node takes its place. Edges that pointed at the frontier id are rewritten to point at the new typed id. This is what `promoteFrontierNodes` already does in ingest.ts; ratified here.

5. **Workspace scoping is deferred.** A monorepo with two services both named `shared-utils` in different workspaces collides under `service:shared-utils`. Today this is left to `addServiceAliases` to disambiguate via host:port mapping, which doesn't actually rename the service. Real fix is workspace-scoped ids like `service:<workspace>/<name>`. Defer until a real codebase trips it. Document the limitation; do not silently re-engineer the id format without a successor ADR.

6. **Database id is host-only, not host:port.** Two databases on the same host with different ports collide. Defer the fix; document the limitation.

**Why the identity helpers are in `@neat.is/types`, not `@neat.is/core`.**

Both producers and consumers need them. Producers (extract/, ingest.ts) construct ids; consumers (traverse.ts, MCP tools, REST handlers) sometimes parse them (api.ts:202 strips a `service:` prefix today). Putting helpers in `@neat.is/types` keeps the module that owns the schemas as the single source of truth for the wire format, and avoids a circular dependency between core and any producer-only id module.

**Enforcement.**

`packages/core/test/audits/contracts.test.ts` gains a regression test: scan `packages/core/src/` and `packages/mcp/src/` for hand-rolled id patterns (`service:`, `database:`, `config:`, `infra:`, `frontier:` inside template literals). The only allowed sites are inside `@neat.is/types/identity.ts` itself, and inside test fixtures. CI fails any future session that drifts.

`docs/contracts.md` Rule 16 records the binding form: "Node ids are constructed via the helpers in `@neat.is/types/identity.ts`. Hand-rolled template literals constructing node ids are a contract violation."

**What this ADR is not deciding.**

Edge identity (different ADR — comes next as #2 in the contract list). Provenance ranking (already locked in contracts.md Rule 1-2). Lifecycle transitions (different ADR — #3 in the list). Workspace-scoped ids and host:port database ids (deferred per items 5 and 6).

**When to revisit.**

When a real codebase trips the workspace-collision case (item 5) or the host:port-collision case (item 6) — at that point write a successor ADR introducing scoped ids, and migrate snapshots via the v2→v3 path persist.ts already supports.

---

## ADR-029 — Edge identity and provenance ranking

**Date:** 2026-05-05
**Status:** Active.

Edges are the second layer of identity, downstream of nodes (ADR-028). Today four edge id patterns exist — one per provenance variant — and they live in three different places:

- `makeEdgeId(source, target, type)` in `packages/core/src/extract/shared.ts:67` produces EXTRACTED ids (`${type}:${source}->${target}`).
- `makeObservedEdgeId(type, source, target)` in `packages/core/src/ingest.ts:115` (local) produces OBSERVED ids (`${type}:OBSERVED:${source}->${target}`).
- `makeInferredEdgeId(type, source, target)` in `packages/core/src/ingest.ts:119` (local) produces INFERRED ids (`${type}:INFERRED:${source}->${target}`).
- A bare template literal at `packages/core/src/ingest.ts:182` produces FRONTIER ids (`${type}:FRONTIER:${source}->${target}`).

Three patterns have helpers, one is inline. The helpers themselves are scattered. The traversal layer also encodes a separate concern — the `PROV_RANK` constant in `packages/core/src/traverse.ts:16-22` that orders edges by trust during walks. That ranking is part of the provenance contract; it doesn't belong only to traversal.

**Decision.**

1. **Edge id helpers move into `@neat.is/types/identity.ts`.** Five exports: `extractedEdgeId`, `observedEdgeId`, `inferredEdgeId`, `frontierEdgeId`, plus `parseEdgeId(id)` returning `{ type, provenance, source, target }` or `null`. Producers call the helpers; nobody constructs an edge id by template literal.

2. **The wire format stays what it is today.** ADR-029 doesn't change the edge id strings — it gives them a single source of truth. EXTRACTED has no provenance segment; OBSERVED, INFERRED, and FRONTIER carry the provenance segment between type and source. STALE never appears in an edge id because STALE is a transition of an existing OBSERVED edge, not a creation pattern (ADR-024).

3. **`PROV_RANK` moves into `@neat.is/types`.** The ordering `OBSERVED > INFERRED > EXTRACTED > STALE | FRONTIER` is part of the provenance contract, not traversal-private. Traversal imports it. Future consumers (policies, MCP tools, the daemon's reconciliation layer) import the same constant.

4. **Coexistence rule reaffirmed.** Multiple edges between the same node pair under distinct provenance ids coexist — they do not collapse. The id pattern is what makes coexistence mechanically possible: the EXTRACTED id and OBSERVED id are different strings, so `graph.hasEdge(...)` doesn't conflate them. This was already true in the code (ingest.ts:15-17 documents intent); ADR-029 ratifies it as the contract.

5. **Per-edge confidence semantics per provenance:**
   - **OBSERVED** — `confidence: 1.0` always. Direct measurement; the value is a max-trust marker, not a derived score.
   - **INFERRED** — `confidence ≤ 0.7`, default `0.6` (`INFERRED_CONFIDENCE` constant). Set at edge creation by the trace stitcher; never exceeds 0.7 because INFERRED is by definition less trustworthy than OBSERVED.
   - **EXTRACTED** — confidence is **not stored** on EXTRACTED edges. EXTRACTED edges either exist (the static analyzer found them) or they don't. They don't decay on a clock; their confidence is implicit in their existence.
   - **STALE** — confidence drops to `≤ 0.3` on transition, set at transition time. The original `lastObserved` is preserved.
   - **FRONTIER** — confidence is implicit in the FRONTIER provenance itself; not stored as a numeric field. FRONTIER is excluded from traversal (contracts.md Rule 3) so its confidence is never compared.

6. **Round-trip guarantee.** `parseEdgeId(extractedEdgeId('A', 'B', 'CALLS'))` returns `{ type: 'CALLS', provenance: 'EXTRACTED', source: 'A', target: 'B' }`. Same for the other three variants. This lets consumers (traversal, MCP tools, debugging code) walk back from an id to its parts without re-deriving the format inline.

**Why these helpers are in `@neat.is/types`, not `@neat.is/core`.**

Same reason as ADR-028: producers and consumers both need them. The traversal layer reads edge ids when walking; the persist layer reads them on snapshot load; the MCP layer reads them when surfacing edges. `@neat.is/types` already owns the schema for the edge structure; it should own the wire format too.

**Enforcement.**

`packages/core/test/audits/contracts.test.ts` adds a regression test that scans `packages/core/src/` and `packages/mcp/src/` for hand-rolled edge id template literals — patterns like `` `${type}:${source}->...` ``, `` `:OBSERVED:` ``, `` `:INFERRED:` ``, `` `:FRONTIER:` `` outside `@neat.is/types/identity.ts`. CI fails any future session that drifts.

`docs/contracts/provenance.md` records the binding rules in short form, governs `packages/core/src/{ingest,traverse,persist}.ts` and `packages/core/src/extract/**` (anywhere edges are constructed or compared).

**What this ADR is not deciding.**

Lifecycle transitions (OBSERVED→STALE, FrontierNode promotion, ghost-edge cleanup) — that's contract #3, the next ADR. Edge schema field-set (`source`, `target`, `evidence`, `signal`, `lastObserved`, etc.) — already locked in `packages/types/src/edges.ts`. Provenance enum values — already locked in `packages/types/src/constants.ts`.

**When to revisit.**

If a new provenance variant is introduced (e.g. `OBSERVED-NET` if eBPF capture lands post-v1.0 — see the v0.x discussion thread), this ADR gets a successor that adds the new id pattern and PROV_RANK entry without changing the existing four.

---

## ADR-030 — Node and edge lifecycle

**Date:** 2026-05-05
**Status:** Active.

The third data-layer contract. ADR-028 locked node identity, ADR-029 locked edge identity and provenance ranking. This ADR locks the rules for **when** nodes and edges enter the graph, **how** they transition, and **who** has authority over each transition.

Today the lifecycle is implemented across `packages/core/src/ingest.ts`, `packages/core/src/extract/index.ts`, and `packages/core/src/watch.ts` — the rules are correct but scattered, with no single document specifying them. This ADR records them so future producers, consumers, and tests don't have to reverse-engineer the policy from code.

**Decision.**

### 1. Node creation

- **Static creation** lives in `packages/core/src/extract/`. `services.ts`, `databases/index.ts`, `configs.ts`, and `infra/*` are the only sites that produce typed nodes (Service, Database, Config, Infra). Each producer constructs the id via `@neat.is/types/identity` helpers (ADR-028). Each producer is idempotent — `graph.hasNode(id)` guards every `addNode` call, so a re-extract does not duplicate.

- **Auto-creation from OTel** is queued under issue #134. When an OTel span arrives for a `service.name` not present in the graph, `ingest.ts` will create a minimal `ServiceNode` at `serviceId(span.service)`. Static extraction that later finds the same service merges into the auto-created node by id; static fields (language, version, dependencies) override; OTel-derived fields (`lastObserved` on associated edges) survive untouched. **The id is the merge key.** This is the reconciliation rule from ADR-028 §3 applied at the lifecycle layer.

- **FrontierNode creation** lives in `ingest.ts`. When `handleSpan` resolves a peer host that doesn't match any known service or database, it creates a `FrontierNode` at `frontierId(host)` and an OBSERVED edge from the source service to the FrontierNode (the FRONTIER edge variant of the same call). The FrontierNode is a placeholder; the call itself is real and stays observed.

### 2. Node transitions

- **FrontierNode → typed node (promotion).** `promoteFrontierNodes(graph)` in `ingest.ts:408` runs after each extract pass (`extract/index.ts:42`) and after each `watch` tick (`watch.ts:153`). For every FrontierNode whose `host` matches a known service alias, the FrontierNode is dropped and edges that pointed at it are rewritten to point at the typed node. The FrontierNode never persists as a partial state — promotion is atomic per node.

- **Edge rewrite during promotion.** Each edge incident to the promoted FrontierNode is dropped and rebuilt under the typed-node id (`rewireFrontierEdges` + `rebuildEdge` in `ingest.ts:436-470`). On rewrite, `FRONTIER` provenance is **upgraded to `OBSERVED`** because the call certainty was always there — only the target identity was unknown, and now it isn't. Other provenance values pass through unchanged.

### 3. Node retirement

- **Today: only via FrontierNode promotion.** A FrontierNode is dropped when promoted; nothing else gets retired automatically.

- **Ghost-node cleanup (queued under #140).** When a service disappears from source between extract passes, the `ServiceNode` (and its associated edges) should be retired. The contract is: retirement is **driven by source absence**, not by clock decay. Static-extracted nodes don't have a `lastObserved`; they exist while their source declaration exists. This is the lifecycle counterpart to ghost-edge cleanup; both block on the source-mtime tracking work in #140.

### 4. Edge creation

- **Static (EXTRACTED).** `extract/*` producers via `extractedEdgeId(...)`. Idempotent via `graph.hasEdge(id)` guard.
- **Observed (OBSERVED).** `upsertObservedEdge` in `ingest.ts:218`. Idempotent: if the edge id exists, attributes are replaced; otherwise the edge is created. **Returns `null` if either endpoint node is missing** (`ingest.ts:226`) — this is the gap issue #134 closes by auto-creating missing nodes.
- **Inferred (INFERRED).** `upsertInferredEdge` in `ingest.ts:298`. Created by the trace stitcher on error spans, depth ≤ 2 from the originating service. Confidence ≤ 0.7, default 0.6.
- **Frontier (FRONTIER).** `upsertFrontierEdge` in `ingest.ts:181`. Created when OTel resolves a peer to no known node.

### 5. Edge transitions (binding rules)

- **OBSERVED → STALE.** `markStaleEdges` in `ingest.ts:521`, called by the background staleness loop (`startStalenessLoop`, default 60s tick). Per-edge-type thresholds (ADR-024). The transition is in place — the edge id stays at `${type}:OBSERVED:${source}->${target}`; only `provenance` flips to `STALE` and `confidence` drops to `0.3`. `lastObserved` is preserved. Each transition appended to `stale-events.ndjson`.

- **STALE → OBSERVED (resurrection).** When a new span arrives for an existing STALE edge, `upsertObservedEdge` overwrites `provenance` back to `OBSERVED` and `confidence` back to `1.0` (`ingest.ts:233-244`). **The transition is implicit — there is no explicit "resurrect" function.** The id stayed the same through the STALE phase, so the upsert finds the existing edge and replaces attributes.

- **FRONTIER → OBSERVED.** Only via FrontierNode promotion (see §2). Never standalone — a FRONTIER edge cannot become OBSERVED without its FrontierNode endpoint resolving to a typed node.

- **No other transitions exist.** EXTRACTED never decays. INFERRED never transitions. STALE never goes anywhere except back to OBSERVED via resurrection.

### 6. Edge retirement

- **Today: only via FrontierNode promotion.** Edges incident to a promoted FrontierNode get dropped and rebuilt; the old edge is gone.

- **Ghost-edge cleanup (issue #140).** When a source file is edited or removed, EXTRACTED edges that were derived from that file should be retired. Today this doesn't happen — re-extraction adds new edges but never removes old ones. The fix is part of the v0.2.1 tree-sitter rebuild and depends on `evidence.file` being present on every EXTRACTED edge (queued under the same issue).

### 7. Authority — who owns what transition

| Transition                        | Owner module                  |
|-----------------------------------|-------------------------------|
| Static node creation              | `extract/*`                   |
| Static edge creation              | `extract/*`                   |
| OBSERVED edge upsert              | `ingest.ts` `upsertObservedEdge` |
| INFERRED edge creation            | `ingest.ts` `upsertInferredEdge` (via `stitchTrace`) |
| FRONTIER node creation            | `ingest.ts` `handleSpan`      |
| FRONTIER edge creation            | `ingest.ts` `upsertFrontierEdge` |
| OBSERVED → STALE                  | `ingest.ts` `markStaleEdges` (background loop) |
| STALE → OBSERVED                  | `ingest.ts` `upsertObservedEdge` (implicit on re-arrival) |
| FrontierNode → typed (+ edge rewrite + FRONTIER → OBSERVED) | `ingest.ts` `promoteFrontierNodes`, triggered by `extract/index.ts` and `watch.ts` |
| Ghost-edge / ghost-node cleanup   | `watch.ts` (queued under #140)|
| Auto-create ServiceNode/DatabaseNode from OTel | `ingest.ts` `handleSpan` (queued under #134) |

`traverse.ts`, `compat.ts`, `persist.ts`, `api.ts`, and `packages/mcp/src/` **never** mutate node or edge state. They are read-only consumers of the lifecycle.

### 8. Idempotency

Every creation path is idempotent: re-running the same producer with the same input produces the same graph state. `graph.hasNode(id)` and `graph.hasEdge(id)` guards make this hold even when watch-driven re-extraction fires the same producer many times. Tests in `packages/core/test/` exercise idempotency directly (e.g. `discover-services.test.ts`).

### 9. Atomicity

Each lifecycle operation is synchronous within a single call to its owner function. `handleSpan` runs to completion against the graph before yielding (the only `await` is the trailing `appendErrorEvent` after mutations are settled). `promoteFrontierNodes` rewires all incident edges and drops the FrontierNode in one synchronous pass. `markStaleEdges` walks the edge set in a single pass. There is no point at which a partial transition is observable to a concurrent reader.

This relies on Node's single-threaded event loop and is sufficient for MVP scale. If NEAT later needs concurrent multi-process ingest, atomicity becomes an explicit concern and gets its own ADR.

**Enforcement.**

`packages/core/test/audits/contracts.test.ts` adds:
- An assertion that no module outside `packages/core/src/ingest.ts` and `packages/core/src/extract/` mutates the graph (no `dropNode`, `dropEdge`, `addNode`, `addEdge*`, `replaceEdgeAttributes`, `replaceNodeAttributes` calls).
- Behavioral assertions: STALE → OBSERVED resurrection (edit a STALE edge's lastObserved → call upsertObservedEdge → confirm provenance flips back, confidence is 1.0); FRONTIER → OBSERVED on promotion.

`docs/contracts/lifecycle.md` records the binding rules in short form, governs the same files as the provenance contract plus `watch.ts` and `extract/index.ts`.

**What this ADR is not deciding.**

Schema growth versus shape changes (contract #4, the next ADR). The exact shape of `evidence` on EXTRACTED edges (queued under #140 + the v0.2.1 tree-sitter rebuild). Auto-creation of ServiceNode/DatabaseNode from OTel (queued under #134, lands in v0.2.2). Ghost cleanup (queued under #140, lands in v0.2.1). Each of those is an implementation; this ADR specifies the rules they must implement.

**When to revisit.**

When ghost cleanup ships (#140) or auto-creation ships (#134) — both will refine the lifecycle table and move items out of "queued" status. When concurrent multi-process ingest becomes a real requirement (post-v1.0 or post-eBPF), atomicity needs its own ADR.

---

## ADR-031 — Schema growth versus schema shape

**Date:** 2026-05-05
**Status:** Active.

The fourth and final data-layer contract. ADR-028, ADR-029, and ADR-030 locked node identity, edge identity + provenance, and lifecycle. Each one expects the underlying schemas in `@neat.is/types` to remain stable in shape while still being allowed to grow. This ADR pins down the difference.

**The distinction.**

- **Growth** is **additive**. A new optional field on an existing schema. A new helper export. An extra non-breaking method. Code written against the previous schema continues to work; data persisted under the previous schema continues to load. No migration needed.

- **Shape change** is **breaking**. Renaming a field. Changing a field's type (`string` → `number`). Removing a field. Removing or renaming an enum value. Tightening a refinement so previously-valid data no longer parses. Changing a discriminated-union discriminator. Code written against the previous schema breaks; data persisted under the previous schema fails to load without migration.

The two have different costs and different processes. Growth is cheap and frequent. Shape change is expensive, rare, and gated.

**Decision.**

1. **Growth is allowed in any commit, no ADR required.**

   Adding `framework?: string` to `ServiceNodeSchema` (issue #142) is growth. Adding `extractedAt?: string` to GraphEdge `evidence` (issue #140) is growth. Adding a new value to `EdgeType` (e.g. `EMITS` if a new edge type lands) is growth, since older code that switches over `EdgeType` simply doesn't match the new value — it doesn't crash. The schema snapshot is updated in the same commit; the snapshot diff is the audit trail.

2. **Shape change requires an ADR opened in the same PR.**

   The ADR records:
   - What changed (field removed, type changed, enum value removed, etc.).
   - Why the breaking change is justified.
   - How the persistence layer migrates old data (`packages/core/src/persist.ts` v→v+1 migration code).
   - How long the migration is supported (typically: at least one minor version after introduction).

   Examples of shape changes the project has already made: ADR-019 (`pgDriverVersion` removed from ServiceNode, snapshot v1→v2 migration in `persist.ts`).

3. **Migration path is `persist.ts`.**

   The snapshot loader at `packages/core/src/persist.ts` runs version-keyed migrations. Each shape-change ADR adds a new migration function and bumps the persisted version. The migration is *one-way* (forward only); we don't support downgrade. Old snapshots load cleanly into the new schema; new snapshots can't be loaded by old code, which is fine because we ship newer code in newer releases.

4. **Enforcement is mechanical via a schema snapshot.**

   `packages/core/test/audits/schema-snapshot.test.ts` introspects every binding schema in `@neat.is/types` (`GraphNodeSchema`, `GraphEdgeSchema`, `ProvenanceSchema`, `EdgeTypeSchema`, `ErrorEventSchema`, `RootCauseResultSchema`, `BlastRadiusResultSchema`, plus the FrontierNode / individual node schemas) and produces a normalized JSON tree describing fields, types, enum values, discriminator keys.

   The tree is compared against `packages/core/test/audits/schemas.snapshot.json`. If they differ, the test fails with a message instructing the developer to either:
   - Run the snapshot updater (a small script), commit the diff in the same PR if the change is growth.
   - Or open an ADR documenting the shape change, then update the snapshot.

   The developer can't quietly break shape — the snapshot fails before merge. The git diff on the snapshot is a structural record of every schema change the project has ever made.

5. **What counts as "binding" for the snapshot.**

   Anything in `@neat.is/types` that consumers depend on:
   - `GraphNodeSchema` and the five node variants.
   - `GraphEdgeSchema`.
   - `ProvenanceSchema` (enum values).
   - `EdgeTypeSchema` (enum values).
   - `ErrorEventSchema`.
   - Result schemas (`RootCauseResultSchema`, `BlastRadiusResultSchema`).
   - Identity helpers' output types are *not* snapshotted — those are functions, not data structures, and ADR-028 / ADR-029 govern them directly.

   Internal Zod refinements (`.min()`, `.max()`, `.regex()`) are recorded in the snapshot when they're load-bearing for downstream consumers (e.g. `confidence: z.number().min(0).max(1)`). Cosmetic refinements (`.describe()` strings used for LLM hints) are excluded.

6. **Growth is encouraged when consumers ask for it.**

   The contract is permissive for growth specifically because future producer / consumer rebuilds (v0.2.1 tree-sitter, v0.2.2 OTel, v0.2.3 traversal, v0.2.4 policies) will each ask for new optional fields. The default answer is "yes — add the optional field, snapshot the change, ship." The friction is reserved for shape changes, which deserve discussion.

**Why this contract is small.**

ADR-031 doesn't add helpers or refactor code. It's a meta-contract — the rule for how the previous three contracts evolve. The snapshot test is the entire enforcement mechanism. No new module, no new helper, no new abstraction.

**What this ADR is not deciding.**

Specific schema additions queued for v0.2.x cleanup (`framework`, `evidence.file` on every EXTRACTED edge, `path` and `confidence` on `BlastRadiusAffectedNode`). Those land under their respective issues (#142, #140, #137) and trip the snapshot fail in CI; the developer commits the new snapshot alongside the implementation.

**When to revisit.**

When the snapshot file becomes hard to review — say it grows past 500 lines and a real shape change is hard to spot in the diff. At that point we either split the snapshot per schema or write a smarter diff tool. Today the schema set is small enough that a single JSON file is sufficient.

---

## ADR-032 — Static extraction contract

**Date:** 2026-05-05
**Status:** Active.

The first producer-layer contract. Static extraction (`packages/core/src/extract/**`) is the producer that reads source code and config files to build the EXTRACTED layer of the graph. Today's producers work but disagree on what evidence they carry, when re-extraction retires old edges, and what counts as a producer at all. v0.2.1's tree-sitter rebuild needs these locked before the cleanup issues (#140, #141, #142, #145) can ship without re-introducing drift.

**Decision.**

1. **Every EXTRACTED edge carries `evidence: { file, line?, snippet? }`.** Today only CALLS-family edges do (`calls/http.ts`, `calls/aws.ts`, `calls/kafka.ts`, `calls/grpc.ts`, `calls/redis.ts`). CONNECTS_TO (databases), CONFIGURED_BY (configs), DEPENDS_ON / RUNS_ON (infra) edges currently have no evidence. The contract growth: every producer that writes an EXTRACTED edge attaches at least `evidence.file` — the source path the edge was derived from, relative to the scan root, forward slashes regardless of platform. `line` and `snippet` are optional but strongly preferred when the producer can compute them cheaply.

2. **Ghost-edge cleanup is keyed on `evidence.file`.** When a file changes or disappears between extract passes, every EXTRACTED edge whose `evidence.file` matches that path is dropped before the producer reruns. Re-extraction recreates the edges that still apply; the deleted code's edges stay deleted. The cleanup is owned by `watch.ts` per ADR-030's lifecycle authority — it fires the producer's path-keyed retire step, then reruns the producer. This closes the v0.1.x bug where re-extraction accumulates stale edges indefinitely (issue #140).

3. **Producer interface.** Every producer module under `extract/` exports a single async function with the signature `(graph: NeatGraph, services: DiscoveredService[], scanPath: string) => Promise<...>`. Producers are pure with respect to graph state outside their own writes — they never read the OBSERVED layer, never call `compat.json` outside `compat.ts`, never trigger MCP or REST. They can read from the filesystem within `scanPath` and from each service's `dir`. They emit nodes and edges via `graph.addNode` / `graph.addEdgeWithKey`, guarded by `hasNode` / `hasEdge` for idempotency.

4. **Language dispatch.** Source-file parsing routes by extension: `.js` / `.jsx` / `.mjs` / `.cjs` / `.ts` / `.tsx` use the `tree-sitter-javascript` grammar (TypeScript falls through; using `tree-sitter-typescript` is a future improvement, not in scope for this contract). `.py` uses `tree-sitter-python`. Other extensions are skipped silently by `walkSourceFiles` per `IGNORED_DIRS` and the `SERVICE_FILE_EXTENSIONS` set in `extract/shared.ts`. New language support requires adding the grammar import and the extension dispatch in one place.

5. **Depth and ignore policy.** Recursive directory walk from `scanPath` is bounded by `NEAT_SCAN_DEPTH` (default 5, configurable). `.gitignore` is honored. `IGNORED_DIRS` (`node_modules`, `.git`, `.turbo`, `dist`, `build`, `.next`, plus `__pycache__` and `vendor` once added — see issue #142's neighborhood) is the canonical skip set. `package.json#workspaces` triggers monorepo expansion; `pnpm-workspace.yaml` and `turbo.json` are not yet read (deferred).

6. **Idempotency under re-extraction.** Every producer is idempotent: re-running the same producer on the same input produces the same graph state. `graph.hasNode(id)` and `graph.hasEdge(id)` guards already enforce this; the contract reaffirms it. Idempotency is what makes ghost-edge cleanup safe — the path-keyed retire step plus re-extraction always converges on the source's current state.

7. **`framework` on ServiceNode is schema growth, not a new contract.** Issue #142's `framework?: string` field is governed by the schema-growth contract (ADR-031) — `ServiceNodeSchema` gains an optional field, the snapshot regenerates, the producer in `extract/services.ts` populates it from a package-name → framework-label table. This contract names the population rule (read from `dependencies` and `devDependencies`) but the schema-snapshot guard handles enforcement.

**Producers in scope (the locked set).**

- `services.ts` — ServiceNode from `package.json` and `pyproject.toml`.
- `aliases.ts` — host:port aliases for FrontierNode promotion (governed by the lifecycle contract; this contract just confirms it as a producer).
- `databases/*` — DatabaseNode + CONNECTS_TO from ORM configs, `.env`, docker-compose. Today no evidence; #140 fixes that.
- `configs.ts` — ConfigNode + CONFIGURED_BY for yaml / yml / `.env` files.
- `calls/*` — source-level CALLS / PUBLISHES_TO / CONSUMES_FROM edges via HTTP URLs, AWS SDK, gRPC, Kafka, Redis. Today carries evidence — keep.
- `infra/*` — InfraNode + DEPENDS_ON / RUNS_ON from docker-compose, Dockerfile, k8s, Terraform.
- New producers under `calls/` for source-level DB connections (`new pg.Pool(...)`) and inter-service imports — issue #141. Same evidence shape, same idempotency, same interface.

**Enforcement.**

`packages/core/test/audits/contracts.test.ts` adds:
- A scan asserting every EXTRACTED-edge construction site under `packages/core/src/extract/` includes an `evidence` field with at least a `file` key. Currently CALLS-family producers pass; CONNECTS_TO / CONFIGURED_BY / DEPENDS_ON / RUNS_ON producers fail until #140 lands. The assertion lands as `it.todo` keyed to #140 and flips when the issue closes.
- A producer-interface assertion: every module under `extract/` exporting a function whose name matches `add(Service|Database|Config|Edge|Infra)Nodes?|add\w+Edges?` accepts `(graph, services, scanPath)` (or a strict subset). Catches drift toward producer signatures that diverge.
- An idempotency test: run a producer twice on the same fixture, assert node/edge count unchanged.

`docs/contracts/static-extraction.md` records the binding rules in short form and is auto-surfaced by the PreToolUse hook whenever any file under `extract/` is edited.

**What this ADR is not deciding.**

The shape of source-level DB-connection detection (issue #141 — that's an implementation choice within the producer interface). Whether `tree-sitter-typescript` should replace the JS-falls-through approach (deferred — TS fallback works, the grammar swap is its own cleanup). The framework-detection package-name table (lives in `compat.json` or a sibling data file, not in the contract). Workspace-scoped service ids (deferred per ADR-028). Dev-container handling (deferred per the init audit's open questions).

**When to revisit.**

When source-level DB-connection detection (#141) lands — that introduces a new producer pattern (`new pg.Pool(...)` etc.) and the contract may need to specify its evidence shape more precisely (e.g. constructor-name in the snippet). When ghost-edge cleanup (#140) ships — the contract's path-keyed retire step becomes load-bearing and might surface edge cases.

---

## ADR-033 — OTel ingest contract

**Date:** 2026-05-05
**Status:** Active.

The first of three v0.2.2 producer-layer contracts. Governs the OTel ingest path in `packages/core/src/ingest.ts` plus the receiver in `otel.ts` and `otel-grpc.ts`. Sibling contracts: ADR-034 (trace stitcher) and ADR-035 (FrontierNode promotion). They share vocabulary and govern overlapping concerns; together they lock the OBSERVED layer.

**Decision.**

1. **Receiver replies before mutation (issue #131).** The OTLP/HTTP receiver in `packages/core/src/otel.ts` and the gRPC receiver in `packages/core/src/otel-grpc.ts` reply 200 OK immediately on receipt. Mutation runs through a non-blocking handler — either an in-process queue drained on the next tick, or a fire-and-forget pattern with bounded concurrency. **The sender is never blocked on graph mutation.** OTel SDK exporters retry on timeout, so blocking ingest causes observable backpressure on the system being observed; ambient observation requires no observable effect.

2. **`lastObserved` is sourced from `span.startTimeUnixNano`, not `Date.now()` (issue #132).** Every OBSERVED edge's `lastObserved` field is derived from the parsed span's start time, converted to ISO8601. Replayed traces, out-of-order spans, and historical fill-ins must produce a `lastObserved` that reflects when the span actually fired — not when the receiver happened to receive it. The ISO8601 conversion lives in `parseOtlpRequest` (otel.ts) so every consumer of `ParsedSpan.startTimeUnixNano` gets a normalized form.

3. **Cross-service CALLS edges correlate via parent-span cache (issue #133).** Today peer resolution uses `server.address` / `net.peer.name` / `url.full` only. That misses non-HTTP RPCs and any span whose peer is opaque. The contract adds a bounded TTL cache keyed by `${traceId}:${spanId}` storing each span's service. On span arrival, peer resolution falls through to a `parentSpanId` lookup in the cache: if the parent's service is known and differs from the current service, that's a cross-service CALLS edge. Cache size and TTL are constants near the other ingest tunables in `ingest.ts`. Out-of-order arrival (child before parent) drops the child cleanly; we don't buffer.

4. **Auto-creation of ServiceNode and DatabaseNode for unseen peers (issue #134).** When `handleSpan` resolves a `service.name` not present in the graph, it creates a minimal ServiceNode at `serviceId(span.service)` with `language: 'unknown'`, no `version`, no `dependencies`. Same for unseen `db.system` + host — a minimal DatabaseNode at `databaseId(host)`. Auto-created nodes carry `discoveredVia: 'otel'` (schema growth governed by ADR-031 — adds an optional field to ServiceNode/DatabaseNode, snapshot regenerates). Static extraction that later finds the same id **merges** attributes per ADR-028 §3 reconciliation rule; static fields override OTel-derived fields where both exist, but `discoveredVia` is only updated to `'merged'` if both layers recorded the node independently.

5. **Exception data parsed from span events (issue #135).** `OtlpSpan` is extended with `events: Array<{ name, timeUnixNano, attributes }>` in the parser. When a span has an `events[]` entry with `name === 'exception'`, the parser extracts `exception.type`, `exception.message`, and `exception.stacktrace` from its attributes. `handleSpan`'s ErrorEvent path prefers `exception.message` over `status.message` over `span.name`. `exception.type` is added to ErrorEvent as an optional field (schema growth via ADR-031).

6. **HTTP receiver supports both JSON and protobuf bodies.** Today only JSON. The receiver checks `Content-Type` and dispatches to either `parseOtlpJsonRequest` or `parseOtlpProtobufRequest`. Protobuf parsing uses the bundled `.proto` definitions (ADR-020). gRPC continues to handle protobuf natively.

7. **`db.system` is data, not a switch.** Engine identification is read from the span attribute as a string and never compared against a hardcoded list (no `if (db.system === 'postgresql')` branches). Engine-specific behavior lives in `compat.json` and is consulted via `compat.ts` per the demo-name-freedom contract (Rule 8 in `docs/contracts.md`).

8. **Error events are ndjson-appended, never lost on receiver shutdown.** `appendErrorEvent` writes to `errors.ndjson` synchronously after the graph mutation but before the receiver replies — this is the one explicit ordering point. If the file write fails, the receiver returns 500 so the OTel SDK retries. ErrorEvent shape stays as defined in `@neat.is/types` per the schema-growth contract; new fields land via the snapshot guard.

**Authority.**

The OTel ingest contract is owned by `packages/core/src/ingest.ts` per ADR-030 lifecycle authority. The receiver shape lives in `otel.ts` / `otel-grpc.ts`; mutation logic lives in `ingest.ts`. Neither file may be mutated outside the producer-author's edits during v0.2.2.

**Enforcement.**

`packages/core/test/audits/contracts.test.ts` adds `it.todo` items keyed to issues #131-#135. They flip to live assertions as each issue ships:
- non-blocking ingest (timing-based test on the receiver),
- `lastObserved` from span time (replay-a-backdated-span fixture),
- parent-span cache correlation (parent-then-child fixture, child-then-parent fixture),
- auto-creation (span for unseen service produces ServiceNode),
- exception event parsing (span with `events[]` produces ErrorEvent with exception fields).

**What this ADR is not deciding.**

Trace stitcher rules — see ADR-034. FrontierNode promotion — see ADR-035. Whether `discoveredVia` becomes a generalized provenance-on-nodes field (deferred — today it's a service/database-level concern, not a node-shape concern). eBPF / mesh-Net source variants (deferred to v1.0+ per the v0.2.x discussion).

**When to revisit.**

When auto-creation lands and OTel-only services start landing in real codebases — the merge rules (#4) might surface edge cases the contract didn't anticipate. When a non-Node OTel SDK arrives that uses semconv variants the parser doesn't handle — the address picker (`pickAddress`) might need extension.

---

## ADR-034 — Trace stitcher contract

**Date:** 2026-05-05
**Status:** Active.

Governs the trace stitcher in `packages/core/src/ingest.ts` (`stitchTrace`, `upsertInferredEdge`). The trace stitcher is what bridges OBSERVED gaps when an instrumentation library can't emit spans for a particular driver — the demo's pg 7.4.0 case (PROVENANCE.md, ADR-027). It's the load-bearing concrete example of NEAT's value: when declared intent and observed reality diverge, NEAT infers the bridge and labels it as inferred.

Sibling contracts: ADR-033 (OTel ingest), ADR-035 (FrontierNode promotion).

**Decision.**

1. **Stitcher fires only on ERROR spans.** `stitchTrace` is called by `handleSpan` only when `span.statusCode === 2`. The stitcher's job is to surface inferred dependency paths when an erroring service was exercising downstream services that may not have been observed directly. Non-error spans don't trigger inference — if the call succeeded, the OBSERVED layer captured what it could and INFERRED edges aren't needed.

2. **Depth limit of 2 hops, hardcoded.** `STITCH_MAX_DEPTH = 2` in `ingest.ts`. Walking deeper produces speculative edges that are too far from the originating error to claim relevance. The constant is a contract value, not a tunable — changing it requires an ADR amendment.

3. **Walks EXTRACTED outbound edges only.** The stitcher BFS-walks `graph.outboundEdges(node)` and considers only edges where `provenance === Provenance.EXTRACTED`. OBSERVED edges already carry the relationship (no inference needed). INFERRED edges are themselves the stitcher's output (no recursion). FRONTIER edges represent unknown territory and are excluded per Rule 3 of `docs/contracts.md`. STALE edges represent decayed observation and are not inferable from a fresh error.

4. **OBSERVED-twin skip rule (issue: refinement).** When the stitcher considers an EXTRACTED edge `(source, target, type)`, it checks whether an OBSERVED edge for the same triplet already exists (`graph.hasEdge(observedEdgeId(source, target, type))`). If so, the OBSERVED edge already provides ground-truth coverage for that hop — the stitcher skips it and does not produce an INFERRED twin. Today the stitcher writes INFERRED edges regardless of OBSERVED twins; the rule closes that gap.

5. **Confidence is `0.6` by default, capped at `0.7`.** `INFERRED_CONFIDENCE = 0.6` is the default applied at edge creation. The stitcher does not produce edges with confidence > 0.7 even if a custom override is added later — INFERRED is by definition less trustworthy than OBSERVED, which carries `1.0`. The cap is a contract value.

6. **Idempotent on re-arrival.** When a second error span produces the same stitched edges, `upsertInferredEdge` updates `lastObserved` on the existing edge — it does not create duplicates, does not increment a confidence score, does not add evidence. The edge id (`inferredEdgeId(source, target, type)`) is the deduplication key.

7. **Origin generality.** `stitchTrace(graph, sourceServiceId, ts)` accepts any `service:*` id as the origin. No special-case for the demo (`service:service-b`); no hardcoded driver ('pg'); no hardcoded engine ('postgresql'). The stitcher walks whatever EXTRACTED edges exist outbound from the erroring service.

8. **No node creation.** The stitcher only writes edges. It never creates nodes; it never modifies existing nodes; it doesn't extend across FrontierNode boundaries.

**Authority.**

`stitchTrace` is owned by `ingest.ts` per ADR-030. Called only from `handleSpan` (error path). No other module triggers stitching.

**Enforcement.**

`contracts.test.ts` includes:
- A live test asserting `stitchTrace` produces no edges when called with a node that has no outbound EXTRACTED edges.
- A live test asserting `STITCH_MAX_DEPTH` is enforced (depth-3 EXTRACTED chain produces edges only at depth 1 and 2).
- An `it.todo` keyed to the OBSERVED-twin-skip refinement, which lands when implementation does.
- An idempotency test (calling `stitchTrace` twice produces identical edge state).

**What this ADR is not deciding.**

Per-edge confidence beyond the default 0.6 (no implementation requires it today). Stitcher behavior on FRONTIER edges (excluded — never traversable). Stitching across multiple traces (single-trace context only; cross-trace inference is a v1.0 concern).

**When to revisit.**

When a real codebase's INFERRED layer becomes load-bearing for the MVP-success PR (ADR-027) and the depth-2 limit produces too many or too few edges. When OBSERVED coverage improves enough that the stitcher fires rarely — at that point the OBSERVED-twin-skip rule is doing most of the work and the contract may simplify.

---

## ADR-035 — FrontierNode promotion contract

**Date:** 2026-05-05
**Status:** Active.

Governs `promoteFrontierNodes` in `packages/core/src/ingest.ts`. FrontierNodes (ADR-023) are placeholders for OTel peers that don't match any known service. Promotion is the act of replacing a FrontierNode with a real typed node once an alias resolves the host. The contract locks the trigger conditions, alias-match rules, edge-rewrite semantics, and the FRONTIER → OBSERVED provenance upgrade.

Sibling contracts: ADR-033 (OTel ingest), ADR-034 (trace stitcher).

**Decision.**

1. **Promotion runs after every extract pass.** `promoteFrontierNodes(graph)` is called at the end of `extract/index.ts:extractFromDirectory` and at the end of every watch-driven phase rerun in `watch.ts`. Promotion is **batched per pass**, not per-edge. The ingest path itself does not trigger promotion — only the static-extraction lifecycle does, because aliases land during static extraction.

2. **Alias matching: name first, then alias list.** The function walks every ServiceNode and builds a `Map<string, string>` from `attrs.name → id` and `attrs.aliases[i] → id`. Then it walks every FrontierNode and looks up `attrs.host` in the map. First match wins. If the FrontierNode's host doesn't resolve, the FrontierNode persists for the next extract pass to handle. **Aliases are populated by `extract/aliases.ts`** — typically docker-compose service names, k8s metadata.name, Dockerfile labels.

3. **Promotion is atomic per FrontierNode.** When a FrontierNode is selected for promotion, all of its incident edges (inbound and outbound) are rewired to the typed node id, and the FrontierNode is dropped — in one synchronous pass. There is no point at which a partial state is visible. ADR-030 §9 atomicity applies.

4. **Edge rewrite rebuilds the edge under the new id.** `rewireFrontierEdges` walks `graph.inboundEdges(frontierId)` and `graph.outboundEdges(frontierId)`. For each, `rebuildEdge` drops the old edge and constructs a new edge under the typed-node id. This is the only place in the codebase where an edge id changes — not because the edge content changed, but because one of its endpoints did.

5. **Provenance upgrade rule: FRONTIER → OBSERVED.** When `rebuildEdge` is rewriting an edge whose provenance was `FRONTIER`, the new edge's provenance is `OBSERVED`. The reasoning: the call certainty was always there (the OTel span was observed), only the target identity was unknown. Now it's known, so the edge graduates from placeholder to direct measurement. Other provenance values (EXTRACTED, INFERRED) pass through unchanged.

6. **Edge id construction MUST use the canonical helpers.** `rebuildEdge` constructs the new edge id via `observedEdgeId`, `inferredEdgeId`, etc. from `@neat.is/types/identity` (ADR-029). Hand-rolling a template literal like `` `${edge.type}:${promotedProvenance}:${newSource}->${newTarget}` `` is a contract violation. **Today's `rebuildEdge` at `ingest.ts:463` does hand-roll this id** — a v0.2.2 cleanup task: replace the literal with a dispatch on `promotedProvenance` to the appropriate canonical helper. The contracts.test.ts scan (#2) didn't catch it because the literal interpolates the provenance variable rather than embedding `:OBSERVED:` directly. The scan is extended in this batch.

7. **Edge merge on collision.** If the rewritten edge id already exists (because an OBSERVED edge between the typed source and target was previously created independently), the rebuilt edge merges into the existing one: `callCount` sums, `lastObserved` takes the later timestamp via `pickLater`. No duplicate edge is created.

8. **No reverse promotion.** A typed node never reverts to a FrontierNode. If OTel later observes a peer that matches no known service, a *new* FrontierNode is created at a different host id; the previously-promoted typed node is unaffected.

**Authority.**

`promoteFrontierNodes` is owned by `ingest.ts` per ADR-030. Triggered by `extract/index.ts` and `watch.ts`. No other module calls it.

**Enforcement.**

`contracts.test.ts` includes:
- A live test asserting alias-matched FrontierNode is promoted, edges are rewired, FRONTIER provenance becomes OBSERVED on rebuilt edges (already exists from contract #3 lifecycle work — extended here to also assert id construction routes through `observedEdgeId`).
- A new live test asserting `rebuildEdge` does not hand-roll edge id template literals — extended hand-rolled-template-literal scan that includes the provenance-variable case (catches `${edge.type}:${promotedProvenance}:...`).
- An `it.todo` keyed to the rebuildEdge-uses-canonical-helpers fix, which lands as part of the v0.2.2 cleanup against this contract.

**What this ADR is not deciding.**

Cross-host-port database ids (deferred per ADR-028 §6). Workspace-scoped service ids that change the alias-matching shape (deferred per ADR-028 §5). Promotion across project scopes (single-project per ADR-026; cross-project promotion is post-multi-project work).

**When to revisit.**

When workspace scoping lands and aliases need to scope to a workspace. When the alias index becomes a bottleneck on large monorepos (today rebuilt every promotion call; could be cached if the call frequency justifies it).

---

## ADR-036 — Traversal contract

**Date:** 2026-05-06
**Status:** Active.

The first of three v0.2.3 consumer-layer contracts. Governs `packages/core/src/traverse.ts` overall — the shared mechanics (edge priority, confidence cascading, FRONTIER exclusion, no-mutation rule) that both `getRootCause` and `getBlastRadius` rely on. Sibling contracts: ADR-037 (getRootCause), ADR-038 (getBlastRadius). They share vocabulary; the three together lock the read-side of the graph.

**Decision.**

1. **Edge priority is `PROV_RANK` at every hop.** When multiple edges connect the same node pair under different provenances (the coexistence case from contract #2), traversal picks the highest-priority edge via `PROV_RANK` from `@neat.is/types/identity`. `bestEdgeBySource` and `bestEdgeByTarget` apply this rule per neighbour. Selection happens at every step of the walk, not just the starting node.

2. **FRONTIER edges are excluded, not deprioritized (issue #136).** Today FRONTIER ranks 0 alongside STALE in `PROV_RANK`. That makes it pickable when no other edge exists between a pair — wrong per Rule 3 of `docs/contracts.md`. The contract: `bestEdgeBySource` / `bestEdgeByTarget` skip every edge with `provenance === FRONTIER` before ranking. If a node's only edges are FRONTIER, traversal halts at that node — `getRootCause` returns null, `getBlastRadius` does not enqueue past it.

3. **Confidence cascades via product, not min.** Per-edge confidence is `provenance × volume × recency × cleanliness` (`confidenceForEdge`). Walks of multiple edges multiply per-edge confidences (`confidenceFromMix`). The min-rule from earlier framing is superseded — the multiplicative cascade is the real implementation and the more honest semantic: each hop is an independent piece of evidence, and uncertainty compounds.

4. **No mutation.** `traverse.ts` is read-only per ADR-030 lifecycle authority. It calls only `graph.hasNode`, `graph.getNodeAttributes`, `graph.getEdgeAttributes`, `graph.inboundEdges`, `graph.outboundEdges`. It must never call `addNode`, `addEdge`, `dropNode`, `dropEdge`, `replaceEdgeAttributes`. The mutation-authority scan in `contracts.test.ts` already catches this.

5. **Schema validation before return.** Both `getRootCause` and `getBlastRadius` MUST call `RootCauseResultSchema.parse(...)` / `BlastRadiusResultSchema.parse(...)` on the result before returning (issue #139). A schema violation throws, which the API handler converts to a 500. Better that than shipping a malformed result to MCP or REST consumers.

6. **Origin must exist.** Both functions handle `!graph.hasNode(originId)` gracefully — `getRootCause` returns `null`, `getBlastRadius` returns `{ origin, affectedNodes: [], totalAffected: 0 }`. Neither throws.

7. **Helpers from `@neat.is/types/identity` for any id construction or parsing.** Traversal occasionally synthesizes ids (e.g. checking for an OBSERVED twin during stitcher work — see contract #7) or parses ids back to their parts. Both operations route through `parseEdgeId` / `observedEdgeId` / etc. Hand-rolled template literals are a contract violation.

**Authority.**

`traverse.ts` is a read-only consumer. Owns no transitions. Reads from the live graphology instance per Rule 6 of `docs/contracts.md` — never reads `graph.json`.

**Enforcement.**

`packages/core/test/audits/contracts.test.ts` includes (or adds for v0.2.3):
- The mutation-authority scan already covers traverse.ts (assertion: zero mutating calls outside `ingest.ts` / `extract/*`).
- A live test for FRONTIER exclusion: a graph where the only path between two nodes is via a FRONTIER edge. `getRootCause` returns null; `getBlastRadius` does not include the far-side node. (Issue #136.)
- A live test for schema validation: the `RootCauseResult` and `BlastRadiusResult` returned by traversal must `.parse()` cleanly against their Zod schemas. (Issue #139.)
- Round-trip tests on `confidenceFromMix` to assert multiplicative cascading.

**What this ADR is not deciding.**

`getRootCause`-specific concerns (origin generality, reason format) — see ADR-037. `getBlastRadius`-specific concerns (distance shape, per-node fields) — see ADR-038. The shape of FRONTIER promotion (covered by ADR-035). NeatScript-style traversal API or differential dataflow — both v1.0.

**When to revisit.**

When MCP-side consumers surface real-world traversal queries on large graphs and the multiplicative cascade produces confidence values that don't match human intuition. When new edge-confidence signals are added (e.g. per-driver health metrics) and the four-factor product needs a fifth term.

---

## ADR-037 — `getRootCause` contract

**Date:** 2026-05-06
**Status:** Active.

The second v0.2.3 consumer contract. Governs `getRootCause` in `packages/core/src/traverse.ts:174-240`. Sibling contracts: ADR-036 (traversal mechanics), ADR-038 (getBlastRadius).

`getRootCause` walks incoming edges from an error-surfacing node looking for an upstream incompatibility that explains the failure. Today it only fires on `DatabaseNode` origins (the driver/engine compat-matrix shape from ADR-014 and the demo). Issue #123 calls for generalization beyond databases.

**Decision.**

1. **Origin generality (issue #123).** `getRootCause` accepts any origin node and dispatches by `node.type` to a shape-specific check:

   - **DatabaseNode** — driver/engine compat shape (today's behavior; preserved unchanged). Walks incoming edges, looks for ServiceNodes whose `dependencies[driver]` declares an incompatible version against the database's `engine` + `engineVersion`.
   - **ServiceNode** — node-engine and package-conflict shapes via `compat.ts` (`checkNodeEngineConstraint`, `checkPackageConflict`). Walks incoming edges, looks for upstream services with declarations that violate the erroring service's `engines.node` or peer-package requirements.
   - **InfraNode / ConfigNode** — return null. No matrix shape today; future ADR may extend.
   - **FrontierNode** — return null. Frontier nodes have no compat surface and are excluded from traversal anyway per ADR-036.

   The dispatch lives in a `rootCauseShapes` table that maps `NodeType → (graph, originId, walk) => RootCauseResult | null`. Adding a new shape is one entry in the table, not a code restructure.

2. **Walks incoming edges to depth 5.** `ROOT_CAUSE_MAX_DEPTH = 5` is hardcoded. Walks deeper produce paths that stretch credulity (the demo's two-hop cause is the typical case). Changing the depth requires an ADR amendment.

3. **`longestIncomingWalk` is DFS; first-incompatibility wins.** The walk explores backward from the origin. The longest path produced becomes the candidate; the first incompatibility found along it is the root cause. If no incompatibility is found, `getRootCause` returns null.

4. **`reason` is human-readable.** Built from the compat result's `reason` field. If an `errorEvent` is provided, the observed error message is appended in parentheses: `${reason} (observed error: ${errorEvent.errorMessage})`. Never a raw `compat.json` entry; always a sentence.

5. **`fixRecommendation` is derived from the compat result.** Today: `Upgrade ${svc.name} ${pair.driver} driver to >= ${result.minDriverVersion}`. The pattern generalizes: each compat shape produces its own fix-recommendation string. The shape-specific check is the only place that knows what the fix is; the dispatcher just propagates it.

6. **Result schema-validated.** `RootCauseResultSchema.parse(result)` runs before return. Throws on violation; the API handler renders a 500.

7. **Returns null cleanly.** When the origin doesn't exist, when no incompatibility is found, when the origin's node type has no shape — `getRootCause` returns `null` with no throw.

8. **Edge provenance in result.** `edgeProvenances` is the array of provenance values along the traversal path, in order from origin to root cause. Length is `traversalPath.length - 1` (one entry per edge). Already enforced in code; reaffirmed in contract.

**Authority.**

Owned by `traverse.ts`, read-only. Calls into `compat.ts` for the actual incompatibility checks; never duplicates that logic.

**Enforcement.**

`contracts.test.ts` adds:
- A live test that `getRootCause` returns null cleanly when called with an origin whose `node.type` has no registered shape (e.g. ConfigNode).
- A live test that ServiceNode origins produce a result when an upstream service has a node-engine violation (the #123 generalization).
- A live test asserting `edgeProvenances.length === traversalPath.length - 1`.
- A live test asserting `.parse(RootCauseResultSchema, result)` succeeds for every valid return.
- A live test that the result's `traversalPath[0]` is the origin and the last entry is `rootCauseNode`.

**What this ADR is not deciding.**

The complete list of compat shapes (driver-engine + node-engine + package-conflict + deprecated-api are in `compat.ts` today; new shapes land via `compat.json` data, not contract amendment). Whether `getRootCause` should also surface secondary causes (defer — single root cause is the v0.2.3 contract; multi-cause is post-v1.0). The depth-5 limit (revisit when real codebases produce 5-hop paths and either confirm or reject the bound).

**When to revisit.**

When the second non-DatabaseNode origin shape is added (#123 generalization actually exercised) — the dispatch table should be reviewed for ergonomics. When MCP consumers want secondary-cause output.

---

## ADR-038 — `getBlastRadius` contract

**Date:** 2026-05-06
**Status:** Active.

The third v0.2.3 consumer contract. Governs `getBlastRadius` in `packages/core/src/traverse.ts:245+` and the result schemas in `packages/types/src/results.ts`. Sibling contracts: ADR-036 (traversal mechanics), ADR-037 (getRootCause).

**Decision.**

1. **BFS outbound from origin.** Visits each reachable node once, recording the shortest distance from origin. `bestEdgeByTarget` picks the highest-priority edge per neighbour per ADR-036. FRONTIER excluded.

2. **Default depth 10, overridable per call.** `BLAST_RADIUS_DEFAULT_DEPTH = 10` is the default; callers can pass `maxDepth` explicitly. Practical limit: depth past ~10 produces results dominated by graph branching that aren't useful.

3. **Distance is a positive integer (issue #138).** Schema growth toward shape: `BlastRadiusAffectedNodeSchema.distance` becomes `z.number().int().positive()` (effectively `min(1)`). The origin itself is never in `affectedNodes` — distance 0 has no meaning. Today the schema permits `nonnegative` (allows 0); the cleanup tightens it. **This is a schema shape change** — but no production data emits `distance: 0` (the BFS at line 266 explicitly skips frame-0), so the migration is no-op. Persist.ts may not need a migration function; the v2→v3 bump is recorded in the schema-snapshot diff.

4. **Per-node payload (issue #137).** `BlastRadiusAffectedNode` carries:
   - `nodeId: string`
   - `distance: number` (positive integer, see above)
   - `edgeProvenance: Provenance` — the provenance of the edge that brought traversal to this node
   - `path: string[]` — node ids from origin to this node, inclusive at both ends, length = distance + 1
   - `confidence: number` — `confidenceFromMix(...edgesAlongPath)`, in `[0, 1]`

   Today only the first three fields are present. `path` and `confidence` are schema growth (new optional fields → required after the cleanup ships). The BFS already tracks parents internally; surfacing the path is wiring, not new computation.

5. **`totalAffected` is the count of `affectedNodes`.** No double-counting, no inclusion of the origin. Identity: `result.totalAffected === result.affectedNodes.length`. Today's code already enforces this; the contract reaffirms it.

6. **Empty origin case.** When the origin doesn't exist or has no outgoing edges, returns `{ origin, affectedNodes: [], totalAffected: 0 }`. Never throws.

7. **Result schema-validated.** `BlastRadiusResultSchema.parse(result)` before return. Same as `getRootCause`.

8. **Path ordering.** `path[0] === origin` and `path[path.length - 1] === affectedNode.nodeId`. Reverse-path or skip-the-origin variations are contract violations.

**Authority.**

Owned by `traverse.ts`, read-only. The BFS frame's `parent` chain is reconstructed into `path` at the moment of first visit (when we discover the shortest distance to a node).

**Enforcement.**

`contracts.test.ts` adds:
- The existing `it.todo` for `BlastRadiusAffectedNode carries path and confidence` (issue #137) flips to a live assertion.
- The existing `it.todo` for `BlastRadius distance schema rejects 0` (issue #138) flips to a live assertion.
- The existing `it.todo` for schema validation (issue #139) flips to a live assertion that calls the function and `.parse()`s the result.
- A new live test asserting `path[0] === origin` and `path[path.length - 1] === affectedNode.nodeId` for every entry in `affectedNodes`.
- A live test that `totalAffected === affectedNodes.length`.
- A live test that the origin itself is not in `affectedNodes`.

**Schema-snapshot impact.**

Adding `path` and `confidence` to `BlastRadiusAffectedNodeSchema` is growth (new fields on an existing schema). The schema-snapshot test will fail until the developer regenerates with `UPDATE_SNAPSHOT=1`. Tightening `distance` from `nonnegative` to `positive` is a shape change in the strict sense — old data with `distance: 0` would no longer parse — but no real producer emits `distance: 0`, so it's an effective no-op. The snapshot diff is the audit trail for both.

**What this ADR is not deciding.**

Whether blast radius should expand to inbound edges (no — by definition, blast radius is downstream impact). Whether the BFS should compute confidence-weighted shortest paths (no — shortest by edge count is the v0.2.3 contract; weighted-shortest is a v1.0 NeatScript concern). Pagination on large blast radii (defer; today's MVP graphs are small enough that returning the full list is fine).

**When to revisit.**

When real codebase blast-radius queries return >100 affected nodes and pagination becomes a UX concern. When the MCP-side three-part response (contract #12 in v0.2.4) needs to format blast radius and the contract's `path` shape doesn't match the formatter's needs.

---

## ADR-039 — MCP tool surface contract

**Date:** 2026-05-06
**Status:** Active.

The first of seven v0.2.4 contracts. Governs `packages/mcp/src/`. Sibling contracts: ADR-040 (REST API), ADR-041 (persistence), ADR-042-045 (policies).

**Decision.**

1. **Tool count is locked at nine.** Eight today (`get_root_cause`, `get_blast_radius`, `get_dependencies`, `get_observed_dependencies`, `get_incident_history`, `semantic_search`, `get_graph_diff`, `get_recent_stale_edges`) plus `check_policies` (lands with v0.2.4 #117). The audit's `evaluate_policy` + `get_policy_violations` two-tool split is rejected per CLAUDE.md framing — one tool with `scope?` and `hypotheticalAction?` arguments handles both cases.

2. **Three-part response format (issue #143).** Every tool emits a natural-language paragraph, a structured block, and a footer line `confidence: X.XX · provenance: OBSERVED|EXTRACTED|...`. Confidence and provenance are derived per-result. Empty result → footer reads `confidence: n/a · provenance: n/a`. Helper `formatToolResponse` lives in `packages/mcp/src/format.ts`; every tool routes through it.

3. **`get_dependencies` is transitive (issue #144).** Default depth 3, max 10. Calls a new core endpoint `GET /graph/node/:id/dependencies?depth=N`.

4. **No `graph.json` reads.** Every tool calls REST against `NEAT_CORE_URL`.

5. **No demo-name hardcoding in tool logic.** Allowed only inside Zod `.describe()` strings.

6. **Project scoping.** Optional `project?: string`, defaulting to `'default'` per ADR-026.

7. **`semantic_search` documentation reflects the ADR-025 embedder chain**, not "keyword search."

8. **Stdio transport only for MVP.** HTTP / SSE / WebSocket post-MVP.

**Authority.** Read-only. Owned by `packages/mcp/src/`.

---

## ADR-040 — REST API contract

**Date:** 2026-05-06
**Status:** Active.

Governs `packages/core/src/api.ts`. Sibling contracts: ADR-039, ADR-041.

**Decision.**

1. **Dual-mount per ADR-026.** Every route mounts at both `/X` and `/projects/:project/X` via `registerRoutes(scope, ctx)`.

2. **Read-side endpoints (locked).** `GET /health`, `/graph`, `/graph/node/:id`, `/graph/edges/:id`, `/graph/dependencies/:nodeId?depth=N` (new for #144), `/graph/blast-radius/:nodeId?depth=N`, `/graph/root-cause/:nodeId`, `/graph/diff?against=path`, `/search?q=...`, `/incidents`, `/stale-events`, `/policies`, `/policies/violations`.

3. **Write-side endpoints.** `POST /graph/scan`, `POST /policies/check`. The OTLP receiver lives on its own port.

4. **JSON errors.** `{ error, status, details? }`. 400 / 404 / 500. No HTML pages.

5. **Schema validation on inbound bodies** via Zod from `@neat.is/types`.

6. **Project param defaults to `'default'`.**

7. **Live graphology, never `graph.json`.**

---

## ADR-041 — Persistence contract

**Date:** 2026-05-06
**Status:** Active.

Governs `packages/core/src/persist.ts`. Sibling contracts: ADR-039, ADR-040.

**Decision.**

1. **Snapshot location.** Default project: `<scanPath>/neat-out/graph.json` per ADR-017. Named projects: `~/.neat/projects/<name>/graph.json` per ADR-026.

2. **`SCHEMA_VERSION = 2` today.** Schema growth (ADR-031) does not bump the version; only shape changes do.

3. **Forward-only migrations.** Old snapshots load cleanly; new snapshots cannot be loaded by old code.

4. **Lifecycle.** Loaded once at startup; persisted on interval (default 60s) + `SIGTERM`/`SIGINT`.

5. **Append-only ndjson sidecars.** `errors.ndjson`, `stale-events.ndjson`, `policy-violations.ndjson` (v0.2.4). No rewrites, no rotation.

6. **Multi-project isolation.** `Map<string, NeatGraph>` keyed by project name.

7. **Nothing else reads `graph.json`** per Rule 6.

---

## ADR-042 — Policy schema contract

**Date:** 2026-05-06
**Status:** Active.

The first of four policy contracts. Governs `packages/types/src/policy.ts` (new). Sibling contracts: ADR-043, ADR-044, ADR-045.

**Decision.**

1. **`policy.json` at the project root** (not `neat-out/`). Version-controlled in the user's repo.

2. **Top-level shape.** `{ version: 1, policies: Policy[] }`. `version: z.literal(1)`.

3. **`Policy` shape.** `{ id, name, description?, severity, onViolation, rule }`. `id` uniqueness checked at load.

4. **Five rule types (MVP).** `structural`, `compatibility`, `provenance`, `ownership`, `blast-radius`. Discriminated by `rule.type`. New types require an ADR amendment.

5. **Loading.** Loaded at startup, reloaded on file change. Watch loop treats `policy.json` as a phase trigger.

6. **Validation.** `PolicyFileSchema.parse(json)` on load. Failure throws.

---

## ADR-043 — Policy evaluation contract

**Date:** 2026-05-06
**Status:** Active.

Governs `packages/core/src/policy.ts` (new). Sibling contracts: ADR-042, ADR-044, ADR-045.

**Decision.**

1. **`evaluateAllPolicies(graph, policies, context) → PolicyViolation[]`.** Pure function. Per-type evaluator dispatch.

2. **Three triggers.** Post-ingest, post-extract, post-stale-transition.

3. **`PolicyViolation` shape.** `{ id, policyId, policyName, severity, onViolation, ruleType, subject, message, observedAt }`. `id = ${policy.id}:${violation-context}` — dedup key.

4. **Deterministic ids.** Same graph + same policies → same ids. ndjson append-only deduplicates.

5. **Per-type dispatch table.**

6. **Idempotency.** Stateless.

7. **Authority.** Reads live graph; calls `compat.ts`; never mutates.

---

## ADR-044 — Policy onViolation actions contract

**Date:** 2026-05-06
**Status:** Active.

Sibling contracts: ADR-042, ADR-043, ADR-045.

**Decision.**

1. **Three actions: `log`, `alert`, `block`.** No others in MVP.

2. **`log`.** Append to `policy-violations.ndjson`. No surface effect.

3. **`alert`.** `log` + emit MCP `notifications/resources/updated` for `neat://policies/violations`.

4. **`block`.** `log` + `alert` + prevent the action. **MVP scope: FrontierNode promotion gating only.** Other gating points need their own ADRs.

5. **Severity defaults** when `onViolation` is omitted: `info → log`, `warning → alert`, `error → alert`, `critical → block`.

6. **Authority.** `packages/core/src/policy.ts`. Block returns `false` from gating checks; never mutates.

7. **Block scope tightly bounded.**

---

## ADR-045 — Policy tool surface contract

**Date:** 2026-05-06
**Status:** Active.

Sibling contracts: ADR-039, ADR-040, ADR-042-044.

**Decision.**

1. **Single MCP tool: `check_policies`** with optional `scope` and `hypotheticalAction`. Audit's two-tool split rejected.

2. **REST under `/policies`.** `GET /policies` (parsed file), `GET /policies/violations` (filterable), `POST /policies/check` (dry-run, `{ hypotheticalAction }` → `{ allowed, violations }`). Audit's `/policy/violations` (singular) rejected.

3. **MCP resource at `neat://policies/violations`.** Subscribers get update notifications.

4. **Three-part response format** from ADR-039. Confidence `1.00` for confirmed violations; lower for hypothetical-action results.

5. **Routes dual-mount per ADR-026.**

---

## ADR-046 — `neat init` contract

**Date:** 2026-05-06
**Status:** Active.

The first of four v0.2.5 distribution-layer contracts. Governs `packages/core/src/cli.ts`'s `init` command and the codemod path it triggers. Sibling contracts: ADR-047 (SDK install), ADR-048 (machine registry), ADR-049 (daemon).

**Decision.**

1. **`neat init <path>` is a one-time registration moment.** Like `brew install` followed by `claude init`. Re-running is idempotent.
2. **What `init` does, in order.** Discover (with report before mutation), build initial graph, register in `~/.neat/projects.json`, generate SDK install patch, apply or hold (patch-by-default; `--apply` opt-in), reload daemon if running.
3. **Patch-by-default; `--apply` opt-in.** Init never modifies user code without explicit consent. `--dry-run` prints without writing.
4. **What `init` doesn't touch by default.** Manifests only under `--apply`. Lockfiles never modified directly. `.env` and config files never modified. Running processes never instrumented.
5. **Discovery report is honest.** Lists what `init` will / won't do, what it found, what it skipped.
6. **Idempotency.** Re-running on already-initialized: re-runs discovery, overwrites registry entry, re-generates patch (skips applied changes), re-builds snapshot. No double-install, no duplicate registry entries.
7. **Project naming.** `--project <name>` overrides; default basename. Names unique within `~/.neat/projects.json`; collisions fail loudly.
8. **`init` and `install` are one command.** Audit's split rejected — one command with `--apply` flag handles both.

**Authority.** `packages/core/src/cli.ts`. Composes extract/, persist.ts, installers/, registry.ts. Does **not** start the daemon (`neatd start` is separate).

**Enforcement.** `it.todo` for v0.2.5 #119. Discovery-report-before-mutation gets a CLI test (`init --dry-run` → no files changed).

---

## ADR-047 — SDK install contract

**Date:** 2026-05-06
**Status:** Active.

Governs per-language installer modules under `packages/core/src/installers/` (new directory). Sibling contracts: ADR-046, ADR-048, ADR-049.

**Decision.**

1. **Installer module interface.** Every language exports `{ language, detect(serviceDir), plan(serviceDir): InstallPlan, apply(serviceDir, plan): ApplyResult }`. Plan and apply decoupled — patch can be saved, reviewed, re-applied later.
2. **Two languages in MVP: Node and Python.** Node adds `@opentelemetry/api`, `sdk-node`, `auto-instrumentations-node`; modifies `scripts.start` (or Procfile/Dockerfile CMD). Python adds `opentelemetry-distro`, `opentelemetry-exporter-otlp`; prefixes entrypoint with `opentelemetry-instrument`. Both set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. Java/Ruby/.NET/Go/Rust out of MVP.
3. **Patch shape.** Serializable: `{ language, dependencyEdits, entrypointEdits, envEdits }`. The plan is what `init` writes to `neat.patch` for review.
4. **Lockfiles never touched.** Manifests only. After `--apply`, init prints `Run "npm install"` so user owns the lockfile commit.
5. **Idempotency.** `plan(dir)` returns empty plan when SDK is already installed. Re-running `init --apply` produces no diff.
6. **Patch is deterministic.** Same input → same patch. Reviewable byte-for-byte.
7. **Apply failure is recoverable.** Partial success → emits `neat-rollback.patch`. NEAT does not silently leave broken state.
8. **Composability.** `neat init --no-install` for graph + registry only. `neat install <path>` alias for `init --skip-discovery --skip-registry`.

**Authority.** `packages/core/src/installers/`. One file per language. Common patch-application in `installers/shared.ts`.

**Enforcement.** `it.todo` for v0.2.5 #119. "Lockfiles never touched" lands as regression scan.

---

## ADR-048 — Machine-level project registry contract

**Date:** 2026-05-06
**Status:** Active.

Governs `~/.neat/projects.json` and `packages/core/src/registry.ts`. Sibling contracts: ADR-046, ADR-047, ADR-049.

**Decision.**

1. **Single source of truth: `~/.neat/projects.json`.** Per-user, machine-local. Not synced. Not version-controlled.
2. **Shape.** `{ version: 1, projects: [{ name, path, registeredAt, lastSeenAt?, languages, status: 'active' | 'paused' | 'broken' }] }`. `version: z.literal(1)`.
3. **Atomicity.** `writeAtomically(path, contents)` — tmp + fsync + rename. No torn writes.
4. **Lock file.** Exclusive flock on `~/.neat/projects.json.lock` for writes. 5s timeout; failure is loud.
5. **Status semantics.** `active` (daemon watching), `paused` (user-paused), `broken` (path missing or last op failed).
6. **Removal.** `neat uninstall <name>` removes entry. Does **not** delete `neat-out/`, `policy.json`, or user files. Reverses SDK-install patch via `neat-rollback.patch` if user opts in.
7. **Path normalization.** Stored as resolved absolute path. Two `init` calls from different relative paths to the same dir don't create two entries.
8. **Multi-machine sync deferred.** Per-machine for MVP.

**Authority.** `packages/core/src/registry.ts`. CLI commands and daemon call into it. Daemon reads on boot and on `SIGHUP`.

**Enforcement.** `it.todo` for v0.2.5 #119. Regression test asserts registry path is `~/.neat/projects.json` and no other module reads/writes it.

---

## ADR-049 — Daemon contract

**Date:** 2026-05-06
**Status:** Active.

Governs the long-lived `neatd` process. Sibling contracts: ADR-046, ADR-047, ADR-048.

**Decision.**

1. **Single long-lived process.** `neatd start` boots one daemon watching every project in `~/.neat/projects.json`. Per-project graphs in `Map<string, NeatGraph>` per ADR-026. No clustering in MVP.
2. **Lifecycle commands.** `neatd start [--foreground]`, `neatd stop`, `neatd reload`, `neatd status`.
3. **Continuous extraction triggers.** Source mtimes (chokidar → re-extract phase per ADR-032), `policy.json` mtime (reload per ADR-042), `compat.json` mtime (reload matrix), OTel HTTP/gRPC (`:4318`/`:4317` → `handleSpan` per ADR-033), staleness loop (60s per ADR-024).
4. **Per-project isolation.** Each project's graph is its own `MultiDirectedGraph`. File watching, OTel ingest, policy evaluation scoped to project. Failure in one project doesn't affect others.
5. **OTel routing.** Spans route to a project by `service.name` lookup across registered projects. Unknowns route to `'default'` for FrontierNode auto-creation.
6. **Graceful degradation.** Missing registry → boot refuses. Missing path → mark `status: 'broken'`. OTel overwhelmed → backpressure via queue (ADR-033 #1); spans drop, never block.
7. **No automatic restart on crash.** PID at `~/.neat/neatd.pid` for external supervisors (systemd / launchd).
8. **Self-hosting gate stays closed during v0.2.5.** Per ADR-027 + the v0.2.x sequencing: self-hosting NEAT on the NEAT codebase only flips on after the MVP-success PR closes.

**Authority.** `packages/core/src/daemon.ts`. Composes registry.ts, extract/, ingest.ts, policy.ts, persist.ts.

**Enforcement.** `it.todo` for v0.2.5 #119. Regression test asserts daemon writes `graph.json` only via persist.ts loop and shutdown handlers.

## ADR-050 — CLI surface contract

**Date:** 2026-05-08
**Status:** Active.

Opens v0.2.8 (contract drafted under the milestone's original v0.2.6 name; renamed per ADR-053 after publish-fix releases consumed those version slots — the contract content is unchanged). First of two milestone contracts. Sibling: ADR-051.

**Context.** Today every reach into the graph goes through MCP — fine for Claude Code, awkward for a human at a terminal who wants to ask "what does `get_root_cause` return for `service:checkout`?" The terminal-vs-agent gap is real: an engineer debugging needs the same nine tools the agent has, without the Claude wrapper. The existing `neat` CLI handles lifecycle (`init`, `watch`, `list`, `pause`, `resume`, `uninstall`, `skill`) but exposes no graph queries.

**Decision.**

1. **Nine `neat <verb>` commands, one per MCP tool.** The verb set mirrors the locked allowlist from ADR-039:

   | MCP tool | CLI verb |
   |---|---|
   | `get_root_cause` | `neat root-cause <node-id>` |
   | `get_blast_radius` | `neat blast-radius <node-id>` |
   | `get_dependencies` | `neat dependencies <node-id> [--depth N]` |
   | `get_observed_dependencies` | `neat observed-dependencies <node-id>` |
   | `get_incident_history` | `neat incidents [--limit N]` |
   | `semantic_search` | `neat search <query>` |
   | `get_graph_diff` | `neat diff [--since <date>]` |
   | `get_recent_stale_edges` | `neat stale-edges` |
   | `check_policies` | `neat policies [--node <id>] [--hypothetical-action <action>]` |

   Naming drops the `get_` prefix and uses kebab-case per UNIX convention. Verbs are nouns where natural (`incidents`, `policies`), action-flavored only when the noun would be ambiguous (`search`, `diff`).

2. **REST-only data path.** Verbs hit `NEAT_API_URL` (default `http://localhost:8080`) via the same client logic the MCP server uses. Never read `graph.json` at request time. Same multi-project routing as MCP — `--project <name>` flag, defaulting to `NEAT_PROJECT` env, defaulting to `'default'`.

3. **Two output modes.** Default human-readable: prose summary + plain-text table + `confidence: X.XX · provenance: ...` footer (mirrors the three-part MCP response per ADR-039). With `--json`: machine-readable JSON with the same three sections as named fields (`{ summary, block, confidence, provenance }`). Stdout for results; stderr for diagnostics.

4. **Exit code conventions.**

   - `0` — success.
   - `1` — server error (4xx / 5xx response from REST; the body's error message goes to stderr).
   - `2` — misuse (missing required arg, malformed flag — handled before any network call).
   - `3` — daemon not reachable (connection refused / timeout). Distinct from `1` so scripts can branch on "is the daemon up?"

5. **No mutation verbs in MVP.** Every MCP tool is read-only and so is every CLI verb. Lifecycle commands (`init`, `watch`, etc.) keep their existing semantics; mutation never lands behind a query verb.

6. **No demo-name hardcoding.** Same rule as MCP (per cross-cutting rule 8). Examples in `--help` text reference real-shape ids (`service:<name>`, `database:<host>`) without committing to specific demo names.

7. **`--help` output is binding documentation.** Each verb's `--help` lists the args, flags, exit codes, and an example invocation. `neat --help` lists every verb (lifecycle + query) in one block.

**Authority.** `packages/core/src/cli.ts` (extends existing parser) or a new `packages/core/src/cli-verbs.ts` if the surface gets large. Implementation choice left to the implementing agent. The REST client lives at `packages/core/src/cli-client.ts` (or similar) and is shared with `packages/mcp/src/client.ts`.

**Enforcement.** `it.todo` block in `contracts.test.ts` for v0.2.8 #23. Regression tests cover: nine verbs registered, REST-only data path (no `graph.json` reads from CLI), exit-code branching, `--json` shape, `--project` propagation.

## ADR-051 — Frontend-facing API contract

**Date:** 2026-05-08
**Status:** Active. Speculative — sections marked **(deferred)** wait for v0.3.0 to surface concrete asks.

Opens v0.2.8 (contract drafted under the milestone's original v0.2.6 name; renamed per ADR-053 after publish-fix releases consumed those version slots — the contract content is unchanged). Second of two milestone contracts. Sibling: ADR-050.

**Context.** Jed's v0.3.0 frontend track builds against the v0.1.2-stable API. The existing REST surface (`/graph`, `/graph/node/:id`, etc., all dual-mounted per ADR-026) is request-response — fine for initial render, insufficient for live views. Two gaps known today: live update streaming, multi-project enumeration. WebSocket-style symmetric subscription is plausibly needed but not surfaced yet.

The `(if needed)` qualifier in the kickoff applies. We draft what's clear and explicitly defer what isn't.

**Decision.**

1. **Server-Sent Events stream at `/events`.** Dual-mounted per ADR-026: `GET /events` (default project) and `GET /projects/:project/events` (scoped). Content-type `text/event-stream`. One JSON-encoded payload per event line, prefixed by `event: <type>` so the EventSource API routes by type.

2. **Event taxonomy (locked).** Eight event types, all derived from existing graph mutations:

   | Event | Payload | Trigger |
   |---|---|---|
   | `node-added` | `{ node: GraphNode }` | extract or auto-create in ingest |
   | `node-updated` | `{ id: string, changes: Partial<GraphNode> }` | property change in extract / ingest |
   | `node-removed` | `{ id: string }` | retire path in extract |
   | `edge-added` | `{ edge: GraphEdge }` | any provenance |
   | `edge-removed` | `{ id: string }` | retire / promotion rewire |
   | `extraction-complete` | `{ project, fileCount, nodesAdded, edgesAdded }` | watch.ts re-extract finishes |
   | `policy-violation` | `{ violation: PolicyViolation }` | evaluator emits a new violation |
   | `stale-transition` | `{ edgeId, from: 'OBSERVED', to: 'STALE' }` | staleness loop tick |

   New event types require a successor ADR. The event taxonomy is locked the same way the nine MCP tools are locked — no quiet additions.

3. **Heartbeat.** Every 30 seconds the server emits a comment line (`:heartbeat\n\n`) to keep proxies / load balancers from idle-timing out the connection. EventSource clients ignore comments.

4. **Multi-project switcher endpoint.** `GET /projects` returns `Array<{ name, path, status, registeredAt, lastSeenAt?, languages }>` — direct passthrough of `listProjects()` from `registry.ts` (ADR-048). Distinct from the dual-mount routing in ADR-026: that exposes per-project endpoints; this exposes the registry itself for a project picker UI.

5. **JSON error shape unchanged.** Same `{ error, status, details? }` envelope from ADR-040. SSE errors land as a final `event: error` payload before the connection closes; non-SSE errors keep the existing JSON-body convention.

6. **WebSocket transport (deferred).** Symmetric subscription (client subscribes to specific node ids, sends ping/pong, etc.) waits for a successor ADR. Triggered when v0.3.0 frontend work surfaces a concrete need SSE can't cover. SSE is sufficient for one-way streaming and is the MVP transport.

7. **Per-event filtering inside SSE (deferred).** The default-project mount streams every event for the default graph; the `/projects/:project/events` mount streams events for that project. Filtering by node id or edge type within a stream is a successor concern.

8. **Backpressure.** SSE writes are non-blocking — if a client's socket is slow, events queue up to a per-connection cap (default 1000 messages) before the connection is dropped with `event: error` payload `{ reason: 'backpressure' }`. Spans dropping at the OTel layer (per ADR-033) is unrelated; this is a separate per-connection guard.

**Authority.** `packages/core/src/api.ts` (extend) for `/projects`. SSE endpoint in `packages/core/src/api.ts` or a new `packages/core/src/streaming.ts` if the surface grows. Event emission threaded through `ingest.ts`, `extract/index.ts`, `watch.ts`, `policy.ts` via a small `EventEmitter` singleton in `packages/core/src/events.ts`.

**Enforcement.** `it.todo` block in `contracts.test.ts` for v0.2.8 #24. Regression tests cover: `/events` endpoint exists with `text/event-stream` content-type, dual-mount per ADR-026, event-type taxonomy locked (eight types, no quiet additions), `/projects` endpoint exists and returns the registry shape, heartbeat interval set, backpressure cap honored.

## ADR-052 — Publish system contract

**Date:** 2026-05-09
**Status:** Active.

Documents the load-bearing rules of the npm publish pipeline. The pipeline has been in production since 0.2.5 but had no contract coverage, which is how the 0.2.6 broken-publish bug shipped: the `neat.is` umbrella's bin wrappers `require()`ed subpaths into `@neat.is/core` and `@neat.is/mcp` that those packages didn't expose through their `exports` field, and nothing caught it before the tarballs went live on the registry.

**Context.** Five packages ship to npm: `@neat.is/types`, `@neat.is/core`, `@neat.is/mcp`, `@neat.is/claude-skill`, and the `neat.is` umbrella. The umbrella's whole job is to put `neat`, `neatd`, `neat-mcp` on PATH after `npm install -g neat.is` — it has no code of its own, only three bin wrappers that delegate via `require('@neat.is/core/dist/cli.cjs')` etc. Local monorepo dev uses workspace symlinks where Node bypasses `exports` enforcement; npm-installed tarballs do not. The first release that exercised the wrappers through real tarballs was 0.2.6, and that's when the failure surfaced.

**Decision.**

1. **Bin-wrapper subpath validity.** Every `require('@scope/pkg/subpath')` line in `packages/neat.is/bin/*` must resolve to a path exposed in the target package's `exports` field. Literal-key match for MVP; wildcard pattern matching is a successor concern. Enforced as a contract-test assertion that parses the wrapper files and walks each target package.json.
2. **Version lockstep.** All five publishable packages (`types`, `core`, `mcp`, `claude-skill`, `neat.is`) carry the same `version` string in their `package.json` at all times on `main`. Cross-package dep ranges (`@neat.is/types: ^X.Y.Z` in core/mcp, three of those in the umbrella) must match the same `X.Y.Z`. Half-bumped state is a contract violation. Enforced both by the publish workflow's verify-versions step and by a contract test on `main`.
3. **Tarball smoke-test gate.** The publish workflow must run `neat --help` against the just-published umbrella tarball before declaring success. Specifically: install `neat.is@<published-version>` into a tmp dir, invoke the `neat` bin, assert exit code 0. Catches any failure shape that only surfaces under a real tarball install (the 0.2.6 class).
4. **Dependency order is fixed.** Publish proceeds `types → core → mcp → claude-skill → neat.is`. Out of order means a downstream 404 because npm rejects publishes whose deps aren't on the registry yet. Encoded in both the CI workflow and `scripts/publish.sh`.
5. **Idempotency per package.** Re-running the publish workflow after a partial failure must skip packages already at the target version (`npm view <pkg>@<version>` check) rather than 409. Already implemented; this contract locks it as a binding rule.
6. **npm immutability acknowledged.** Once `name@version` is published, that slot is permanently sealed — `npm unpublish` does not free it for re-publish. Therefore: publishing a broken version forces a patch-version bump, never a same-version republish. Documented in `docs/runbook-publish.md`'s troubleshooting section.
7. **No engineering of an unpublish recovery.** When a broken release ships, the response is a fix-only patch release at the next version (e.g. 0.2.6 broken → 0.2.7 fix). Don't build tooling around `npm unpublish` because npm won't let it work the way that tooling would imply.
8. **`engines.node: ">=20"`** on every publishable package and the umbrella. Older Node fails at install, not at runtime. Already in place; this contract locks it.

**Authority.** `.github/workflows/publish.yml` (CI publish), `scripts/publish.sh` (local fallback), `docs/runbook-publish.md` (process), `packages/neat.is/bin/{neat,neatd,neat-mcp}` (the wrappers under contract), `packages/core/package.json` and `packages/mcp/package.json` (the `exports` fields the wrappers reach through).

**Enforcement.** New describe block in `contracts.test.ts`. Live assertions for rules 2 (version lockstep), 4 (dependency order encoded in scripts), 8 (engines field). Rule 1 (subpath validity) ships as live but depends on the 0.2.7 exports fix being on `main` first; until then, the assertion would fail because main reflects the broken 0.2.6 state. Rule 3 (tarball smoke-test) is an `it.todo` until the workflow step lands. Rules 5, 6, 7 are documented invariants without test mechanization (5 is exercised by every re-run of the workflow; 6 and 7 are policy, not verifiable in CI).

## ADR-053 — Milestone naming convention

**Date:** 2026-05-09
**Status:** Active.

**Context.** Until now NEAT milestones have been named after the npm version they're projected to ship under (`v0.2.0 — Sunrise`, `v0.2.1 — Tree-sitter rebuild`, etc.). This worked because every milestone shipped exactly one npm version, with no publish-fix releases intervening. The 0.2.6 broken-publish saga broke that assumption: between the v0.2.6 milestone opening (2026-05-08) and any implementation work, two publish-fix releases (`0.2.6` retired, `0.2.7` shipped) consumed the version slot the milestone name implied. Calling the unshipped milestone "v0.2.6" while the next npm publish would actually be `0.2.8` created persistent terminology drift across CLAUDE.md, contracts.md, the kickoff doc, ADR-050/051, and the contracts test suite.

**Decision.**

1. **Milestone name = projected next npm version at kickoff time.** Same convention as before.
2. **If publish-fix releases consume the projected version before the milestone implementation ships, the milestone name updates to match the new projected version.** Rolling forward, not staying anchored. The rename is mechanical: every forward-looking reference (CLAUDE.md "Where you are in the build", contracts.md status fields, ADR "Opens v0.X.Y" lines, kickoff doc filenames, contracts.test.ts comment headers) updates in one PR. Historical references (commit messages, closed status docs, PR descriptions, retired npm versions) stay as they were — those reflect the world as it was at the time, and rewriting them would be revisionism.
3. **ADR and contract numbers do not change.** ADR-050 stays ADR-050 even if the milestone it opens is renamed v0.2.6 → v0.2.8. Contract numbering is independent of milestone naming. Same for `it.todo` issue references in contracts.test.ts — those are tracker issue numbers, not milestone version numbers.
4. **The rename is documented in a status doc.** `docs/plans/<date>-milestone-rename.md` captures what changed and why, so the trail back to the original name stays discoverable.
5. **Old kickoff docs get a deprecation header.** `docs/plans/<old-date>-v0.X.Y-kickoff.md` gets a one-block redirect to the new kickoff at the top, preserving the body as historical record.

**Why not decouple milestone names from version numbers entirely?** Considered. Descriptive milestone names (`M-CLI-API`, `M-Frontend-Surface`) would prevent any version-name drift forever, but they also break the existing v0.X.Y → version → npm convention NEAT has used since v0.1.0, and they require updating every status doc and runbook reference at once. The roll-forward rule preserves the existing convention while handling the rare case where it slips. If milestone-version drift recurs more than twice in v0.3.x or beyond, revisit.

**Authority.** Process rule, no code authority. Enforced by the rename PR pattern when drift is detected.

**Enforcement.** No mechanized test. Detected by reading: if `CLAUDE.md`'s active-milestone block names a version that's already on the npm registry as a retired or current published version, the milestone needs to be rolled forward.

**First application.** v0.2.6 → v0.2.8 milestone rename, 2026-05-09, see `docs/plans/2026-05-09-milestone-rename.md`.

## ADR-054 — `ServiceNode.owner` extraction rule

**Date:** 2026-05-10
**Status:** Active.

**Context.** The 2026-05-04 audit (`docs/audits/NEAT-audit-types(1).md`) graded the absence of an `owner` field on `ServiceNode` as a FAIL: *"absent. Blocks code-ownership-aware features."* The v0.2.x sequence didn't ship it, didn't track it as a deferred issue, and no contract gated it — it quietly disappeared. The 2026-05-10 pre-v0.3.0 verification pass (`docs/plans/2026-05-10-pre-v0.3.0-verification.md`, Finding 9.1) caught it during the audit-doc re-grade.

`owner` is the difference between diagnostic and actionable. NEAT's value isn't just *"`pg@7.4.0` is incompatible with PostgreSQL 15"* — it's *"and here's who to talk to about fixing it."* Without an owner field, the human consuming the output has to find ownership separately. With it, ADR-027's MVP-success-PR experiment becomes a tighter loop: identify divergence, identify owner, propose fix to that owner.

**Decision.**

1. **Schema.** Add `owner?: string` to `ServiceNodeSchema` in `packages/types/src/nodes.ts`. Optional. Per ADR-031 this is *growth* — commit-and-go, no `persist.ts` migration needed; `schema-snapshot.test.ts` regenerates the fixture as the audit trail.

2. **Source priority during static extraction.** `extract/services.ts` populates `owner` per service in this order:

   1. **CODEOWNERS file.** Read `<scanPath>/CODEOWNERS` or `<scanPath>/.github/CODEOWNERS` (in that order). Match each service's `repoPath` against the patterns; use the first matching line's RHS (the literal owner string, `@org/team` or `email@addr.tld` or whatever the file declares).
   2. **`package.json` author field.** If CODEOWNERS doesn't cover the service's path, read `<service.repoPath>/package.json` and use the `author` field if present. Accept either string form (`"Cem D <cem@example.com>"`) or object form (use `name` field).
   3. **Otherwise, leave `owner` undefined.**

   No git-blame fallback. Too noisy (last-toucher ≠ owner), too slow (per-service git invocations), and the failure mode of a wrong owner attribution is worse than no owner attribution.

3. **Format.** Literal value from the source. No normalization in MVP — `@neat-tools/backend` stays `@neat-tools/backend`; `cem@neat.is` stays `cem@neat.is`. The frontend / MCP can normalize for display; the graph stores ground truth.

4. **Trigger.** Population happens during static extraction (`discoverServices` in `extract/services.ts`). Not at OTel ingest time.

5. **OTel-auto-created services.** Per ADR-033 #4, services auto-created from OTel spans (no source path known yet) start with `owner: undefined`. When `extract/services.ts` later discovers the service's source via tree-sitter / file walk, it backfills `owner` per the priority above. Per ADR-030 (lifecycle), property updates on existing nodes are allowed by extract producers; this is a normal property update.

6. **No CODEOWNERS pattern compiler in MVP.** Use a minimal glob match: support `*` and `**` and exact paths. Don't pull in a full CODEOWNERS gitignore-style parser. If real-user signal demands richer patterns, file a successor ADR.

**Authority.** `packages/types/src/nodes.ts` (schema growth), `packages/core/src/extract/services.ts` (extraction logic). The static-extraction contract (`docs/contracts/static-extraction.md`) gets an "Owner extraction" section linking back here.

**Enforcement.** `it.todo` block in `contracts.test.ts`:

- `ServiceNodeSchema` includes optional `owner` field
- `extract/services.ts` populates `owner` from CODEOWNERS when one exists at repo root
- `extract/services.ts` populates `owner` from CODEOWNERS at `.github/CODEOWNERS` when no root file
- `extract/services.ts` falls back to package.json `author` when CODEOWNERS doesn't cover the path
- `extract/services.ts` leaves `owner` undefined when neither source is available
- Backfill works: a service auto-created from OTel ingest gets `owner` populated when `discoverServices` later runs

The schema-snapshot test catches the field addition automatically (per ADR-031).

**What this is NOT.**

- Not a node type. Owners aren't first-class graph nodes; they're a property on `ServiceNode`. If real-user demand surfaces a need to query "all services owned by team X" or to wire owner-as-blast-radius-target, that's a successor ADR (probably an `OwnerNode` with `OWNED_BY` edges).
- Not a runtime concern. The OBSERVED layer doesn't carry owner data; OTel spans don't (and shouldn't) advertise organizational structure. Owner is purely an EXTRACTED-layer property.
- Not a policy attribute (yet). The `policies` contract (ADRs 042-045) doesn't reference `owner` today. If real-user signal demands ownership-conditioned policies (*"alert team X if their service depends on a deprecated package"*), that's a policy-schema extension, separate work.

## ADR-055 — Producer per-file parse-failure isolation

**Date:** 2026-05-10
**Status:** Active.

**Context.** Run NEAT against an unfamiliar codebase (in this case `medusa` per the debugger agent's session) and a single file with malformed-but-parseable-by-tree-sitter syntax can throw inside `callsFromSource`, propagating up through the producer's `for (const file of files)` loop and aborting the entire HTTP-call extraction phase. The pattern recurs across producers: a `JSON.parse` on a malformed `package.json`, a `parseAllDocuments` on a broken Compose file, a tree-sitter parse on an exotic JS variant — any one bad file kills the phase.

This violates the implicit assumption everywhere else in the system (OTel ingest backpressure per ADR-033, traversal per ADR-036's clean returns) that NEAT degrades gracefully on partial input. The static-extraction layer was the last piece without an explicit rule.

The debugger agent shipped the fix on `extract/calls/http.ts` (try/catch with `console.warn` + `continue`); ADR-054's implementation independently arrived at the same shape on `extract/owners.ts`; `extract/infra/k8s.ts` already had it; `extract/databases/*` already had it. Four producer files still don't.

**Decision.**

1. **Every producer that parses per-file content wraps the parse in try/catch.** The wrap covers the parse call itself (`readYaml`, `readJson`, `parseAllDocuments`, `callsFromSource`, etc.) and any narrow logic that depends on its return value being well-formed.
2. **On failure: warn and continue.** `console.warn(\`[neat] <phase> skipped <file>: <err.message>\`)`, then `continue` to the next file. Don't throw; don't abort the phase.
3. **The phase completes even if some files are unparseable.** A single broken `.compose.yml` doesn't kill all infra extraction; a single bad `package.json` doesn't kill service discovery; a single bad `.js` file doesn't kill HTTP-call extraction.
4. **Wrap at the call site, not in shared helpers.** `readJson` and `readYaml` in `extract/shared.ts` continue to throw on malformed input; producers wrap their call. This keeps warnings contextual (the message can name the producer, the file path, and the failure mode) and lets pure callers (e.g. `loadCodeowners`, which already wraps) keep their own shape.
5. **File reads that don't parse follow the same pattern when they sit inside a per-file walk.** `fs.readFile` in `infra/dockerfile.ts` and `infra/terraform.ts` doesn't itself throw on content shape, but a permission error on one file shouldn't kill the phase. Same try/catch + skip discipline.

**Sites already conformant (no work needed):**

- `extract/calls/http.ts` — debugger agent's fix
- `extract/owners.ts` — ADR-054 implementation
- `extract/infra/k8s.ts:51-55` — `parseAllDocuments` wrapped
- `extract/databases/*` — debugger agent confirmed

**Sites needing the fix:**

- `extract/services.ts:125` — `readJson<PackageJson>(pkgPath)` unwrapped (per-service `package.json` read)
- `extract/services.ts:173` — `readJson<RootPackageJson>(rootPkgPath)` unwrapped (workspace root read)
- `extract/aliases.ts:98` — `readYaml<ComposeFile>(composePath)` unwrapped
- `extract/aliases.ts:149` — Dockerfile `fs.readFile` unwrapped (parse-by-regex, but file read can still fail)
- `extract/infra/docker-compose.ts:58` — `readYaml<ComposeFile>(composePath)` unwrapped
- `extract/infra/dockerfile.ts:42` — `fs.readFile` unwrapped

Six call sites across four producer modules.

**Authority.** `packages/core/src/extract/**` (every producer). The static-extraction contract (`docs/contracts/static-extraction.md`) gets a new "Per-file parse-failure isolation" section linking back here.

**Enforcement.** `it.todo` block in `contracts.test.ts`:

- A producer-resilience scan that walks every file under `packages/core/src/extract/`, finds every parse-like call (`readYaml`, `readJson`, `parseAllDocuments`, `callsFromSource`), and asserts it's surrounded by a `try { ... } catch { ... }` block.
- One `it.todo` per known unfixed call site (six total) that flips to live as the implementation agent ships each fix.

The scan is regex-based and approximate but sufficient for the failure shape — a missing try/catch around a `readJson` call shows up as a clean grep miss.

**Out of scope.**

- **Replacing tree-sitter substring scan in `callsFromSource` with regex** (debugger agent item 3). Performance / robustness rewrite; defer until performance becomes the gating concern.
- **Size pre-filter on parse inputs** (debugger agent item 4). Skipping files > 1 MB before parse would reduce log noise from minified bundles. Optional, not required for correctness.
- **Asynchronous-error escalation.** A producer can't `process.exit(1)` on a parse failure even if every file fails. The phase must always complete, even with zero successful parses. Logging volume from a `node_modules`-leaking scan is a separate UX concern.
- **Sentry-style structured error reporting.** Plain `console.warn` is sufficient for MVP. Wrap-at-call-site keeps the message contextual; future telemetry can hook into `console.warn` without changing the contract.

## ADR-056 — Web shell completeness

**Date:** 2026-05-10
**Status:** Active.

**Context.** Jed's v0.3.0 frontend track has been pushing `packages/web/` to main since the v0.2.5 close. The audit at `packages/web/audit/09-gaps-and-stubs.md` self-identifies thirteen UI elements that render visibly but do nothing on click — eleven buttons in TopBar / Rail, two Inspector tabs. Every one of them is a credibility leak: a user clicks the button, expecting the action, gets silence, concludes NEAT is half-built.

The frontend audit is comprehensive and Jed's track is independent (Track 1 per CLAUDE.md), but the contract surface didn't cover it. Permanent stub UI is its own failure mode — the kind that bites the MVP-success-PR experiment when the OSS user clicks "Time travel" expecting a panel and gets nothing.

**Decision.**

1. **No permanent stub UI.** Every interactive element rendered to the user — button, tab, link, menu item, keyboard shortcut — must either:
   - **Map to a real action** (an `onClick` / `onKeyDown` handler that produces an observable change in the UI or backend state), OR
   - **Be explicitly disabled** with visual affordance: `disabled` attribute set, lower opacity, and a tooltip / badge ("Coming soon", "Not yet available", "v0.3.x") so the user doesn't perceive a malfunction.
2. **No `onClick={() => {}}` or `onClick={undefined}` on rendered components.** Empty handlers are the most common stub shape and the most disorienting for users.
3. **Component uniqueness.** No two files in `packages/web/app/components/` may export a component with the same name. If a component needs extension (filter view, grouped variant, etc.), extend the existing one — don't fork. Helps prevent the `GraphView.tsx` / `GraphCanvas.tsx` confusion that already happened (the old `GraphView.tsx` was deleted in a recent commit; the contract codifies "don't do this again").
4. **Inventory tied to the audit doc.** `packages/web/audit/09-gaps-and-stubs.md` is the canonical list of known stubs. As stubs are removed or wired, the audit doc updates. The contract test reads the audit doc and asserts no stub appears in code without a matching entry — drift in either direction is a finding.

**Authority.** `packages/web/app/components/**` (component library), `packages/web/app/**/page.tsx` (route surfaces), `packages/web/audit/09-gaps-and-stubs.md` (the canonical inventory). Web track is Jed's; this contract sets binding rules but doesn't dictate visual or interaction design.

**Enforcement.** `it.todo` block in `contracts.test.ts` for ADR-056. Regression scans:

- No empty `onClick={() => {}}` or `onClick={undefined}` in `packages/web/app/components/**`.
- No two files under `packages/web/app/components/` export `default` components with the same name.
- Every entry in `audit/09-gaps-and-stubs.md`'s "Stub buttons" table corresponds to a button in source code (audit-vs-code consistency).

`it.todo` initially because all thirteen stubs from the audit currently exist in source. As they wire or get explicitly disabled, the corresponding todos flip to live, and the global empty-handler scan flips last.

## ADR-057 — Web shell multi-project routing

**Date:** 2026-05-10
**Status:** Active.

**Context.** When NEAT runs against an unfamiliar codebase (e.g., medusa, the canonical MVP-success-PR target), the web shell must show *that codebase's* graph, not the default project's. Jed's audit already flags this as an open gap: *"Multi-project — graph not re-fetched on project change."* The current `AppShell.tsx` initializes `project = 'default'` and accepts a setter, but the downstream components (GraphCanvas, Inspector, StatusBar, the proxy routes) don't all re-fetch when the project changes.

This is the runtime corollary of ADR-026 (multi-project dual-mount). The backend already supports it; the frontend has to honor it consistently.

**Decision.**

1. **Single source of truth.** `AppShell.tsx` owns the `project` state. Every component that fetches backend data reads it as a prop and re-fetches on change.
2. **Initial project resolution chain (in order):**
   1. URL query param: `?project=X`
   2. `localStorage.getItem('neat:lastProject')` — survives reload
   3. First entry from `GET /projects` if registry is non-empty
   4. `'default'` fallback
3. **Project change triggers data refresh.** When `project` changes (user picks from switcher, URL updates, etc.), every component that depends on it re-fetches via its own `useEffect([project])` hook. No stale data carries over.
4. **API proxy routes accept `project` consistently.** All routes under `packages/web/app/api/` accept `?project=X` or path-scoped `/projects/:project/X` and forward to the matching backend endpoint per ADR-026. New routes use the helper from day one (proxy.ts pattern).
5. **TopBar surfaces the active project visibly.** The user always knows which codebase NEAT is currently graphing — no ambiguity, no implicit defaults.
6. **Project switcher is a real control.** Uses `GET /projects` (per ADR-051) to populate; clicking an entry calls `setProject(name)` and updates the URL. Not a stub.
7. **No hardcoded project names in branching logic.** `'default'` is allowed only as the explicit fallback in `AppShell.tsx`'s state initializer. No `'medusa'`, no `'neat'`, no `if (project === 'demo')` anywhere in `packages/web/`. Same rule as the cross-cutting "no demo-name hardcoding" but extended to the web track.

**Authority.** `packages/web/app/components/AppShell.tsx` (state owner), `packages/web/app/components/TopBar.tsx` (display + switcher), `packages/web/app/components/GraphCanvas.tsx` (consumes project prop), `packages/web/lib/proxy.ts` (project-aware fetcher), `packages/web/app/api/**/route.ts` (project-aware proxies).

**Enforcement.** `it.todo` block in `contracts.test.ts`:

- AppShell.tsx initializes `project` from URL → localStorage → /projects → 'default' (read source, regex check).
- Every component file that imports `proxy.ts` or fetches from `/api/` accepts `project: string` as a prop or reads it from a context.
- Every API proxy route forwards `project` query/path to the backend.
- No hardcoded project names (`medusa`, `neat`, `demo`, etc.) in branching logic under `packages/web/app/components/` or `packages/web/lib/`.
- Multi-project re-fetch test: render AppShell with project=A, change to B, assert all data-fetching hooks re-ran (uses Vitest + React Testing Library — a new-tooling addition for the web track).

**Amendment (2026-05-11) — rule 2a, SSR-safe resolution chain. Superseded by ADR-062 (2026-05-11).**

> Retained for historical context. The bug this amendment described is real, but the chosen fix (constrain every web component to SSR/CSR byte-identicality) over-paid for chrome we don't render server-side anyway. ADR-062 removes the SSR boundary at AppShell, which makes the byte-identical requirement moot. Rule 2a no longer binds; rules 1-9 of ADR-057 otherwise stand.

A live web-shell session against the medusa project surfaced a hydration error: `Text content did not match. Server: "default" Client: "Neat"`. Root cause was `AppShell.tsx` running rule 2's resolution chain *synchronously inside a `useState` lazy initializer and a `useRef` initial value*. SSR has no `window` → returned `'default'`; client first render had `localStorage` → returned the stored project. The two renders disagreed at the project-name text node; React 18 threw error 425 / 418 and the GraphCanvas's `useEffect` failed to mount cleanly against the recovery render — net effect: no graph visible.

This was a contract violation of rule #7 (*"`'default'` is allowed only as the explicit fallback in `AppShell.tsx`'s state initializer"*) but the original ADR's rule #2 didn't make the SSR-safe execution explicit. This amendment closes that gap.

2a. **Resolution chain runs client-only.** SSR initial state is always `'default'` on both server and client to make server-rendered HTML byte-identical to first-client-render HTML at the project-name text node. The four-step resolution chain in rule #2 runs entirely in `useEffect` after mount — never during the synchronous render path, never in a `useState` lazy initializer, never in a `useRef` initial value. This is the SSR-safe execution of rule #2's logical order and the explicit reading of rule #7's `'default'`-as-initial-state requirement.

The same SSR-safety rule applies to every component under `packages/web/app/components/` and every route under `packages/web/app/**/page.tsx` — lazy initializers / ref initial values reading `window.*` / `localStorage.*` / `document.*` / `navigator.*` are forbidden across the surface, not just in `AppShell.tsx`.

**Enforcement additions for the amendment.** Two new live regression scans in the ADR-057 describe block:

- No `useState(...)` lazy initializer in `packages/web/app/components/**` (or `packages/web/app/**/page.tsx`) calls `window.*` / `localStorage.*` / `document.*` / `navigator.*`.
- No `useRef(...)` initial value in those files calls the same browser APIs.

Both fail closed — match → fail, no match → pass. They flip to live the moment the AppShell patch lands.

**First application.** The implementation fix lands alongside this amendment (handoff prompt in conversation). Affected files: `AppShell.tsx` (primary patch), `incidents/page.tsx` (defense-in-depth guard), `GraphCanvas.tsx` (null-check on `cy.getElementById(id).remove()` — separate small defensive improvement on a file already being touched).

## ADR-058 — Web shell debugging surface

**Date:** 2026-05-10
**Status:** Active.

**Context.** When NEAT misbehaves in production — daemon down, registry stale, SSE reconnecting, proxy returning 5xx — the web shell currently fails silently. The user clicks something, nothing happens, no indication why. This is the worst failure mode for an MVP that's supposed to be diagnostic itself.

The fix is observable connection state plus loud-not-silent error surfaces. Not a debug-only feature — debugging IS the product, and the user shouldn't need to open devtools to see why a query failed.

**Decision.**

1. **StatusBar shows daemon connection state.** A small indicator (green / yellow / red dot) reflecting whether `GET /health` against `NEAT_API_URL` succeeded recently. Yellow = slow / retrying; red = failed for ≥ N attempts. Updated on a heartbeat (default 5s).
2. **SSE connection state visible.** When the `/events` EventSource is open, healthy, or reconnecting, the StatusBar reflects it. EventSource auto-reconnects per spec; a UI indicator tells the user *that* it's reconnecting, not just that updates have stopped flowing.
3. **No silent API errors.** Every fetch that returns a non-2xx status surfaces a transient toast or banner with the error envelope from ADR-040 (`{ error, status, details? }`). User sees what failed, not just nothing.
4. **Debug panel keyboard shortcut.** `Ctrl+Shift+D` (or `Cmd+Shift+D`) toggles a debug panel overlay showing:
   - Current `project` and `NEAT_API_URL`
   - Last 10 API calls with status code + duration
   - Last 10 SSE events with type + timestamp
   - Daemon health-check history
5. **Daemon URL is visible.** TopBar or StatusBar shows the value of `NEAT_API_URL` (or its public-facing equivalent) so the user knows which backend they're querying. Not a debug-only feature — multi-daemon environments will exist eventually.
6. **Read-only.** The debugging surface doesn't mutate state. It observes. Per the existing role discipline (ADR-039 MCP is read-only; ADR-040 REST has only two write endpoints; ADR-050 CLI verbs are read-only), the web debugging panel matches.

**Authority.** `packages/web/app/components/StatusBar.tsx` (connection indicator), `packages/web/app/components/TopBar.tsx` (URL surface), `packages/web/lib/proxy.ts` (error capture + toast emission), a new `packages/web/app/components/DebugPanel.tsx` (or similar) for the keyboard-shortcut overlay.

**Enforcement.** `it.todo` in `contracts.test.ts`:

- StatusBar.tsx renders a connection indicator element with a state attribute (`data-connection-state="ok|slow|down"`).
- StatusBar.tsx renders an SSE indicator with a state attribute.
- proxy.ts emits a toast / banner on non-2xx response.
- A `DebugPanel.tsx` (or equivalent) component exists and is keyboard-shortcut-toggleable.
- TopBar or StatusBar renders the daemon URL.

## ADR-059 — Web UI bootstrap from `neatd`

**Date:** 2026-05-10
**Status:** Active.

**Context.** Today running NEAT against an unfamiliar codebase requires three terminals: one for `neatd start` (REST + OTel), one for `npm run dev --workspace @neat.is/web` (the Next.js dev server), and a third for the user's own work. The user has to know the right `dev` invocation, and the Next.js port (currently the Next.js default `3000`) collides with every other Node project they may have running.

For the MVP-success-PR experiment, this is a non-starter: the operator runs `neatd start` against medusa, expects to be able to view the graph, and there's no obvious way. The web shell that ADRs 056-058 govern is unreachable.

The fix is for `neatd start` to launch the web UI alongside the REST + OTel listeners, on a port that's narratable and unlikely to clash.

**Decision.**

1. **`neatd start` launches the web UI.** As part of the daemon's startup, after the REST API and OTel receivers are listening, `neatd` spawns the web UI as a child process. The web UI runs in production mode (`next start`), not dev mode.
2. **Default port: `6328`.** This is NEAT in T9 phone keypad (N=6, E=3, A=2, T=8). Memorable, narratable, and not in `/etc/services` or any common-port list. The number doesn't carry a stronger semantic; it's chosen to avoid the universal collisions on `3000`, `5000`, `8000`, `8080`.
3. **Override via `NEAT_WEB_PORT` env var.** If the user wants a different port (CI environments, port already in use locally, multi-instance setups), they set it. neatd reads the env at start time.
4. **Fail loudly on port collision.** If port 6328 is already in use and no override is provided, `neatd start` aborts with a clear error message: `port 6328 in use; set NEAT_WEB_PORT to override or stop the conflicting process.` No silent fallback to a random port — the user needs to know what URL to open.
5. **Port relationship.** REST API on `8080`. OTel HTTP on `4318`. OTel gRPC on `4317` (opt-in). Web UI on `6328`. Each port has one job; each is overridable via its own env var (`PORT` for REST, `OTEL_PORT` for OTel HTTP, `NEAT_OTLP_GRPC_PORT` for OTel gRPC, `NEAT_WEB_PORT` for the web UI).
6. **Web UI inherits `NEAT_API_URL` automatically.** When neatd spawns the web UI process, it sets `NEAT_API_URL=http://localhost:<rest-port>` so the web shell points at the same daemon that launched it. The user doesn't configure this twice.
7. **Shutdown cascades.** When `neatd stop` is invoked or `SIGTERM` reaches the daemon, the spawned web UI process is also stopped (process group kill or explicit child termination). No orphaned web UI processes.
8. **Distribution.** The `@neat.is/web` package is published to npm as part of the umbrella (along with core / mcp / claude-skill / types). `neatd` resolves the web UI's location via `require.resolve('@neat.is/web/package.json')` and runs its production-mode start script. This requires bumping `@neat.is/web` from `private: true` to publishable and including it in the lockstep version bump going forward.

**Out of scope.**

- **Static-export bundling into `@neat.is/core`.** Considered (single port, single process, simpler). Rejected for MVP because it requires rewriting Jed's existing Next.js API routes as direct fetches to the backend (lose proxy abstraction), and it forks the web track's existing development workflow (`next dev` for live-reload). The child-process approach preserves Jed's track unchanged. If real-user signal demands single-port simplicity, that's a successor ADR.
- **Process supervision / restart-on-crash for the web UI.** Per ADR-049 the daemon doesn't auto-restart on crash; same rule applies to the spawned web UI. External supervisors (launchd, systemd) can wrap the whole thing if needed.
- **Authentication on the web UI.** Localhost-only, MVP. Future ADR if multi-user / hosted instances become a thing.

**Authority.** `packages/core/src/neatd.ts` (spawning logic), `packages/web/package.json` (publishability + start script), `@neat.is/web` distribution (becomes part of the umbrella).

**Enforcement.** `it.todo` block in `contracts.test.ts`:

- `neatd.ts` spawns a web UI child process during `cmdStart`.
- The child process runs on `process.env.NEAT_WEB_PORT ?? 6328`.
- The child inherits `NEAT_API_URL=http://localhost:${restPort}`.
- Port collision on the configured web port aborts neatd with the exit-3 / clear-error pattern from ADR-049.
- `neatd stop` kills the spawned web UI process.
- `@neat.is/web` is no longer `private: true` and is included in the umbrella's lockstep version bump (publish-system contract gets a fifth-package-becomes-six update).

The publishability change touches the publish-system contract (ADR-052) and the umbrella's `dependencies` list. That's a structural change to the publish surface — flag for the implementing agent, may warrant a successor ADR amendment to ADR-052 if the lockstep set grows from five to six.

## ADR-060 — `get_divergences` — the thesis surface

**Date:** 2026-05-10
**Status:** Active.

**Context.** Every layer in the v0.2.x sequence was building toward this query, and we waited until the end to string it all together. The data layer (ADRs 028-031) gave provenance and edge identity. Static extraction (ADR-032) populated the EXTRACTED layer. OTel ingest (ADR-033) populated the OBSERVED layer. The coexistence rule (ADR-029 #2) refused to collapse them — *"the gap between declared intent and observed reality is the load-bearing semantic"* — and kept the disagreement legible. Traversal (ADRs 036-038) gave us walks across the resulting graph. The MCP, REST, and CLI surfaces (ADRs 039, 040, 050) gave the agent and the human ways to ask. And ADR-027 named the whole point: *"MVP success = closing a real PR on an open-source codebase, where the OBSERVED layer was load-bearing — not just static analysis a Graphify fork could match."*

But the nine MCP tools (ADR-039) don't expose the thesis directly. `get_root_cause` walks back from a failing node; `get_blast_radius` walks forward from any node; `get_dependencies` and `get_observed_dependencies` each show one provenance in isolation. A consumer can compute the divergence by calling two of them and set-diffing client-side, but they have to know to do that. The query that says *"here is where what the code claims and what production observes don't match — sorted by confidence, with a recommendation per row"* doesn't exist as a first-class operation.

This ADR closes that gap. `get_divergences` is the synthesis — the one query the v0.2.x layers were converging on, surfaced at the same three places every other read operation is: REST, MCP, CLI.

The frontend surfaces for this query are real and several, but they belong to the v0.3.0 track. They're captured separately in `docs/frontend-divergence-suggestions.md` so the backend contract can ship now and frontend integration follows when Jed paces it.

**Decision.**

1. **Schema.** A `Divergence` is a typed result with five variants discriminated by `type`:

   ```ts
   type Divergence =
     | { type: 'missing-observed', source: string, target: string, edgeType: EdgeType,
         extracted: GraphEdge, confidence: number, reason: string, recommendation: string }
     | { type: 'missing-extracted', source: string, target: string, edgeType: EdgeType,
         observed: GraphEdge, confidence: number, reason: string, recommendation: string }
     | { type: 'version-mismatch', source: string, target: string,
         extractedVersion: string, observedVersion: string, compatibility: 'incompatible' | 'deprecated' | 'unknown',
         confidence: number, reason: string, recommendation: string }
     | { type: 'host-mismatch', source: string, target: string,
         extractedHost: string, observedHost: string,
         confidence: number, reason: string, recommendation: string }
     | { type: 'compat-violation', source: string, target: string,
         rule: CompatRule, observed: GraphEdge,
         confidence: number, reason: string, recommendation: string }
   ```

   Lives in `packages/types/src/divergence.ts`. Schema growth per ADR-031 — snapshot-test catches the addition; no `persist.ts` migration needed (Divergence isn't persisted; it's computed at query time).

   `DivergenceResultSchema`:

   ```ts
   { divergences: Divergence[], totalAffected: number, computedAt: string /* ISO8601 */ }
   ```

2. **REST endpoint.** `GET /graph/divergences` (dual-mounted per ADR-026 at `/graph/divergences` and `/projects/:project/graph/divergences`). Query params:
   - `type` (optional) — comma-separated filter by `Divergence['type']`
   - `minConfidence` (optional) — float 0.0-1.0; only divergences with confidence ≥ this
   - `node` (optional) — node id; only divergences involving this node as source or target

   Returns `DivergenceResult`. Same JSON error envelope as ADR-040.

3. **MCP tool.** `get_divergences`. **Amends ADR-039's locked allowlist of nine tools to ten.** The amendment is explicit, not a quiet bend. Tool description:

   > *"Returns places where what the code declares (EXTRACTED) doesn't match what production observed (OBSERVED). The single most NEAT-shaped query — the one that justifies the whole graph. Use when the user asks 'is anything weird?' or 'what does production do that the code doesn't?' or 'find me a bug' on an unfamiliar codebase. Returns divergences ranked by confidence × severity. Prefer this over `get_root_cause` when no specific node is failing."*

   Routes through the REST client per ADR-039 rule. Three-part response per ADR-039:
   - NL summary: *"Found N divergences in project X. Highest-confidence: <description>."*
   - Structured block: serialized `DivergenceResult`
   - Footer: `confidence: <max> · provenance: composite (EXTRACTED + OBSERVED)`

4. **CLI verb.** `neat divergences`. **Amends ADR-050's locked allowlist of nine verbs to ten.** Same amendment shape as the MCP tool. Flags:
   - `--type <type[,type]>` — filter by type
   - `--min-confidence <float>` — filter by minimum confidence
   - `--node <id>` — scope to divergences involving a specific node
   - `--json` — machine-readable output per ADR-050 rule 3
   - `--project <name>` — same scoping as the other verbs

5. **The five divergence types — detection rules.** Computed against the live graph at request time. No persistence; pure derivation.

   - **`missing-observed`** — there exists an EXTRACTED edge `(source, target, edgeType)` and no OBSERVED edge for the same triple. Confidence: 1.0 if any traffic at all has been observed on `source`, else 0.5 (could just be untested). Reason: *"Code claims `source` calls `target` but no production traffic observed."* Recommendation: *"Verify the code path is exercised; check feature flags / conditionals."*
   - **`missing-extracted`** — there exists an OBSERVED edge `(source, target, edgeType)` and no EXTRACTED edge for the same triple. Confidence: cascaded from the OBSERVED edge's confidence. Reason: *"Production observed `source` calls `target` but static analysis didn't surface this call."* Recommendation: *"Likely dynamic dispatch, reflection, or coverage gap in tree-sitter extraction. Consider an `aliases` entry on `source` or filing an extractor issue."*
   - **`version-mismatch`** — `source` is a `ServiceNode` with a declared dependency version (via `dependencies` field), and `source` has an OBSERVED edge to a `target` whose `engineVersion` is incompatible per `compat.json`. Reuses the existing compat infrastructure. Confidence: 1.0 (compat rule definitive). Recommendation pulls from compat.json's recommendation field.
   - **`host-mismatch`** — `source` has an EXTRACTED `CONFIGURED_BY` edge pointing at a config that declares a host, AND an OBSERVED `CONNECTS_TO` edge whose target's host is different. Reason: *"Config declares host X; production connects to host Y."* Recommendation: *"Check environment-specific config overrides."*
   - **`compat-violation`** — broader than version mismatch. Any compat.json rule that fires against an OBSERVED edge. Recommendation pulled from the rule.

6. **Confidence ranking.** Divergence rows are returned in `confidence` descending order by default. Type-specific severity weights are NOT in scope — the consumer can re-rank.

7. **No persistence.** Divergence is derived state, not stored state. Each query computes fresh. The graph is the source of truth; if the user wants to audit divergences over time, they snapshot the graph (existing ADR-041 mechanism). No `divergences.ndjson` sidecar.

8. **No mutation.** `get_divergences` is read-only. Per the read-only discipline across MCP / REST / CLI / web (ADRs 039, 040, 050, 058), divergences observe — they don't suppress, dismiss, snooze, or otherwise mutate graph state.

9. **Frontend integration is OUT of scope for this contract.** Captured in `docs/frontend-divergence-suggestions.md` as recommendations, not bindings. Jed paces v0.3.0; this contract specifies the backend surface that v0.3.0 will consume.

**Authority.**

- **Schema:** `packages/types/src/divergence.ts` (new).
- **Computation:** `packages/core/src/divergences.ts` (new) — pure functions, read-only, no mutation. Operates on a `NeatGraph` reference.
- **REST surface:** new endpoint in `packages/core/src/api.ts`, dual-mounted per ADR-026.
- **MCP surface:** new tool in `packages/mcp/src/index.ts`, routed through the REST client.
- **CLI surface:** new verb in `packages/core/src/cli.ts`, plus client implementation in `packages/core/src/cli-client.ts`.

**Enforcement.** `it.todo` block in `contracts.test.ts` for ADR-060. Regression assertions:

- `DivergenceSchema` exists in `@neat.is/types` with the five-variant discriminated union and parses each variant cleanly.
- `GET /graph/divergences` is registered and dual-mounted per ADR-026.
- `get_divergences` is registered as the tenth MCP tool (amends the ADR-039 allowlist scan).
- `neat divergences` is registered as the tenth CLI verb (amends the ADR-050 allowlist scan).
- For each of the five divergence types: a fixture graph triggers the type, the query returns the expected divergence with correct schema, confidence, recommendation.
- Read-only: `divergences.ts` contains no graph mutation calls.
- Filtering works: `?type=`, `?minConfidence=`, `?node=` each narrow the result correctly.

**Amendments to prior contracts.**

This ADR explicitly amends two locked allowlists:

- **ADR-039** — nine MCP tools → ten. The ADR-039 contract test (`every server.tool registration has a name from the locked allowlist`) gets the tenth name added.
- **ADR-050** — nine CLI verbs → ten. The ADR-050 contract test (`every MCP tool has a corresponding neat <verb>`) gets the tenth pairing added.

Both amendments are documented here, not in ADR-039 / ADR-050. The original ADRs stay frozen as the historical record; this ADR records the change. Future ADRs use the same pattern when expanding locked allowlists — explicit reference, not quiet drift.

**Why we waited.** Every component of `get_divergences` existed before this ADR — the data, the schema, the coexistence rule, the traversal primitives, the surfaces. The reason we didn't ship this query at v0.2.4 (when MCP first locked its allowlist) was the layers underneath weren't yet stable. ADR-029's edge-id wire format had to lock before "match EXTRACTED to OBSERVED" was well-defined. ADR-033's OTel ingest had to land before we had OBSERVED edges to compare against EXTRACTED in any volume. ADR-052's publish system had to work before the operator could actually install NEAT against an unfamiliar codebase. The thesis surface only made sense once every underneath layer was locked.

The MVP-success-PR experiment (ADR-027) was the gate forcing the synthesis. The operator running NEAT against medusa for 24-48h needs *one* query that says *"here are the divergences."* This ADR is that query.

**What we're NOT doing.**

- **Divergence acknowledgement model.** No "snooze for 7 days", no "this divergence is intentional, mute it." Divergences are derived from the graph; if the graph changes, divergences disappear. If the user wants to suppress noise, they fix the underlying data (add an EXTRACTED edge to close a `missing-extracted`, etc.) or filter at the query layer.
- **Custom divergence rules.** The five built-in types are the lock. User-defined divergence rules would extend the policy schema (ADR-042) and would be a successor ADR — probably called when real-user signal demands "alert me when divergence type X involving service Y appears."
- **Cross-project divergences.** Per ADR-026, each project is its own graph. Divergence list is per-project. Cross-codebase joins remain explicitly out of MVP.
- **Persistence of divergence history.** No `divergences.ndjson` sidecar. The graph snapshot is the audit trail; if the operator wants divergence history, they diff snapshot N against snapshot N+1.
- **SSE push for new divergences.** ADR-051's locked taxonomy is eight types; expanding to nine for `divergence-detected` would be a successor ADR if Jed's track surfaces the demand. For MVP, polling `/graph/divergences` works.

## ADR-061 — REST API path canonicalization + response envelope rule

**Date:** 2026-05-11
**Status:** Active. Amends ADR-040.

**Context.** The web shell shipped against an API surface that doesn't match the backend. The user hit it on the Incidents page first: `TypeError: can't access property "length", data.events is undefined`. Tracing it revealed a class of bugs, not one bug.

The audit at `docs/plans/2026-05-11-rest-audit.md` (referenced inline below; not a separate file because the findings live here) surfaced two kinds of drift:

**Path drift** — backend has routes at paths the contract doesn't specify and frontend doesn't call:
- `/traverse/blast-radius/:nodeId` (contract + frontend say `/graph/blast-radius/:nodeId`)
- `/traverse/root-cause/:nodeId` (contract + frontend say `/graph/root-cause/:nodeId`)
- `/incidents/stale` (contract + frontend say `/stale-events`)
- `/graph/node/:id/dependencies` (contract says `/graph/dependencies/:nodeId`)

**Shape drift** — backend returns bare arrays / bare values where the contract + frontend expect wrapped envelopes:
- `/incidents` returns `ErrorEvent[]`; frontend expects `{ count, total, events }`
- `/policies/violations` returns `PolicyViolation[]`; frontend expects `{ violations }`
- `/stale-events` (at any path) returns `StaleEvent[]`; frontend expects `{ count, total, events }`
- `/graph/node/:id` returns `GraphNode`; contract says `{ node }`
- `/incidents/:nodeId` (per-node filter) returns bare filtered array; same wrap expected

Neither drift class was caught by existing regression tests. ADR-040's contract scan asserts:
- Routes exist
- Routes dual-mount per ADR-026
- JSON error envelope on failures
- POST bodies parse via Zod

It does *not* assert response body schemas, and the path-level scan happily accepts whatever path the backend declares without checking it matches the canonical contract list.

The result: every web shell call to a blast-radius, root-cause, stale-events, or incidents view either 404s or hits the wrong shape. ADRs 056-060 shipped on a backend the frontend couldn't actually talk to for several of its surfaces.

**Decision.**

1. **Path canonicalization — backend renames to match the contract.** The `rest-api.md` contract is the authoritative artifact (per ADR-005 process discipline); implementation aligns. Four renames in `packages/core/src/api.ts`:
   - `/traverse/root-cause/:nodeId` → `/graph/root-cause/:nodeId`
   - `/traverse/blast-radius/:nodeId` → `/graph/blast-radius/:nodeId`
   - `/incidents/stale` → `/stale-events`
   - `/graph/node/:id/dependencies` → `/graph/dependencies/:nodeId`

   No backward-compat aliases. The drifted paths were never on the public contract; the frontend never called them; external consumers (MCP, CLI) route through `client.ts` which uses the canonical names. Renaming straight is the safest option.

2. **Response envelope rule.** Every GET response from the REST API is a JSON object (never a bare array, never a bare value). The object's top-level keys describe the resource being returned:
   - **List endpoints** wrap their list in a plural-noun field plus a count: `{ count: N, total: M, events: [...] }`, `{ violations: [...] }`, etc. `count` is the length of the returned array; `total` is the size of the underlying collection before filtering / limiting.
   - **Single-item endpoints** wrap the item in a singular field: `{ node }`, `{ edge }`.
   - **Structured-result endpoints** (root cause, blast radius, divergences, diff) return their result type as the top-level object — already objects by virtue of their schema.

   Bare arrays from REST endpoints are a contract violation going forward. The rule is for the consumer's benefit: a JSON object can grow new top-level fields without breaking parsers; a bare array can't.

3. **Required wraps (the specific fixes):**
   - `/incidents` and `/incidents/:nodeId` → `{ count, total, events: ErrorEvent[] }`
   - `/stale-events` → `{ count, total, events: StaleEvent[] }`
   - `/policies/violations` → `{ violations: PolicyViolation[] }`
   - `/graph/node/:id` → `{ node: GraphNode }`

4. **New schemas in `@neat.is/types` for the response shapes.** Each wrap gets a Zod schema:
   - `IncidentsResponseSchema`
   - `StaleEventsResponseSchema`
   - `PoliciesViolationsResponseSchema`
   - `GraphNodeResponseSchema`

   Per ADR-031, these are schema growth (commit-and-go; snapshot fixture regenerates).

5. **Contract test class — response shape assertions.** Extend the ADR-040 describe block in `contracts.test.ts`: for each documented REST endpoint, hit the route against a fixture graph and parse the response through its declared schema. Failure to parse fails the test. This catches Class B drift mechanically going forward.

6. **Path consistency assertion.** Add a regression scan: every `scope.get` / `scope.post` path in `api.ts` must appear in `docs/contracts/rest-api.md`'s endpoint table. Drift in either direction (route exists in code but not in contract; route documented but not implemented) fails the test.

7. **Coverage gaps — endpoints backend has but contract doesn't.** Add to `rest-api.md`:
   - `GET /incidents/:nodeId` — per-node incident filter
   - `GET /projects/:project` — singular project lookup
   - `GET /graph/divergences` — already part of ADR-060's surface

**Authority.** `packages/core/src/api.ts` (the implementation), `docs/contracts/rest-api.md` (the canonical paths and shapes), `packages/types/src/index.ts` (the response schemas).

**Enforcement.** New describe block in `contracts.test.ts` for ADR-061. Live + `it.todo` assertions:

- For each Class A rename, the backend handler is registered at the canonical path (regex scan of `api.ts` against the contract's endpoint list).
- For each Class B wrap, the response parses through its declared Zod schema (live runtime assertion, requires fixture data).
- Path consistency: every `scope.get` / `scope.post` path appears in the contract's endpoint table.
- No backend handler returns a bare array from a GET endpoint (scan for `return events` / `return violations` / similar bare-collection returns).

**Why we didn't catch this earlier.**

Three independent layers should have flagged this and didn't:

1. **The audit-doc trail.** The 2026-05-04 verification pass didn't audit REST response shapes — it audited graph correctness. Subsystem audits in `docs/audits/NEAT-audit-*.md` similarly didn't grade the REST layer's response bodies.
2. **The contracts.test.ts surface.** As covered above — assertions stopped at "route exists" / "dual-mounted" / "JSON error envelope." Body schemas weren't checked.
3. **The API reference doc.** `docs/api-reference.md` documented the canonical shapes correctly. But the doc isn't enforced as a contract today — it's a reference for consumers, not a binding rule on producers. This ADR makes the doc-implementation linkage testable.

The pre-v0.3.0 verification pass (`docs/plans/2026-05-10-pre-v0.3.0-verification.md`, Finding 9 / NOTE 9.2) flagged that per-subsystem audits should be re-graded before public release. That re-grade would have caught Class A; it's still queued.

**Out of scope.**

- **Versioning the REST API.** No `/v1/` prefix, no `Accept-Version` header. MVP is single-version; if NEAT ever needs multi-version support, that's a successor ADR.
- **HATEOAS / hypermedia.** Out for MVP. Bare JSON.
- **GraphQL / tRPC.** Speculative; not earned by current consumer demand.
- **Backward-compatibility aliases for the renamed paths.** As noted in decision #1, none of the drifted paths were on the contract or called by any non-test consumer. Renaming clean is the right call.
- **The CLI / MCP surface.** Both already route through the canonical names via `client.ts`. No CLI or MCP changes needed for this ADR.

**First application.** This ADR ships in v0.2.11. The implementation work is delegated to a fresh Implementation Agent per the role discipline; the handoff prompt is in the conversation.

## ADR-062 — Web shell renders client-only; SSR disabled at the AppShell boundary

**Date:** 2026-05-11
**Status:** Active. Supersedes the ADR-057 "rule 2a" amendment (2026-05-11). Rules 1-9 of ADR-057 are retained.

**Context.** ADR-057's "rule 2a" amendment landed earlier today to fix a hydration error: `Text content did not match. Server: "default" Client: "Neat"`. The fix mandated that every web component produce byte-identical HTML on SSR and first client render — concretely, `useState<string>('default')` on both, with the URL → localStorage → /projects → 'default' chain deferred to a `useEffect`.

While reviewing the implementation patch (PR #226), the question that should have been asked at amendment time finally got asked: *why is the web shell server-rendering in the first place?*

NEAT's web shell is an internal admin UI:

- No SEO. Not public, not crawler-indexed, not link-previewable.
- No first-paint requirement that real data be visible. Cytoscape, the graph canvas, the Inspector, the StatusBar — all boot client-side regardless of SSR, after their respective fetches resolve.
- Served by `neatd start` on `localhost:6328` to a single operator session per machine (per ADR-059).
- The graph, the project list, the incidents log — every payload is client-fetched after mount.

SSR was contributing exactly one thing: ~50-150ms of static chrome (TopBar / Rail / StatusBar shells) emitted before client JS runs. In exchange, every interactive component had to be SSR/CSR byte-identical. The 2a amendment was the formalisation of that tax.

The amendment also had a second-order cost that wasn't visible at amendment time: with `'default'` mandated as the SSR initial state, every `useEffect([project])` consumer in the tree — GraphCanvas, Inspector, StatusBar, Rail, the `/incidents` page — fires twice on every page load. Once against `'default'` (kicking off a fetch for the default project), then again against the resolved project (kicking off the real fetch). That's six-plus redundant round-trips per page load, plus a visible UI flicker as components swap their data mid-mount.

Both costs come from the same source: we're paying an SSR tax for a benefit we don't use.

**Decision.**

1. **AppShell renders client-only.** `packages/web/app/page.tsx` mounts AppShell via `next/dynamic` with `{ ssr: false }`. The server emits the static HTML shell (head, fonts, CSS link, empty `<body>`); the entire React tree builds on the client.

2. **Rule 2a is removed.** With no SSR pass over AppShell, the byte-identical-initial-state requirement no longer binds. AppShell may read `window.location.search` and `window.localStorage` synchronously during its render path. The pre-amendment lazy initializer pattern is restored: `useState<string>(() => readUrlProject() ?? readStoredProject() ?? 'default')`.

3. **The /projects fetch step stays in useEffect.** It's async by nature and can't move into the initializer. It runs only when steps 1-2 of the resolution chain produced no value (i.e., the synchronous chain resolved to `'default'`).

4. **Other routes keep SSR.** `/incidents` is a separate route, already SSR-safe via its useEffect-scoped browser reads. Layout, fonts, the `/api/*` route handlers — all stay server-rendered. The minimum-blast-radius rule (cross-cutting #11) says we don't expand the change beyond what's needed.

5. **Trade-off accepted.** The user sees a blank `<div class="app">` for ~50-150ms before the chrome paints. Strictly faster-feeling than the 50ms `'default'`-flash the amendment introduced, because (a) the rendered project name is correct on first paint instead of switching mid-load and (b) downstream `useEffect([project])` consumers fire once against the resolved project rather than twice.

6. **Future work — full static export.** A more thorough SSR-off shape is `next.config.js` `output: 'export'`, which makes the entire web shell a static client. That shape breaks the 11 `/api/*` route handlers under `packages/web/app/api/` — they'd need to migrate into the daemon's HTTP surface. That's a milestone-sized refactor and is out of scope for ADR-062. When the daemon HTTP surface absorbs the proxy layer (likely alongside or after MVP-success per ADR-027), full static export becomes the obvious next step.

**Authority.** `packages/web/app/page.tsx` (the dynamic boundary), `packages/web/app/components/AppShell.tsx` (synchronous browser reads allowed again, lazy initializer restored).

**Enforcement.** Replaces the two ADR-057 #2a regex scans in `contracts.test.ts`:

- `app/page.tsx` imports `dynamic` from `next/dynamic` and instantiates AppShell with `{ ssr: false }`.

The two SSR-safety scans (no `useState` lazy initializer / `useRef` initial value reads browser globals in web components) are removed — they were guarding a constraint that no longer applies.

**Why a new ADR and not a third amendment to ADR-057.** Amendments are appropriate for tightening or clarifying an existing rule; ADR-062 removes a rule and adds a structurally different one (client-only render boundary vs SSR-safe execution discipline). Treating it as supersession leaves the trail readable for future sessions.

**Amendment (2026-05-11) — §4 extended to /incidents.**

The /incidents page had the same double-fetch shape AppShell did before ADR-062: `useState<string>('default')`, a `useEffect` that resolves the project from URL/localStorage, and a `useEffect([project])` that re-fires once the resolved value lands. Same root cause as the AppShell case — the SSR initial state has to be `'default'` to keep hydration byte-identical, which mandates the deferred resolution — and the same fix shape applies.

§4 ("Other routes keep SSR") is amended: `/incidents/page.tsx` also mounts client-only via `dynamic({ ssr: false })`. Layout, `/api/**` routes, and any future routes default to SSR; an additional route opts out only by being added here. This keeps the minimum-blast-radius principle intact — every SSR-off opt-out is named explicitly, not opted into by default.

## ADR-063 — `neatd start` binds REST and OTLP per project (amends ADR-049)

**Date:** 2026-05-12
**Status:** Active. Amends ADR-049 (daemon contract). Rules from ADR-049 are retained except where this ADR sharpens them.

**Context.** The 2026-05-12 ADR-027 experiment (`docs/plans/2026-05-12-post-mvp-experiment-scope.md`) ran `neatd start` against a 2-project registry on a fresh install of `neat.is@0.3.0`. The daemon process came up, `neatd status` reported pid + projects ticking, but `lsof -p $(pgrep neatd) -P` showed no listeners. Every `neat <query>` verb failed with `cannot reach neat-core at http://localhost:8080: fetch failed`.

Reading the v0.3.0 implementation back against ADR-049: the daemon bootstraps per-project graphs, loads snapshots, runs `extractFromDirectory`, starts persist loops, and spawns the web UI. It does not bind a REST host. It does not bind the OTLP receiver. ADR-049's "single long-lived process, per-project graph isolation, mtime + OTel + policy.json triggers" was satisfied to the letter — the graphs are isolated, the registry is read, the PID file is written — and yet none of the surfaces a consumer (CLI, MCP, web UI, OTel exporter) can reach are bound.

The wording wasn't observably testable. v0.3.0 read it as "start the supervisor and call it good." The contract assertions in `contracts.test.ts` under `Daemon contract (ADR-049)` mirrored the wording — they checked `slots` membership, OTel routing as a pure function, registry re-read on SIGHUP, PID-file write/cleanup, and graceful degradation on missing registry. None of them asserted that anything actually listens on a port after `startDaemon()` returns.

The trace stitcher / extraction story (ADR-034, ADR-035) was load-bearing on the OTel receiver being live. The CLI verbs (ADR-050) and MCP tools (ADR-039) were load-bearing on the REST host being live. Neither was, and the contract test suite didn't notice.

**Decision.**

1. **Binding is the contract surface.** After `neatd start` returns success, every project registered in `~/.neat/projects.json` has its graph host bound and reachable through the dual-mount paths from ADR-026 (`GET /projects/:project/graph` returns 200). The default-project unprefixed paths from ADR-026 (`GET /graph`) are also reachable. The OTLP HTTP receiver on `:4318` is bound for span ingest, single-instance and multi-project tenant by `service.name` per the existing ADR-049 OTel routing section. Bind happens within 30 seconds of the `startDaemon` promise resolving.

2. **REST host on `:8080`, single-instance, multi-tenant.** One Fastify app, one listener, every registered project mounted under `/projects/:project/*` (ADR-026 dual-mount). The default project additionally answers the unprefixed legacy paths. Per-project ports are not introduced — there's one `:8080`, the project is in the URL.

3. **OTLP receiver on `:4318`, single-instance, multi-tenant.** One receiver. Span routing happens at handler time via `routeSpanToProject(serviceName, projects)` (already exported from `daemon.ts`). Spans for unknown services route to the `default` project's FrontierNode flow per ADR-033.

4. **Failure to bind is fatal.** A failed `app.listen` on either port (EADDRINUSE, permission denied, etc.) aborts `neatd start` with a non-zero exit and a clear error message. Silent fallback to "the daemon is running but only the supervisor is up" is forbidden — that's the v0.3.0 failure mode this ADR exists to close.

5. **`NEAT_WEB_DISABLED=1` skips the web UI only.** REST and OTLP bind unconditionally. The web UI was opt-out for `neat init` users who run NEAT headless; REST/OTLP are non-negotiable because every `neat <verb>` consumer (CLI + MCP) depends on the REST host being live.

6. **Authority.** `packages/core/src/daemon.ts` is the surface where the bind happens — it owns the supervisor that knows the per-project slot set and is the right place to install the listener. `server.ts` stays the `neat watch` / single-project entry point; the multi-project listener inside `daemon.ts` shares the same `buildApi` (via a `Projects` registry seeded from daemon slots) and the same `buildOtelReceiver` so the wire formats stay identical to `neat watch`.

**Why amending ADR-049 and not writing a successor.** ADR-049's rules 1-7 (single long-lived process, per-project isolation, lifecycle commands, OTel routing, OTel ingest behaviour, graceful degradation, PID file) are all still correct. This ADR adds an observability rule that should have been in the original — concretely: "what `startDaemon` returning success means is testable from a `curl` outside the process." Amendment is the lighter touch; ADR-049 stays the canonical daemon ADR with an extended observability section.

**Enforcement.** New live assertions in `packages/core/test/audits/contracts.test.ts` under `Daemon contract (ADR-049)`:

- `it('binds REST on :8080 within 30s of startDaemon resolving')` — start daemon against a 2-project sandbox registry on an ephemeral port, poll `GET /graph` until 200 or 30s elapses, then assert 200.
- `it('binds OTLP HTTP receiver on :4318 within 30s of startDaemon resolving')` — same shape; assert the receiver socket is bound (Fastify's documented response code on a `GET` against the receiver is acceptable as long as the socket accepted the connection).
- `it('every registered project answers GET /projects/:project/graph with 200')` — iterate the sandbox registry, fetch the dual-mount path per project, assert 200 each.

The three assertions land as `it.todo` in the contract amendment PR (the implementation isn't there yet) and flip live in the v0.3.1 implementation PR (#232). The amendment closes when both ship and the daemon answers a `curl` from outside the process.

**Why a 30-second deadline.** The default daemon bootstrap reads a snapshot, runs `extractFromDirectory`, and starts a persist loop per project. On a registry with a single moderate project (~5k files), bootstrap completes in 2-5 seconds; on a 10-project registry of moderate projects, it takes ~30 seconds wall-clock on a modern laptop. The deadline matches the upper bound of realistic bootstrap time, not the lower bound, so the assertion is sensitive to "the daemon didn't bind" (the v0.3.0 bug, which would never bind) without being noisy on "bootstrap is slow because the project is large."

**Not in scope.**

- **OTLP/gRPC binding.** ADR-049 already says gRPC is opt-in via `NEAT_OTLP_GRPC=true`. This ADR doesn't change that — `:4318` is in scope because it's the documented default; `:4317` stays opt-in.
- **Per-project graph hosts on separate ports.** The "fork a per-project REST host" framing in #232's fix-shape turned out to be the wrong reading on second look — `buildApi` already handles the multi-tenant case via a `Projects` registry. One listener, one port, project routing in the URL.
- **Daemon vs `neat watch` consolidation.** `neat watch` (single-project) and `neatd start` (multi-project) coexist for now per the scope doc. Future work might collapse them; this ADR doesn't.

Full rationale and the v0.3.0 failure-mode evidence: `~/neat-experiment/bugs/NEAT-BUG-2-neatd-never-binds-rest.md`.

## ADR-064 — Tarball smoke-test verifies built web artifact + post-`neatd start` liveness (amends ADR-052)

**Date:** 2026-05-13
**Status:** Active. Amends ADR-052 (publish system contract). Rules from ADR-052 are retained except where this ADR sharpens the smoke-test gate.

**Context.** The v0.3.0 publish landed three blocker bugs that the existing tarball smoke-test gate (ADR-052 §3) didn't catch: NEAT-BUG-1 (`@neat.is/web` shipped without a built `.next/` directory, so `neatd start`'s web UI crashes on every fresh install), NEAT-BUG-2 (`neatd start` never bound REST or OTLP — closed at v0.3.1 via ADR-063), and NEAT-BUG-3 (`neat watch` EMFILE on any repo with nested `node_modules`).

The current smoke-test step installs the published umbrella, runs `neat --help`, and exits. That catches the 0.2.6-class failure (broken bin-wrapper subpaths) and nothing else. It doesn't read the web tarball, it doesn't spawn `neatd start`, it doesn't observe whether anything actually listens. The v0.3.0 publish passed this smoke test cleanly and shipped a stack that couldn't serve the documented `npm install -g neat.is && neatd start && open http://localhost:6328` happy path on any machine.

Plus: the v0.3.1 publish's smoke-test step failed on a registry-propagation race — `neat.is@0.3.1` was visible to `npm view`, the install ran, but `@neat.is/web@^0.3.1` hadn't propagated yet, so `npm install neat.is@0.3.1` failed `ETARGET: No matching version found for @neat.is/web@^0.3.1`. The retry loop checked only the umbrella, not the deps it pulls in. Lockstep visibility, not just umbrella visibility, is what the gate has to wait for.

**Decision.**

1. **Per-dep visibility wait.** Before the smoke install, the workflow waits for every package in the lockstep set (`@neat.is/types`, `@neat.is/core`, `@neat.is/mcp`, `@neat.is/claude-skill`, `@neat.is/web`, `neat.is`) to appear at the target version on the registry. The current single-package retry loop on the umbrella is insufficient.

2. **Web artifact presence in the installed tree.** After `npm install neat.is@<version>`, the unpacked `node_modules/@neat.is/web/` must contain a built artifact at the bundling form #231 lands — either `.next/standalone/server.js` or the equivalent. The smoke step asserts presence via `test -f` (or `ls`); absence fails the workflow. Catches NEAT-BUG-1 directly.

3. **Post-`neatd start` liveness checks.** The smoke step spawns `neatd start` against a fixture project registry, then within 30 seconds:
   - `curl http://localhost:8080/graph` returns 200 (NEAT-BUG-2; covered live at v0.3.1, asserted in CI from v0.3.2 onward).
   - `curl http://localhost:6328/` returns 200 (NEAT-BUG-1).
   - `:4318` is bound by the daemon process (NEAT-BUG-2 OTLP side).

   `NEAT_WEB_DISABLED=0` (i.e., web UI on). The check kills `neatd` after the asserts; the workflow runner's port range is owned by the job, no collision risk.

4. **Fixture project registry with realistic shape.** The smoke step creates `NEAT_HOME=$(mktemp -d)` and registers at least two projects: one named `default` (to exercise ADR-026's unprefixed legacy paths), and at least one whose project directory contains a populated `node_modules/` tree (to exercise NEAT-BUG-3's chokidar polling path under `neatd start`'s extraction triggers). Fresh projects with `npm init -y && npm install some-small-pkg` is the cheapest way to produce the latter.

5. **Failure is fatal, with no rollback option.** Per ADR-052 §6, npm immutability means a failed smoke test does not unship the broken version; the operator has to bump and re-publish. The smoke-test gate is the last-chance check before the broken publish becomes load-bearing for users.

6. **Contract assertions are workflow-shape regex checks.** `contracts.test.ts` doesn't run the smoke step itself (it would need to publish to npm to exercise it). It reads `.github/workflows/publish.yml` and asserts the smoke step contains the right invocations: `npm view` per-package wait, web-artifact presence check, `neatd start` spawn, three liveness curls, and a fixture-registry setup that includes ≥2 projects and ≥1 with nested `node_modules`. Wrong-shape workflow files block merge.

**Why amending ADR-052 and not writing a successor.** ADR-052's other rules (subpath validity, version lockstep, dependency order, engines floor, npm immutability) are all still load-bearing and correct. This ADR extends only the smoke-test gate from "does the bin entrypoint resolve" to "does the documented happy path work on a fresh install." Same shape of amendment as ADR-063 did to ADR-049 — sharpen the observability rule, leave everything else.

**Enforcement.** New assertions in `packages/core/test/audits/contracts.test.ts` under `Publish system contract (ADR-052)`:

- Workflow waits for every lockstep package's target version before installing the umbrella.
- Workflow asserts presence of a built `@neat.is/web` artifact in the installed tree.
- Workflow spawns `neatd start` and asserts liveness on `:8080`, `:6328`, and `:4318`.
- Workflow's fixture registry includes a project named `default` and a project with a populated `node_modules/`.

These ship live in the contract amendment PR — they assert on workflow content, which lands in the same PR. The actual smoke-test execution depends on the v0.3.2 implementation PRs (#231 for web `.next/`, #233 for `neat watch` polling) being merged before the next tag-publish.

**Not in scope.**

- **Tarball content sniffing without install.** Considered (`tar tzf` against `npm pack` output for each dep). Rejected for MVP — the install path already exercises the same code paths and gives a stronger signal.
- **Multi-platform smoke.** Workflow runs on `ubuntu-latest`; the NEAT-BUG-3 EMFILE bug is specifically macOS (`darwin`'s kqueue limit). Workflow CI catches the general shape; a macOS smoke runner is a successor concern.
- **Persistent fixture registry in the repo.** The fixture is a `mktemp -d` per workflow run. Anything more would need versioning + checked-in `node_modules` fixtures, which is more weight than the signal justifies.

Full rationale and the v0.3.0 failure-mode evidence: `~/neat-experiment/bugs/NEAT-BUG-1-web-ui-missing-next-build.md`, `~/neat-experiment/bugs/NEAT-BUG-3-neat-watch-emfile.md`.

## ADR-065 — Static-extraction precision filters + loud failure mode (amends ADR-032)

**Date:** 2026-05-13
**Status:** Active. Amends ADR-032 (static-extraction contract). Rules from ADR-032 are retained except where this ADR sharpens producer-side behaviour.

**Context.** The 2026-05-12 ADR-027 experiment ran `neat init` against `medusajs/medusa` (commit `370676c2a737fb3b558a745ad452a2c9d4ae6de5`) and surfaced 20 EXTRACTED edges in the divergence report. Every single one was a false positive. The evidence:

| Row | Wrong because |
|-----|---------------|
| 0001-0003, 0012, 0013 | URL-substring service matching — `medusa.cloud` matched `@medusajs/medusa` by `.includes('medusa')` |
| 0006 | JSX external link — `<Link to="https://medusajs.com/changelog/" target="_blank">` extracted as CALLS edge |
| 0007 | Raw `new S3Client(config)` produced `infra:grpc-service:S3` (NEAT-BUG-5, also fixed in #238) |
| 0008, 0015 | `.env.template` files registered as ConfigNode with CONFIGURED_BY edges |
| 0014 | **JSDoc `@example` comment body** — `*       "http://localhost:9000"` inside a comment block became a CONNECTS_TO edge |
| 0016 | `__tests__/*.spec.ts` file — `postgres://localhost/medusa-starter-default` string in test fixture extracted as a real edge (with the wrong target — `infra:redis:localhost`) |
| 0017, 0019, 0020 | More string-in-test variants of the above |
| 0018 | String literal `'localhost'` extracted as an infra edge |

Full corpus: `~/neat-experiment/bugs/0001-*.md` through `0020-*.md`, `INDEX.md`.

Plus: ~90 medusa source files silently failed extraction with the generic tree-sitter "Invalid argument" error and were skipped. `neat init` exited 0 with no summary mention. NEAT shipped a snapshot with those files quietly missing — and the divergence query has no way to surface gaps it doesn't know it has.

The divergence query (`get_divergences`, ADR-060) is supposed to be NEAT's thesis surface — "where does declared intent disagree with observed reality?" That surface is meaningless while EXTRACTED is itself hallucinated. Until extraction is trustworthy and observably-incomplete-when-incomplete, ADR-027 cannot be satisfied.

**Decision.**

ADR-065 adds two binding rule blocks to the static-extraction contract.

### Block 1 — Precision filters (CALLS / CONNECTS_TO / CONFIGURED_BY inference)

Five filters. All five apply universally across JS/TS/Python. No per-language opt-out.

1. **Test-scope exclusion.** Files under `**/__tests__/**`, `**/__fixtures__/**`, `**/integration-tests/**`, and files matching `*.spec.{ts,tsx,js,jsx,py}` / `*.test.{ts,tsx,js,jsx,py}` are excluded from outbound CALLS / CONNECTS_TO inference. They remain registered as service-internal nodes (test files belong to their package); only inferred outbound edges from them are filtered. Highest-signal fixture: experiment row 0016.

2. **Comment-body exclusion.** No edge is inferred from a string literal that lies inside a comment token. tree-sitter exposes comment-node boundaries via `comment` / `block_comment` / `line_comment` / `documentation_comment` node types; the producer honours them. Highest-signal fixture: experiment row 0014 (JSDoc `@example` block).

3. **JSX external-link exclusion.** No edge is inferred from a URL string passed as a JSX attribute on an element whose tag matches `/^(a|Link|NavLink|ExternalLink|Anchor)$/`. The pattern is "user-clickable hyperlink to a documentation/marketing site," not "service-to-service call." Applies to `<Link to=...>`, `<a href=...>`, `<NavLink to=...>`, `<ExternalLink href=...>`, `<Anchor href=...>`. Highest-signal fixture: experiment row 0006.

4. **`.env.template` exclusion.** Files matching `.env.template`, `.env.example`, `.env.*.template`, `.env.*.example`, `.env.sample` are documentation artifacts. They are not registered as ConfigNodes and do not produce CONFIGURED_BY edges. ADR-016 binds ConfigNode to file existence at runtime; templates are not runtime. Highest-signal fixtures: experiment rows 0008, 0015.

5. **No URL-substring service matching.** A URL whose hostname is `medusa.cloud` does not match the service `@medusajs/medusa` by substring containment. Cross-service inference from URL strings requires an exact hostname match against a registered ServiceNode alias or InfraNode hostname, not substring containment. The previous heuristic — `if (url.includes(serviceName.slice(after-slash)))` — produces unrelated-package collisions on every common-word service name. Highest-signal fixtures: experiment rows 0001, 0002, 0003, 0012, 0013.

The filters are pre-emit gates inside the producer pass. A filtered candidate edge is never written to the graph — not added-then-retired. This keeps idempotency intact (ADR-032's existing rule) and avoids polluting `errors.ndjson` with successful-but-filtered cases.

### Block 2 — Loud failure mode (per-file extraction errors)

Per-file extraction failures during `neat init` and `neat watch`:

1. **Append to `<projectDir>/neat-out/errors.ndjson`** with shape `{file, error, stack, ts}` per line. Append-only, never rewritten. The `errors.ndjson` artifact already exists for OTel error events per ADR-033; extraction failures route through the same writer with a `source: 'extract'` discriminator so consumers can separate them.

2. **The init / watch summary banner reports an aggregate count** — `[neat] N files skipped due to parse errors`, where N is the count. The banner is unconditional; `0 files skipped due to parse errors` is observable as a positive signal that no quiet skipping happened. The prior behaviour — a single `[neat] <phase> skipped <file>: <message>` warning per file with no aggregate — is replaced.

3. **`NEAT_STRICT_EXTRACTION=1` exits non-zero** on any per-file extraction failure. Useful in CI ("did this commit make extraction worse?"). Unset, the default `neat init` exits 0 even when some files failed — local dev wants forgiving behaviour with a banner.

4. **Catch + log the real underlying stack at the call site, not the generic N-API error.** "Invalid argument" is the Node N-API generic the experiment surfaced; the real cause was an extractor calling a method on a missing tree-sitter field. Per-call-site `try`/`catch` with the parser context captured, not blanket suppression at the phase level.

Silent partial extraction is forbidden. If the producer is incomplete, the snapshot is observably incomplete.

### Block 3 — Regression fixture corpus

`packages/core/test/fixtures/precision/` holds verbatim minimisations of the highest-signal experiment evidence rows:

- `comment-body-jsdoc.ts` — row 0014 (JSDoc `@example` containing `http://localhost:9000`)
- `test-scope-postgres.spec.ts` — row 0016 (postgres URL in a `__tests__/*.spec.ts` file)
- `jsx-external-link.tsx` — row 0006 (`<Link to="https://medusajs.com/changelog/" target="_blank">`)
- `env-template/.env.template` — row 0008 (a templated env file with no runtime semantics)
- `aws-client-raw.ts` — row 0007 (`new S3Client(config)` with no `@aws-sdk/*` import context — covers both the precision side and the kind-classification side fixed in #238)

Each fixture is the smallest reproduction of a row that v0.3.0's extractor produced a false-positive edge for. The contract assertions parameterise over these fixtures: "fixture X should produce no extracted edges of type Y." Adding a new false-positive shape becomes "add a fixture, add an assertion line."

**Why amending ADR-032 and not writing a successor.** ADR-032's existing rules (producer interface, evidence on every edge, ghost-edge cleanup keyed on `evidence.file`, idempotency, language dispatch, per-file parse-failure isolation, owner extraction) are all still load-bearing and correct. This ADR adds precision rules to producer logic and an observability rule to the failure path. Amendment is the lighter touch.

**Enforcement.** New live assertions in `packages/core/test/audits/contracts.test.ts` under the `Static-extraction contract (ADR-032)` describe block:

- One `it()` per filter (five total) — each loads its fixture, runs the producer, asserts no false-positive edge.
- One `it()` asserting `errors.ndjson` lines have the documented shape.
- One `it()` asserting the init banner text contains the skipped-count phrase.
- One `it()` asserting `NEAT_STRICT_EXTRACTION=1` flips the exit code.

The assertions land as `it.todo` in this PR (Phase 3A — contract only) and flip live in the Phase 3B implementation PRs (#237, #238, #239). v0.3.3 closes when all flip live and the medusa re-run drops divergence count by ≥ 95%.

**Not in scope.**

- **Per-language opt-out for the filters.** The five rules are universal across JS/TS/Python. A future contract may carve language-specific exceptions if a real signal demands one; not earned now.
- **Test framework detection.** "Files under `__tests__/`" is the contract surface. Sniffing for `describe`/`it` blocks or jest config to widen the test-scope is out — the file-path glob is observable and good enough.
- **A `.gitignore`-style precision-filter file in the project.** Considered (let each project define its own filters). Rejected — filters are NEAT's correctness model, not a per-project preference. If a real project surfaces a needed carve-out, that's a successor ADR with concrete evidence.
- **Tree-sitter upgrade or grammar swap to fix the "Invalid argument" cause.** The loud failure mode surfaces the failures; the underlying parser fix lives in the implementation PR (#239) and may end up as an upstream issue against `tree-sitter-typescript` if the cause is in the grammar.

Full rationale and the v0.3.0 failure-mode evidence: `~/neat-experiment/bugs/NEAT-BUG-4-ghost-edges-from-strings.md`, `~/neat-experiment/bugs/NEAT-BUG-6-http-extraction-invalid-argument.md`, `~/neat-experiment/bugs/INDEX.md`.

## ADR-066 — OBSERVED-led divergence query weighting + graded confidence

**Date:** 2026-05-15
**Status:** Active. Amends ADR-029 (provenance confidence semantics), ADR-060 (divergence query weighting). Extends ADR-065's precision filters with a confidence-based emit floor on top of the same producer surface.

**Context.** The thesis surface (`get_divergences`, ADR-060) treats all five divergence types as symmetric peers, and it operates on edges that all carry the same coarse confidence — flat `0.5` on every EXTRACTED edge, flat `1.0` on every OBSERVED edge. The original provenance ranking — `OBSERVED > EXTRACTED > INFERRED > STALE` — treats EXTRACTED as a high-trust direct signal when its claims are structurally derived (file existence, package.json deps, AST imports, Dockerfile facts). A single coarse `0.5` for every EXTRACTED edge conflates structural emissions with heuristic ones (URL-string pattern matches), and a single `1.0` for every OBSERVED edge treats a single span as evidence equivalent to a thousand recent ones. Grading confidence within each provenance tier restores honest signal so the divergence query can lead with findings that warrant action.

The ADR formalises three pieces:

1. EXTRACTED is graded at emit time per extractor.
2. OBSERVED is graded by signal block.
3. The divergence query consumes the graded values and surfaces OBSERVED-led findings first.

PROV_RANK stays as it is. The grading lives within tiers, not across them.

**Decision.**

### 1. EXTRACTED confidence is graded at emit time

Every producer under `packages/core/src/extract/` emits a `confidence` value reflecting how the edge was derived. The grading helper lives in `@neat.is/types/confidence.ts` so producers and tests share one source of truth.

| Source of the EXTRACTED edge | Confidence |
|---|---|
| Structural file fact (import, package.json dep, Dockerfile `RUNS_ON`, ConfigNode existence per ADR-016) | `0.85` |
| Verified call site (framework-aware recognizer matched the call expression) | `0.85` |
| String-shaped candidate with structural support (URL near a known call expression) | `0.5` |
| String-shaped candidate without structural support (substring or hostname-shape alone) | `0.2` |

ADR-065's five precision filters still gate emission upstream of this scale; what passes the filters is then graded here.

### 2. OBSERVED confidence is graded by signal block

`upsertObservedEdge` in `packages/core/src/ingest.ts` writes confidence at the same point it writes the `signal` block (`spanCount`, `errorCount`, `lastObservedAgeMs`). The grading shape:

- `spanCount >= 100` and `lastObservedAgeMs < 1h` → `0.95–1.0` (strong)
- `spanCount 10–99` and `lastObservedAgeMs < 1h` → `0.7–0.9` (good)
- `spanCount < 10` and `lastObservedAgeMs < 1h` → `0.4–0.6` (weak — a single span could be a misconfig)
- `errorCount / spanCount > 0` subtracts up to `0.2` (degraded edge)

The exact piecewise function lives in the confidence helper; the ADR sets the buckets and the direction (more volume + more recent = higher confidence; more errors = lower). PROV_RANK is preserved — OBSERVED still outranks INFERRED + EXTRACTED for traversal preference. The grading sits within the OBSERVED tier.

### 3. Precision floor on EXTRACTED at emit time

EXTRACTED edges with `confidence` below `NEAT_EXTRACTED_PRECISION_FLOOR` (default `0.7`) are computed but never added to the graph. The check sits at the single producer chokepoint that hands edges to the graph — sub-threshold candidates increment a counter that surfaces on the extraction banner (`[neat] M extracted edges dropped below precision floor`). Optional logging to `<projectDir>/neat-out/rejected.ndjson` activates when `NEAT_EXTRACTED_REJECTED_LOG=1`; the default keeps the rejected sidecar quiet.

Today's URL/hostname-shape matchers produce mostly `0.2` candidates — the floor means almost nothing crosses into the graph for cross-service EXTRACTED until framework-aware recognizers land in a later milestone. Intra-codebase structural edges keep flowing because they grade above the floor. That is the intended outcome; 10 trustworthy edges beats 20 edges with 10 lies in them.

`NEAT_EXTRACTED_PRECISION_FLOOR=0.0` flips off the floor for diagnostics — useful when reproducing a missing edge.

### 4. Divergence query reweighting

`computeDivergences` (`packages/core/src/divergences.ts`) reweights against the graded values:

- **`missing-extracted`** (OBSERVED found something EXTRACTED missed) is the headline finding type. Its confidence cascades from the underlying OBSERVED edge's graded confidence. When OBSERVED is graded high, the divergence surfaces high.
- **`missing-observed`** (EXTRACTED claims an edge OBSERVED never confirmed) is weighted by the EXTRACTED edge's confidence grade. Substring-match-only EXTRACTED candidates never enter the graph in the first place (rule 3 above), so the only `missing-observed` rows that surface are backed by structural or verified-call-site facts.
- **`version-mismatch` / `host-mismatch` / `compat-violation`** retain symmetric weighting — both sides are specific about a versioned or hostname-identified entity, and definitive compat rules fire at `1.0`.

Default sort order remains `confidence` descending (ADR-060 §5). Within the same confidence, `missing-extracted` ties break ahead of `missing-observed` so the OBSERVED-led finding leads when grades are otherwise equal. Callers can re-sort.

The existing `?minConfidence` query parameter is unchanged. The reweighting does not introduce a hidden default floor; consumers that want one apply it via the existing parameter.

### 5. Edge schema

`EdgeSchema.confidence` in `packages/types/src/edges.ts` stays at `z.number().min(0).max(1).optional()` for snapshot back-compat (older snapshots may carry edges without a `confidence` field; persist.ts loads them on the documented growth path per ADR-031). Producers going forward write `confidence` on every EXTRACTED and OBSERVED edge; the contract test enforces presence.

### 6. Response envelope

ADR-061's envelope rule applies to `/graph/divergences` as a structured-result endpoint (ADR-061 §2 b). The documented shape — `{ divergences, totalAffected, computedAt }` — is the only valid response on snapshot-load, zero-result, and live-state. No `null`, no bare values. The contract scan extends to assert this shape for the divergence endpoint at both mount points (default + project-scoped).

**Authority.**

- Schema + grading helpers: `packages/types/src/confidence.ts` (new), `packages/types/src/edges.ts`.
- EXTRACTED grading at emit: `packages/core/src/extract/services.ts`, `packages/core/src/extract/configs.ts`, `packages/core/src/extract/infra/*.ts`, `packages/core/src/extract/calls/*.ts`.
- Precision floor: `packages/core/src/ingest.ts` (or the producer-side emit helper feeding it; the chokepoint is wherever EXTRACTED edges land in the graph).
- OBSERVED grading: `packages/core/src/ingest.ts` (`upsertObservedEdge`).
- Reweighting: `packages/core/src/divergences.ts`.

**Enforcement.** New describe block in `packages/core/test/audits/contracts.test.ts` for ADR-066. Initial `it.todo` entries flip live as the v0.3.4 implementation lands:

- EXTRACTED edges in the live graph carry confidence per the grading helper; the flat-`0.5` emission pattern is forbidden (regex scan of `packages/core/src/extract/` for `confidence: 0.5` literals).
- OBSERVED edges grade by signal block — an edge with `spanCount: 5` grades below an otherwise-identical edge with `spanCount: 500`; an edge with `errorCount: 4, spanCount: 5` grades below `errorCount: 0, spanCount: 5`.
- The precision floor drops sub-threshold EXTRACTED candidates at emit; a fixture with both above- and below-threshold candidate edges produces only above-threshold edges in the graph.
- `computeDivergences` returns rows with `missing-extracted` leading `missing-observed` when both types are present at comparable confidence.
- `/graph/divergences` returns the `DivergenceResultSchema` shape on snapshot-load, zero-result, and live-state paths at both mount points — never `null`, never a bare value.

**Out of scope.**

- **Framework-aware call-site recognition.** Today's grading treats every cross-service URL-string match as a `0.2` candidate; the precision floor means most cross-service EXTRACTED disappears until per-framework recognizers land in a later milestone. That is the intended outcome.
- **PROV_RANK ordering.** ADR-066 grades within tiers; the rank stays `OBSERVED > INFERRED > EXTRACTED > STALE | FRONTIER`.
- **Persisted divergence history.** ADR-060 §2 stands — derived, not persisted. ADR-066 changes how confidence is graded; it does not add a sidecar.
- **Confidence-grade enum in `@neat.is/types`.** Free-float `[0, 1]` confidence is enough for the divergence query to reweight against. Whether the grading buckets earn a typed enum is a later question once the v0.3.4 medusa re-run produces signal.

**First application.** v0.3.4.

## ADR-068 — FrontierNode is a node state; provenance and node-type are orthogonal

**Date:** 2026-05-16
**Status:** Active. Amends ADR-023 (FrontierNode semantics), ADR-029 (edge identity + provenance ranking), ADR-035 (FrontierNode promotion). Sharpens the distinction between FrontierNode-the-node-type and the act of observing traffic to that node.

**Context.** A FrontierNode (ADR-023) represents an OTel peer that has not yet matched a known service — host:port shows up in a span, NEAT creates a placeholder, the next static-extraction round promotes the placeholder to a typed node once an alias resolves. The act of *seeing* the span is direct observation: the call happened, the timestamp is real, the count is real. The peer being unresolved is a separate fact about the target node, not about how the edge was learned.

The divergence query (`get_divergences`, ADR-060 / ADR-066), the OBSERVED-led product orientation, and the source-attributed OBSERVED work all rely on traffic to any peer — resolved or not — carrying OBSERVED provenance with the signal block populated. The thesis surface reads strongest when every span produces an OBSERVED edge: an OBSERVED layer that spans both resolved and unresolved peers is the substrate the divergence query is meant to weight against. ADR-068 reaffirms ADR-023's distinction: FRONTIER is a property of the *node*, not of the *edge*.

**Decision.**

### 1. Provenance and node-type are orthogonal

`Provenance` enumerates four values — `OBSERVED | INFERRED | EXTRACTED | STALE`. FRONTIER is no longer a provenance value; it is a `NodeType` value (FrontierNode), and FrontierNode remains the placeholder for unresolved span peers exactly as ADR-023 specifies.

Edges to FrontierNodes carry whatever provenance describes how the edge was learned: spans produce OBSERVED edges with FrontierNode targets, the trace stitcher produces INFERRED edges with FrontierNode targets where applicable, static analysis never targets FrontierNodes because static analysis can't see them. The target's node-type is independent of the edge's provenance.

### 2. Edge id wire format collapses to four variants

`@neat.is/types/identity.ts` exports `extractedEdgeId`, `observedEdgeId`, `inferredEdgeId`, and `parseEdgeId`. The `frontierEdgeId` helper retires; edges to FrontierNodes use `observedEdgeId(source, frontierId('peer'), type)` and produce the wire format `${type}:OBSERVED:${source}->frontier:${peer}`. The provenance segment in the id reflects how the edge was learned; the `frontier:` prefix on the target string already identifies the node type.

`parseEdgeId` returns one of the four provenance values. `PROV_RANK` lists four entries — `OBSERVED: 3, INFERRED: 2, EXTRACTED: 1, STALE: 0` — matching the enum.

### 3. Schema growth: SCHEMA_VERSION bumps 2 → 3

`packages/core/src/persist.ts` carries a v2 → v3 migration. Snapshots saved under v0.3.4 or earlier may contain edges with `provenance: 'FRONTIER'`; on load, those edges are rewritten to `provenance: 'OBSERVED'` and (if their id still carries the legacy `:FRONTIER:` segment) re-keyed to the OBSERVED wire format. Target refs are unchanged — the FrontierNode is still pointed to. The migration is one-way; v0.3.5+ never writes FRONTIER-provenance edges.

This is a shape change per ADR-031: the persistence format changes, an ADR documents it, `persist.ts` carries the migration, the schema-snapshot guard records the new SCHEMA_VERSION.

### 4. FrontierNode promotion preserves edge provenance

`promoteFrontierNodes` / `rewireFrontierEdges` / `rebuildEdge` in `packages/core/src/ingest.ts` rewrite the target ref from `frontier:peer` to the matched typed-node id and keep provenance as it was. An OBSERVED edge stays OBSERVED across promotion; an INFERRED edge stays INFERRED. The id changes because one endpoint changed, and the canonical helper for the existing provenance computes the new id (`observedEdgeId(source, newTarget, type)` for an OBSERVED edge, etc.). Edges land at their final provenance at creation; promotion is a target-rewrite operation.

### 5. Traversal continues to treat FrontierNodes as terminal

Contracts.md Rule 3 ("FRONTIER edges are not traversed") restates as: traversal walks edges by provenance but does not enter FrontierNodes. The terminal property attaches to the *node*, not the edge — `getRootCause` and `getBlastRadius` consult node type at every step and stop when they reach a FrontierNode. OBSERVED edges with FrontierNode targets are still counted in divergence queries (the OBSERVED layer is no longer empty) but traversal does not descend past the FrontierNode.

### 6. Signal block and graded confidence flow uniformly

OBSERVED edges to FrontierNodes go through the same `upsertObservedEdge` path as OBSERVED edges to typed nodes. The `signal` block (`spanCount`, `errorCount`, `lastObservedAgeMs`) and the ADR-066 graded confidence are populated identically. The OBSERVED layer's confidence story is uniform regardless of target resolution status.

**Authority.**

- Provenance enum and helpers: `packages/types/src/constants.ts`, `packages/types/src/identity.ts`, `packages/types/src/edges.ts`.
- Schema migration: `packages/core/src/persist.ts`.
- Ingest swap and rebuild: `packages/core/src/ingest.ts`.
- Contracts: `docs/contracts/provenance.md`, `docs/contracts/frontier-promotion.md`, `docs/contracts/otel-ingest.md`.

**Enforcement.** New describe block in `packages/core/test/audits/contracts.test.ts` for ADR-068. Initial `it.todo` entries flip live as the v0.3.5 implementation lands:

- `Provenance` enum has exactly four values (`OBSERVED`, `INFERRED`, `EXTRACTED`, `STALE`); `ProvenanceSchema.options` matches.
- `PROV_RANK` has exactly four entries and ordering stays `OBSERVED > INFERRED > EXTRACTED > STALE`.
- No source file under `packages/core/src/`, `packages/mcp/src/`, or `packages/types/src/` references `Provenance.FRONTIER` or the `frontierEdgeId` helper.
- `parseEdgeId` round-trips OBSERVED edges with FrontierNode targets (`observedEdgeId(source, frontierId(host), type)`).
- An OTLP span to an unresolved peer produces a single OBSERVED edge with a FrontierNode target, signal block populated, graded confidence.
- A v2 snapshot containing an edge with `provenance: 'FRONTIER'` loads as v3 with that edge rewritten to OBSERVED, target ref preserved.
- `promoteFrontierNodes` rewires target refs without changing edge provenance — an OBSERVED edge to a FrontierNode stays OBSERVED after promotion to a typed node, and its id moves from `${type}:OBSERVED:${source}->frontier:peer` to `${type}:OBSERVED:${source}->${typedTarget}`.

**Out of scope.**

- **FrontierNode-target divergence semantics.** `get_divergences` already filters `missing-observed` rows whose target is a FrontierNode (per the divergence-query contract). ADR-068 unblocks OBSERVED edges with FrontierNode targets but does not change which rows surface in the divergence query.
- **External-host alias registry.** B9 in the plan file proposes auto-aliasing common SaaS hosts (`api.github.com → GitHub`, etc.) to reduce FrontierNode noise in the graph view. That work lives in a later milestone; ADR-068 makes those FrontierNodes useful — OBSERVED-grade — without renaming them.
- **Stitcher behaviour for FrontierNode targets.** The trace stitcher (ADR-034) walks EXTRACTED edges only. Whether INFERRED edges should ever be created with FrontierNode targets is a separate question; current behaviour holds — INFERRED edges target typed nodes only.

**First application.** v0.3.5.

---

## ADR-069 — `neat init --apply` produces executable changes

**Date:** 2026-05-17
**Status:** Active. Amends ADR-047 (SDK install contract).

The SDK installer surface matures to the next layer: `neat init --apply` now writes the SDK setup file, injects the require/import into each service's entry point, configures per-service naming, and lands the dependency additions atomically. ADR-047's plan/apply split and the lockfile-immutability rule stand unchanged.

**Context.** ADR-047 §2 codified the patch shape (dependency edits, entrypoint edits, env edits) for the Node and Python installers. The Node installer at v0.2.5 expressed the entrypoint edit through `scripts.start` and routed env vars through "set in your orchestration layer" — the right level of intervention for the single-service shape that drove the v0.2.5 acceptance fixtures. Real-world monorepos (medusa is the first one NEAT points at end-to-end) want per-package instrumentation: a generated SDK setup file alongside each service's entry, the require/import injected at the entry's first line, and the service name resolved per workspace package without depending on an orchestration layer to fan out env vars. ADR-069 extends the apply surface to write those artifacts directly so `neat init --apply` reaches the threshold where it's the install command, not a list of recommended next steps.

**Decision.**

1. **Generated SDK setup file.** The Node installer writes `otel-init.{js,ts}` adjacent to each service's resolved entry point. The file imports `@opentelemetry/auto-instrumentations-node/register` (the auto-instrumentation hook), loads `.env.neat` via `dotenv`, and emits a short comment block documenting how to configure via env vars. ESM variant uses `import …`; CJS variant uses `require(…)`. The TS variant uses `import` and is emitted when the entry is `.ts`/`.tsx`.

2. **Entry-point detection.** Resolution order: `pkg.main` → `pkg.bin[<name>]` (when `bin` is a string, use that path; when `bin` is a map, use the entry keyed on `pkg.name`) → `index.{ts,tsx,js,mjs,cjs}` heuristic in the package root. Packages with no resolvable entry are lib-only and skipped — the apply summary records each skip with reason `lib-only` so the user can see what was untouched and why.

3. **Entry-point injection.** The installer reads the resolved entry, preserves the shebang on line 1 if present, and inserts the init line as the first non-shebang line. For ESM (when `pkg.type === 'module'` or the entry extension is `.mjs`/`.ts`/`.tsx`), the inserted line is `import './otel-init.js'` (or the `.ts` extensionless form when the entry is TS). For CJS, the inserted line is `require('./otel-init.js')`. The relative path is computed against the entry's directory so the injection works regardless of the entry's depth inside the package.

4. **Per-service `OTEL_SERVICE_NAME`.** The installer writes `<package-dir>/.env.neat` containing `OTEL_SERVICE_NAME=<pkg.name>` (and `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`). Scoped names (`@medusajs/auth`) are preserved verbatim — the scope matches the EXTRACTED ServiceNode id format (ADR-028 + extract/services.ts), so dashboards joining OBSERVED spans against the graph use the same key on both sides. NEAT does not strip scopes. The generated SDK setup file loads `.env.neat` so the service name is in scope before the auto-instrumentation hook runs.

5. **Fourth dependency.** The Node installer's dependency list grows to four packages: `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, and `dotenv`. The first three are unchanged from ADR-047 §2. `dotenv` is added so the generated `otel-init` can read `.env.neat` without bundling a parser.

6. **Idempotency.** Re-running `--apply` on an already-instrumented package is a no-op for every file-write path:
   - If `otel-init.{js,ts}` already exists adjacent to the entry, the installer logs `already instrumented` for that package and skips the file write **and** the entry-point injection (treats the package as instrumented end-to-end).
   - If the entry's first non-shebang line already matches the injection pattern (`import './otel-init…'` or `require('./otel-init…')`), the installer skips the entry-point injection independently.
   - `.env.neat` is preserved when it already exists; the installer never overwrites a user-edited file. New `.env.neat` writes always include `OTEL_SERVICE_NAME` and `OTEL_EXPORTER_OTLP_ENDPOINT` for the package.
   - Manifest dep insertion is no-op when the dep is already present at any version (no version bumping; ADR-047 §5 stands).

7. **Lockfiles never touched.** ADR-047 §4 holds. The set of paths the apply phase is permitted to write is restricted to `<package-dir>/package.json`, `<package-dir>/otel-init.{js,ts}`, and `<package-dir>/.env.neat`. Any other write from an installer module is a contract violation.

8. **Dry-run output.** `neat init --dry-run` produces a concrete per-package summary: every file path that would be written, the exact lines that would land in each file, and the lib-only-skip list. The patch text is reviewable byte-for-byte (ADR-047 §6 stands) and describes the same set of writes the apply phase would land. The previous bullet-list summary is the v0.2.5 surface; v0.3.6 replaces it with a diff-shaped emission so the user can review before `--apply`.

9. **Apply summary.** The Node installer's apply phase returns a structured summary (instrumented, skipped-already, skipped-lib-only) per package. The CLI logs the counts at the end of `neat init --apply` so the user sees coverage at a glance: e.g. `instrumented 42, already-instrumented 3, lib-only 17`. The structured shape lives in `installers/shared.ts` so successor language installers can return the same.

**Authority.** `packages/core/src/installers/javascript.ts` (the load-bearing edits). Generated-file templates live alongside as `installers/templates/otel-init.{cjs,esm,ts}.template` (or equivalent inline constants — the choice is implementation, not contract). The four-deps list, the entry-detection heuristic, and the injection pattern are codified in `contracts.test.ts` so regressions fail the audit.

**Enforcement.** New `it.todo` entries under the existing `describe('SDK install contract (ADR-047)')` block, plus a new `describe('SDK install — apply-side (ADR-069)')` block that covers:

- entry-point resolution order (`main` → `bin` → `index.*`),
- ESM-vs-CJS dispatch on `pkg.type` and entry extension,
- TS-vs-JS dispatch on entry extension,
- generated `otel-init` file presence + content shape (auto-instrumentation hook, dotenv load),
- entry-point first-non-shebang-line injection (with shebang preservation),
- `.env.neat` write with `OTEL_SERVICE_NAME=<pkg.name>` (scope-preserved),
- four-deps invariant (`@opentelemetry/api`, `sdk-node`, `auto-instrumentations-node`, `dotenv`),
- idempotency on a second `--apply` against an already-instrumented fixture,
- lib-only-no-entry packages skipped cleanly,
- the path-set restriction (apply writes only `package.json`, `otel-init.{js,ts}`, `.env.neat`),
- dry-run output names the same file paths the apply phase would write.

`it.todo` entries flip live as v0.3.6 lands.

**Out of scope.**

- **Python installer apply surface upgrade.** ADR-069 governs the Node installer. The Python installer keeps its v0.2.5 shape (requirements.txt append + Procfile prefix) for now; a successor ADR addresses the equivalent generated-file + entry-injection pattern for Python once the Node surface is in production.
- **`npm install` execution.** ADR-046 + ADR-047 stand: NEAT prints the `npm install` reminder; the user owns the lockfile commit.
- **Cross-package hoisted node_modules.** The installer treats each workspace package independently. Whether the host repo hoists `dotenv` / `@opentelemetry/*` at the root is the user's lockfile decision. The contract is per-package manifest correctness.
- **TypeScript build pipeline integration.** Generated `otel-init.ts` files compile through whatever TS pipeline the host package already uses. NEAT does not adjust `tsconfig.json` or `tsup`/`tsc` invocations.

**First application.** v0.3.6.

---

## ADR-070 — `neat init --apply` entry detection covers src/ layouts and script-driven entries

**Date:** 2026-05-17
**Status:** Active. Amends ADR-069 §2 (Node entry-point detection).

The next maturity layer of the SDK installer's entry-resolution heuristic. ADR-069 §2 codified `main` → `bin` → `index.*` at the package root, which matches single-file npm publishables. Real-world Node services — Express apps, ts-node and tsx-driven entrypoints, NestJS, Next-style API workspaces, internal monorepo packages — overwhelmingly keep their entry under `src/` and announce it via `scripts.start` or `scripts.dev` rather than `main`. ADR-070 extends the heuristic so `--apply` lands on those packages instead of skipping them as lib-only.

**Context.** ADR-069 §2's three-step heuristic was sized for the v0.2.5 acceptance fixtures (single-package services with a real `main`). The first real-world target — brief-api, a hand-instrumented Express + ts-node service with `"start": "ts-node src/index.ts"` and no `main` — falls through every step of the heuristic to `lib-only`. Medusa packages share the same shape. The fix is to teach the heuristic the two patterns the ecosystem actually uses: entries declared through `scripts.start`/`scripts.dev` and entries living under `src/`.

**Decision.**

1. **Resolution order extended.** The Node installer resolves a service's entry point in this order:

   1. `pkg.main` — when present **and the file exists on disk**. A `main` that points at a missing `dist/index.js` (pre-build) falls through to the next step instead of marking the package lib-only.
   2. `pkg.bin[<pkg.name>]` (string form) or the entry keyed on `pkg.name` (map form), when the resolved path exists.
   3. **Entry parsed from `pkg.scripts.start`.** Tokenize the script and extract the first argument that names a JS/TS file relative to the package root (e.g. `node dist/index.js` → `dist/index.js`; `ts-node src/index.ts` → `src/index.ts`; `tsx src/server.ts` → `src/server.ts`). Resolved when the path exists.
   4. **Entry parsed from `pkg.scripts.dev`.** Same tokenisation. Captures `tsx watch src/index.ts`, `ts-node-dev src/server.ts`, and the common Express-with-nodemon shape.
   5. **`src/index.{ts,tsx,js,mjs,cjs}` heuristic** — first match, in that extension order.
   6. **`src/server.{ts,tsx,js,mjs,cjs}` / `src/main.{ts,tsx,js,mjs,cjs}` / `src/app.{ts,tsx,js,mjs,cjs}`** — same extension order, each pattern probed in turn. These three names cover ~90% of conventional Node web services in the wild.
   7. `index.{ts,tsx,js,mjs,cjs}` at the package root (the original ADR-069 §3 fallback).

   No match across all seven steps → lib-only.

2. **Script tokeniser.** The parser is intentionally simple. Tokenise on whitespace, walk through the tokens left-to-right, ignore tokens that look like flags (start with `-`) or recognised launchers (`node`, `ts-node`, `tsx`, `ts-node-dev`, `nodemon`, `npx`, `pnpm`, `yarn`, `npm`, `cross-env`, `dotenv`, `--`), and return the first token that looks like a file path within the package root (relative path, contains `/` or ends in a JS/TS extension). Env-var assignments (`FOO=bar`) are also skipped. Pipes, shell substitution, and chained commands (`&&`, `||`, `;`) are out of scope — the tokeniser bails out and returns null, falling through to the next heuristic step.

3. **Lockfiles still never touched.** ADR-047 §4 + ADR-069 §7 hold. The path-set restriction (apply may write only `package.json`, `otel-init.{js,ts,mjs,cjs}`, `.env.neat`) is unchanged.

4. **Lib-only outcome stays explicit.** Packages with no entry resolvable through any of the seven steps continue to emit `lib-only` with reason `no resolvable entry point`. The apply summary's `lib-only` count remains meaningful — it now reflects genuine library packages rather than mis-configured service packages.

5. **Idempotency invariant unchanged.** All seven entry-resolution steps converge on a single entry path. The idempotency check (ADR-069 §6) reads the resolved entry and skips when the first non-shebang line already matches the injection pattern, regardless of which heuristic step produced the entry.

**Authority.** `packages/core/src/installers/javascript.ts` — extends `resolveEntry`. Tokeniser lives alongside as a private helper.

**Enforcement.** New `it`s under the existing `describe('SDK install — apply-side (ADR-069)')` block:

- `main` points at missing `dist/...` → falls through to script-derived or src/-derived entry rather than lib-only;
- `scripts.start = "node dist/server.js"` resolves to `dist/server.js`;
- `scripts.start = "ts-node src/index.ts"` resolves to `src/index.ts`;
- `scripts.dev = "tsx watch src/server.ts"` resolves to `src/server.ts`;
- `src/index.ts` present → resolved when nothing else fires;
- `src/server.ts`, `src/main.ts`, `src/app.ts` each resolved when present;
- script with chained shell (`a && b`) → bails out cleanly, falls through to the next step;
- entry resolution is deterministic across runs and matches the order above.

**Out of scope.**

- **Monorepo root-level dispatch.** Each workspace package is resolved independently. Whether the root `package.json` declares `workspaces` is the user's lockfile decision.
- **Custom dispatchers.** Frameworks that boot through a TS-aware loader the tokeniser doesn't know about (e.g. SWC-Node bespoke entrypoints) are accepted as a known gap — a successor ADR adds the loader name to the launcher allowlist when one surfaces.
- **`pkg.exports` parsing.** ADR-069 §2 didn't read `exports`; ADR-070 doesn't either. Service packages publish their entry through `main`/`scripts`, not `exports`.

**First application.** v0.3.6.

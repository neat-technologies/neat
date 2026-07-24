---
name: static-extraction
description: Producers under packages/core/src/extract/* read source code and config to build the EXTRACTED layer. Every edge carries evidence.file. Ghost-edge cleanup keys on it. Producers are idempotent and pre-emit gate against five precision filters. Per-file failures route to errors.ndjson with a loud aggregate banner.
governs:
  - "packages/core/src/extract/**"
  - "packages/core/src/watch.ts"
adr: [ADR-032, ADR-065, ADR-115, ADR-119, ADR-123, ADR-030, ADR-031, ADR-024, ADR-055, ADR-133, ADR-138]
enforcement: [lint, review]
---

# Static-extraction contract

The first producer-layer contract. `packages/core/src/extract/**` reads source code and config files to build the EXTRACTED layer of the graph. Mutation authority for static creation is locked here per the lifecycle contract (ADR-030).

## Producer interface

Every producer module exports a single async function with the signature:

```ts
async function addX(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
): Promise<{ nodesAdded?: number; edgesAdded?: number }>
```

Producers are pure with respect to graph state outside their own writes. They:

- read from the filesystem within `scanPath` and each service's `dir`,
- write nodes and edges via `graph.addNode` / `graph.addEdgeWithKey`,
- guard every write with `graph.hasNode(id)` / `graph.hasEdge(id)` for idempotency,
- never read the OBSERVED layer,
- never trigger REST or MCP,
- never call `compat.json` outside `compat.ts`.

## Evidence on EXTRACTED edges (binding)

Every EXTRACTED edge carries an `evidence` field:

```ts
evidence: {
  file: string         // path relative to scanPath, forward slashes
  line?: number        // 1-indexed
  snippet?: string     // small source fragment, max ~120 chars
}
```

`file` is required. `line` and `snippet` are optional but strongly preferred when the producer can compute them cheaply.

Today the CALLS-family producers (`calls/http.ts`, `calls/aws.ts`, `calls/kafka.ts`, `calls/grpc.ts`, `calls/redis.ts`) carry evidence. CONNECTS_TO, CONFIGURED_BY, DEPENDS_ON, and RUNS_ON producers do not. Issue #140 closes that gap.

## Ghost-edge cleanup

When a file changes or disappears between extract passes, every EXTRACTED edge whose `evidence.file` matches that path is **dropped before the producer reruns**. Re-extraction recreates the edges that still apply; the deleted code's edges stay deleted.

`watch.ts` owns the cleanup trigger per ADR-030's mutation authority. The order is:

1. `classifyChange` decides which producer phases the changed file belongs to.
2. For each phase, `watch.ts` calls a `retireEdgesByFile(graph, file)` step that drops every edge in that phase whose `evidence.file` matches.
3. The producer reruns. Idempotent writes recreate surviving edges.

This is the v0.1.x bug closed by issue #140. Without it, watch-driven re-extraction accumulates stale EXTRACTED edges indefinitely.

## Idempotency

Every producer is idempotent. Running the same producer twice on the same input produces the same graph state. `graph.hasNode(id)` and `graph.hasEdge(id)` guards already enforce this; the contract reaffirms it.

Idempotency is what makes ghost-edge cleanup safe — the path-keyed retire step plus re-extraction always converges on the source's current state, regardless of how many times either fires.

## Language dispatch

Source-file parsing routes by file extension:

| Extension                                | Grammar                          |
|------------------------------------------|----------------------------------|
| `.js` `.jsx` `.mjs` `.cjs` `.ts` `.tsx`  | `tree-sitter-javascript`         |
| `.py`                                    | `tree-sitter-python`             |

`tree-sitter-typescript` is installed but currently unused — `.ts` / `.tsx` fall through to the JS parser. Replacing the JS fallback with the dedicated TS grammar is a future improvement, not in scope for this contract.

Other extensions are skipped silently by `walkSourceFiles` per `IGNORED_DIRS` and `SERVICE_FILE_EXTENSIONS` in `extract/shared.ts`. New language support requires a grammar import and an extension entry in one place.

## Discovery policy

- Recursive directory walk from `scanPath`, bounded by `NEAT_SCAN_DEPTH` (default 5, configurable via env).
- `.gitignore` honored.
- `IGNORED_DIRS` skip set: `node_modules`, `.git`, `.turbo`, `dist`, `build`, `.next`. (`__pycache__` and `vendor` are pending — see open-questions list in `docs/audits/verification.md`.)
- `package.json#workspaces` triggers monorepo expansion. `pnpm-workspace.yaml` and `turbo.json` are not yet read (deferred).

## Producers in scope

| Module               | Produces                                       | Evidence today |
|----------------------|------------------------------------------------|----------------|
| `services.ts`        | ServiceNode (npm + Python)                     | n/a (nodes)    |
| `aliases.ts`         | host:port aliases on existing ServiceNodes     | n/a            |
| `databases/*`        | DatabaseNode + CONNECTS_TO                     | ❌ — #140      |
| `configs.ts`         | ConfigNode + CONFIGURED_BY                     | ❌ — #140      |
| `calls/{aws,grpc,http,kafka,redis,supabase,mongoose}.ts` | CALLS / PUBLISHES_TO / CONSUMES_FROM | ✅          |
| `routes.ts`          | RouteNode + `service ──CONTAINS──▶ route` (ADR-119) | ✅         |
| `calls/route-match.ts` | client `file ──CALLS──▶ route` cross-service match (ADR-119) | ✅ |
| `proto.ts`           | GrpcMethodNode + `service ──CONTAINS──▶ method` from `.proto` (ADR-123) | ✅ |
| `infra/{docker-compose,dockerfile,k8s,terraform}.ts` | InfraNode + DEPENDS_ON / RUNS_ON / CONNECTS_TO | ✅ (evidence populated) |
| `infra/cloudflare.ts` | `platform` tag on ServiceNode/FileNode + InfraNode + DEPENDS_ON / RUNS_ON / CONNECTS_TO (ADR-133) | ✅ |
| `infra/{vercel,railway,supabase}.ts` | `platform` tag on ServiceNode (+ `platformName`) + InfraNode + DEPENDS_ON / RUNS_ON / CONNECTS_TO (ADR-138) | ✅ |

New producers under `calls/` for source-level DB connections (`new pg.Pool(...)`) and inter-service imports land under issue #141. They follow the same interface, same evidence shape, same idempotency.

`calls/mongoose.ts` (ADR-147, #832) is the collection-grained analog of `calls/supabase.ts`. Gated on a `mongoose` or `mongodb` import, it names the collection a file reads or writes: the native-driver literal path (`db.collection('orders')`, collection = the string argument) and the Mongoose model path (`mongoose.model('Order', schema)` → `orders`, deriving the name with Mongoose's own pluralization rules **verbatim** so it matches the collection Mongoose actually created — `Goose`→`gooses`, not `geese`; that fidelity is the fusion key the Atlas connector's observed edges land on). It emits a file-grained `mongodb-collection:<name>` edge at `verified-call-site` confidence when the collection resolves in-file, and falls back to `mongodb-model:<Model>` (lower confidence) when the model is known but the collection is defined cross-file or computed at runtime — never a fabricated name. Cross-file model→collection resolution (ADR-149) is handled by a whole-program pass, `mongooseCrossFileEndpoints`, that runs once per service after the per-file scan: it builds a model registry, resolves each query file's imported bindings to their defining file through the same resolver `imports.ts` uses (`resolveJsImport`), and names the collection at the *query* site — so `routes/orders.js` calling `Order.find()` on a model defined in `models/Order.js` is attributed, not just the definition file. Bare-alias (`baseUrl`) imports and barrel *re-export* chains are the remaining edges; a binding whose model name or collection is computed stays unattributed rather than guessed.

`calls/sqlalchemy.ts` (ADR-151, ADR-152) is the SQL analog for Python. Gated on a `sqlalchemy` / `flask_sqlalchemy` import, it names the table a model maps to by reading the `.py` AST (`tree-sitter-python`): an explicit `__tablename__ = 'orders'` (plain declarative), a Flask-SQLAlchemy model whose table is derived from the class name via `camel_to_snake_case` reproduced **verbatim** (`UserProfile` → `user_profile`, `OAuth2Token` → `o_auth2_token` — the fusion key the OBSERVED side lands on), or a native `Table('orders', …)` literal. It emits a file-grained `infra:sql-table:<name>` edge at `verified-call-site` confidence; a computed `__tablename__` or a cross-file model stays unattributed rather than guessed. The table node is engine-agnostic — the engine lives on the `database:<host>` node one layer up (ADR-141). The OBSERVED twin recovers the table by parsing `db.statement` (ADR-152), since the SQLAlchemy instrumentation emits no table attribute. Django's `<app_label>_<model>` derivation and cross-file model→table query attribution are later rungs.

## `framework` on ServiceNode

Issue #142 adds `framework?: string` to `ServiceNodeSchema`. This is **schema growth** governed by ADR-031, not a new field on this contract. The producer (`extract/services.ts`) populates it from `dependencies` and `devDependencies` via a package-name → framework-label table:

| Package                | Framework label  |
|------------------------|------------------|
| `express`              | `express`        |
| `fastify`              | `fastify`        |
| `@nestjs/core`         | `nestjs`         |
| `hono`                 | `hono`           |
| `koa`                  | `koa`            |
| `next`                 | `next`           |
| `fastapi` (Python)     | `fastapi`        |
| `flask` (Python)       | `flask`          |
| `django` (Python)      | `django`         |

The table lives in `compat.json` or a sibling data file. Population happens at extract time. The snapshot guard catches schema drift.

## `platform` on ServiceNode/FileNode — Cloudflare Workers/Pages extraction (ADR-133)

`infra/cloudflare.ts` reads `wrangler.toml`/`wrangler.jsonc` (TOML via `smol-toml`; JSONC via the existing comment-mask helper + `JSON.parse` — no new grammar) and stamps two additive fields:

- `platform?: string` on `ServiceNodeSchema` — `'cloudflare'` when the service has a wrangler config. The frontend's icon key at the service-rollup level; a free string, not an enum, the same discipline `framework` already established.
- `platform?: string` + `platformName?: string` on `FileNodeSchema` — stamped on the Worker's entry file (resolved from wrangler's own `main` field, verbatim; not the SDK installer's eight-step entry-detection precedence). `platformName` is the Worker's own script name (wrangler's `name` field) — the only identifier Cloudflare's telemetry carries, and what the Cloudflare connector's `resolveTarget` looks up against (`connectors.md` §4).

Declared Cloudflare resources — KV/D1/R2/Durable Object/Queue bindings, cron triggers, service bindings, routes/custom domains, declared env-var names (never values) — become `InfraNode`s at `infraId(kind, name)` (kinds: `cloudflare-kv`, `cloudflare-d1`, `cloudflare-r2`, `cloudflare-durable-object`, `cloudflare-queue`, `cloudflare-cron`, `cloudflare-route`, `cloudflare-env-var`, `cloudflare-service-binding`), wired from the entry FileNode: `CONNECTS_TO` for routes (network-reachability, matching `dockerfile.ts`'s EXPOSE→port pattern), `DEPENDS_ON` for everything else declarative, `RUNS_ON` to a single shared `infra:workerd:cloudflare` node carrying `compatibility_date` as `evidence.snippet` (matching `dockerfile.ts`'s image-node + entrypoint-snippet pattern). A service binding resolves directly onto the target Worker's own entry FileNode (`CALLS`) when that Worker is tagged in the same scan; otherwise it falls back to a `cloudflare-service-binding` InfraNode, honestly. No new `NodeType`. Per-environment `[env.X]` wrangler sections are out of scope for v1 — only top-level config is read.

**ADR-138 extends the same `platform` field to three more providers.** `infra/vercel.ts` (`vercel.json`/`vercel.jsonc`, plus `.vercel/project.json` for `platformName`), `infra/railway.ts` (`railway.toml`/`railway.json`/`railway.jsonc` — no `platformName`, since Railway's config names no service), and `infra/supabase.ts` (`supabase/config.toml`, `project_id` → `platformName`) each stamp `platform` on the ServiceNode and model their declared resources — Vercel crons/env-var-names/routes, Railway healthcheck/cron, Supabase functions/storage/auth — as `InfraNode`s wired `DEPENDS_ON`/`RUNS_ON`/`CONNECTS_TO` through the shared `emitPlatformResourceEdge` helper. Same discipline as Cloudflare: no new `NodeType`, env-var values never read, `evidence.file` on every edge. Vercel and Railway have no Worker-style entry file, so the tag and the edges anchor on the ServiceNode itself.

## Route extraction + HTTP client↔route matching (ADR-119)

Static extraction reaches route grain. Two producers turn the two static islands — a client that names a URL and a server that declares a route — into one matched, file-precise relationship.

**Server routes (`routes.ts`).** A mainstream router's route table becomes `RouteNode`s at `(method, path-template)` grain, one per declared route, owned by the service through a `service ──CONTAINS──▶ route` edge (structural, evidence pinned to the defining `file:line`). The node id is `routeId(service, method, pathTemplate)` → `route:<service>:<METHOD> <template>`, built from the identity helper. Coverage is a dependency-gated registry — a service is read for routes only when its manifest declares one of the supported routers:

| Router | Recognised shape |
|---|---|
| Express | `app.<method>('/path', …)` / `router.<method>('/path', …)` |
| Fastify | `fastify.<method>('/path', …)` and `fastify.route({ method, url })` |
| Hono | `app.<method>('/path', …)` — same call shape as Express, gated on the `hono` manifest dependency (ADR-133 §5). `app.on([...methods], '/path', …)` isn't recognised — a Cloudflare Worker using it stays at the whole-file grain the connector already falls back to |
| Next.js | app-router `app/**/route.*` handler exports (`GET`/`POST`/…), pages `pages/api/**` handlers |
| FastAPI / Flask (Python) | `@<router>.<method>('/path', …)` decorators, FastAPI's multi-method `@<router>.api_route('/path', methods=[…])`, and Flask's `@<router>.route('/path', methods=[…])` (defaulting to GET), gated on the `fastapi` / `flask` manifest dependency (ADR-151). Read from the decorator's `.py` AST (`tree-sitter-python`), so a path on its own line in a multi-line decorator is captured. An in-file `APIRouter(prefix='/x')` (FastAPI) or `Blueprint(..., url_prefix='/x')` (Flask) composes its leaf prefix onto each decorator path (`@router.get('/{id}')` on `APIRouter(prefix='/items')` → `/items/{id}`); a prefix built from a config symbol (`prefix=settings.API_V1_STR`) leaves the router unprefixed rather than guessed. Cross-file `include_router` / `register_blueprint` mounting is the Python analog of Express's out-of-scope `app.use('/api', router)` — the leaf-router-relative path is captured, mount composition grows in a follow-on. |

The declared template is kept verbatim on the node (`/users/:id`, `/items/{item_id}`), so a future OBSERVED server span carrying the same `http.route` lands on the same node — `normalizePathTemplate` collapses `:id`/`{id}`/`[id]` param styles to one matching key. Mount-prefix resolution (`app.use('/api', router)`) and intra-file call-graph resolution are out of scope for this slice — the declared path is captured as-is. Coverage grows one router at a time through the registry, the same way instrumentation coverage grows; exhaustive router heuristics are a non-goal.

**Client↔route matching (`calls/route-match.ts`).** A recognised HTTP client call site — `fetch`, `axios` (default instance + method calls), node `http`/`https` — carries its method and path-template alongside the host. The host resolves to a service through the shared `buildServiceHostIndex` / `urlMatchesHost` path (ADR-065 #5); the path-template matches a server route by reducing both sides to a param-agnostic key (`normalizePathTemplate`: every dynamic segment — `:id`, `{id}`, `[id]`, a `${…}` interpolation, or a concrete id — collapses to `:param`, literals lowercase). A match mints a route-grained `file ──CALLS──▶ route` EXTRACTED edge from the client's FileNode to the server's RouteNode, carrying the method + path-template on its evidence. It grades `verified-call-site` (0.85) — both endpoints are recognised — so it clears the precision floor. The host + path must sit in the same URL literal for a match; split base-URL + path is out of scope for this slice. Route extraction runs before the calls phase so the matcher sees the full route table.

This realises the cross-service contract-matching idea: the route-grained edge is the shared target an OBSERVED server-span edge (issue #576) also lands on, so `get_divergences` compares declared against observed at route grain, not only at service grain — see [`divergence-query.md`](./divergence-query.md). Per [ADR-119](../decisions.md#adr-119--http-client-call-site--cross-service-route-matching).

## gRPC `.proto` method extraction (ADR-123)

Static extraction reaches gRPC method grain. `proto.ts` reads each service's `.proto` files **as data** — a bounded, brace-balanced line-scan for `service X { rpc Method(Req) returns (Res); }`, the way `calls/kafka.ts` scans for topics and the infra extractors read terraform / Dockerfiles. No tree-sitter grammar and no new language enter the toolchain (CLAUDE.md: Node 20 + TS only; polyglot files are read as data). Each `rpc` becomes a `GrpcMethodNode`, owned by the service the proto lives in through a `service ──CONTAINS──▶ method` edge (structural, evidence pinned to the `rpc` line). Streaming qualifiers (`stream Req` / `stream Res`) don't change method identity.

The node id is `grpcMethodId(rpcService, rpcMethod)` → `grpc:<rpcService>/<rpcMethod>`, built from the identity helper, where `rpcService` is the **fully-qualified** `<package>.<Service>` name the `.proto` declares (`orders.OrderService`). That FQN is precisely the `rpc.service` an OBSERVED gRPC execution span carries (see [`otel-ingest.md`](./otel-ingest.md) §gRPC methods), so the declared method and its observed counterpart fuse onto **one node** rather than twinning — the static half of two-sided gRPC observation. This is the same shape as route extraction: a static producer and an OBSERVED span landing on a shared node, so `get_divergences` compares declared gRPC methods against observed traffic at method grain. Message / field grain, `import` resolution across proto files, and error-detail enrichment are out of scope for this slice. Per ADR-123.

## Precision filters (ADR-065)

Five pre-emit gates inside the producer pass. A filtered candidate edge is never written to the graph — not added-then-retired. Idempotency stays intact (a re-run filters the same candidates, produces the same graph). Filtered candidates are silent; only true parse failures go to `errors.ndjson`.

All five apply universally across JS / TS / Python. No per-language opt-out.

### 1. Test-scope exclusion

Files matching any of the following are excluded from outbound CALLS / CONNECTS_TO inference:

- `**/__tests__/**`
- `**/__fixtures__/**`
- `**/integration-tests/**`
- `*.spec.{ts,tsx,js,jsx,py}`
- `*.test.{ts,tsx,js,jsx,py}`

The files remain registered as service-internal (a test file belongs to its package); only inferred outbound edges from them are filtered. Path matching is on the file path relative to `scanPath`, normalised to forward slashes. Highest-signal fixture: `packages/core/test/fixtures/precision/test-scope-postgres.spec.ts` (experiment row 0016).

### 2. Comment-body exclusion

No edge is inferred from a string literal whose AST parent (or any ancestor) is a comment node. tree-sitter exposes these via the `comment`, `block_comment`, `line_comment`, and `documentation_comment` node types depending on grammar; the producer's URL-string walker must skip them.

Highest-signal fixture: `packages/core/test/fixtures/precision/comment-body-jsdoc.ts` (experiment row 0014 — a JSDoc `@example` block containing `http://localhost:9000` was extracted as a real CONNECTS_TO edge).

### 3. JSX external-link exclusion

No edge is inferred from a URL string passed as a JSX attribute on an element whose tag matches `/^(a|Link|NavLink|ExternalLink|Anchor)$/`. The semantic shape is "user-clickable hyperlink to a documentation / marketing site," not "service-to-service call." Applies to common attrs (`to`, `href`) and any string-valued attr on a matching tag.

Highest-signal fixture: `packages/core/test/fixtures/precision/jsx-external-link.tsx` (experiment row 0006 — `<Link to="https://medusajs.com/changelog/" target="_blank">` became a CALLS edge to `@medusajs/medusa`).

### 4. `.env.template` exclusion

Files matching the following are documentation, not runtime config. They are not registered as ConfigNodes and produce no CONFIGURED_BY edges:

- `.env.template`
- `.env.example`
- `.env.sample`
- `.env.*.template`
- `.env.*.example`
- `.env.*.sample`

ADR-016 binds ConfigNode to file existence at runtime; templates have no runtime semantics. Highest-signal fixture: `packages/core/test/fixtures/precision/env-template/.env.template` (experiment rows 0008, 0015).

### 5. No URL-substring service matching

A URL whose hostname is `medusa.cloud` does not match the service `@medusajs/medusa` by substring containment. Cross-service inference from URL strings requires:

- An exact hostname match against a registered ServiceNode alias (host:port set in `aliases.ts`), **or**
- An exact hostname match against a registered InfraNode hostname.

`.includes(serviceName.slice(after-slash))` is forbidden. Common-word service names (`api`, `core`, `web`, `medusa`) make substring matching unconditionally wrong. Highest-signal fixtures: experiment rows 0001, 0002, 0003, 0012, 0013.

An exact match that clears this filter — a scheme-qualified URL literal (`http://service-c:3102`, `//service-c/path`) whose hostname equals a registered service's name, dir, or alias — is a **declared HTTP dependency**: the source code names another in-mesh service's URL. It is graded `url-literal-service-target` and lands **at** the precision floor (ADR-066), so it enters the EXTRACTED layer and `missing-observed` can measure it. This is the case a declared-but-never-driven service (`service-c` present in source, never started) must surface through: without a floor-level EXTRACTED CALLS edge there is nothing for `missing-observed` to compare against, and the OBSERVED-thesis blind spot stays open (issue #592). The grade sits below `structural` / `verified-call-site` (0.85) because no call expression wraps the literal — a URL string can be a config default that never runs — and above `url-with-structural-support` (0.5) because scheme + exact host + a resolved registered target is tighter than a bare `redis://host` scheme read. `urlMatchesHost` (scheme + `://` or `//`, exact hostname, exact port when the token carries one) is what keeps this distinct from the sub-floor `hostname-shape-match` tier; a bare hostname token still grades 0.2 and stays out of the graph. The `url-literal-service-target` grade and the infra producers' populated-evidence `CONNECTS_TO` emission are per [ADR-115](../decisions.md#adr-115--url-literal-service-target-grade--infra-connects_to-extraction-amends-adr-066--adr-032).

## Loud failure mode (ADR-065)

Silent partial extraction is forbidden. The previous behaviour — `console.warn(...)` per file with no aggregate — let ~90 medusa files quietly drop out of the snapshot during the v0.3.0 experiment with `neat init` exiting 0.

Per-file extraction failures route through these four behaviours:

1. **`<projectDir>/neat-out/errors.ndjson` append.** One JSON object per line: `{file, error, stack, ts, source: 'extract'}`. Append-only. The `errors.ndjson` artifact already exists for OTel error events (per ADR-033); the `source` discriminator separates extract failures from OTel error events for consumers.

2. **Banner aggregate.** `neat init` and `neat watch` summaries print `[neat] N files skipped due to parse errors` unconditionally. `0 files skipped` is a positive signal that no quiet skipping happened.

3. **`NEAT_STRICT_EXTRACTION=1` flips the exit code.** Any per-file failure causes `neat init` to exit non-zero. Useful in CI ("did this commit make extraction worse?"). Default unset — local dev wants forgiving behaviour with a banner.

4. **Catch + log the real stack at the call site.** "Invalid argument" is the Node N-API generic; the real cause was an extractor calling a method on a missing tree-sitter field. Per-call-site `try`/`catch` captures the parser context, not blanket suppression at the phase level.

## Regression fixture corpus (ADR-065)

`packages/core/test/fixtures/precision/` holds verbatim minimisations of the highest-signal v0.3.0 experiment evidence rows. Each fixture is the smallest reproduction of a row that v0.3.0's extractor produced a false-positive edge for. The contract assertions parameterise over them: "fixture X should produce no extracted edges of type Y."

| Fixture | Filter | Experiment row |
|---|---|---|
| `comment-body-jsdoc.ts` | comment-body exclusion | 0014 |
| `test-scope-postgres.spec.ts` | test-scope exclusion | 0016 |
| `jsx-external-link.tsx` | JSX external-link exclusion | 0006 |
| `env-template/.env.template` | `.env.template` exclusion | 0008 |
| `aws-client-raw.ts` | (also #238 AWS-SDK kind) | 0007 |

Adding a new false-positive shape to the corpus: drop a fixture, add an assertion line.

## Per-file parse-failure isolation (ADR-055)

Every producer that parses per-file content wraps the parse in `try / catch`. On failure: `console.warn` with the producer name, file path, and error message; `continue` to the next file. The phase completes even if some files are unparseable.

```ts
for (const file of files) {
  let parsed: T
  try {
    parsed = await readJson<T>(file)
  } catch (err) {
    console.warn(`[neat] <phase> skipped ${file}: ${(err as Error).message}`)
    continue
  }
  // … use `parsed` …
}
```

Wrap at the call site, not in shared helpers. `readJson` and `readYaml` in `extract/shared.ts` continue to throw on malformed input; producers wrap their call. Keeps warning messages contextual (producer name, file path, failure mode).

File reads that don't parse follow the same pattern when they sit inside a per-file walk — a permission error on one file shouldn't kill the phase.

Conformant sites today: `calls/http.ts`, `owners.ts`, `infra/k8s.ts`, `databases/*`. Sites needing the fix: `services.ts` (×2), `aliases.ts` (×2), `infra/docker-compose.ts`, `infra/dockerfile.ts`. See ADR-055 for the full enumeration and the implementation hand-off.

## Owner extraction (ADR-054)

`extract/services.ts` populates `ServiceNode.owner` per service. Source priority:

1. **CODEOWNERS file.** Read `<scanPath>/CODEOWNERS` first, then `<scanPath>/.github/CODEOWNERS`. Match each service's `repoPath` against the file's patterns. Use the literal RHS of the first matching line (`@org/team`, `email@addr`, etc.).
2. **`package.json` `author` field.** If CODEOWNERS doesn't cover the service's path, read `<service.repoPath>/package.json` and use `author` if present (string form or `name` from object form).
3. **Otherwise undefined.** No git-blame fallback (last-toucher ≠ owner; per-service git invocations are slow).

Format is the literal source value — no normalization in extract. Display-time normalization is the consumer's job.

OTel-auto-created services (per ADR-033) start with `owner: undefined`; static extraction backfills when `extract/services.ts` later discovers source. Property updates on existing nodes are allowed by extract producers per ADR-030.

CODEOWNERS pattern matching in MVP is minimal: support `*`, `**`, and exact paths. No full gitignore-style parser.

## Enforcement

`packages/core/test/audits/contracts.test.ts` includes:

- A scan asserting every EXTRACTED-edge construction site in `extract/` includes an `evidence` field with at least `file`. Lands as `it.todo` keyed to #140 and flips when the issue closes.
- A producer-interface assertion: every `addX` export under `extract/` accepts `(graph, services, scanPath)` (or a strict subset).
- An idempotency assertion: run a producer twice on the same fixture, expect identical graph state.
- Owner-extraction block (`it.todo`s for ADR-054): schema includes optional `owner`; CODEOWNERS at root + at `.github/`; package.json `author` fallback; undefined when neither source covers; backfill on existing nodes from OTel ingest.
- ADR-065 precision-filter block (five `it.todo`s — one per filter — flip live in #237): each loads its fixture, runs the producer, asserts no false-positive edge.
- ADR-065 loud-failure block (three `it.todo`s — flip live in #239): `errors.ndjson` shape, init-banner skipped-count phrase, `NEAT_STRICT_EXTRACTION=1` exit-code flip.

The PreToolUse hook surfaces this contract whenever any file under `extract/` or `watch.ts` is edited.

## Rationale

Static extraction was the most-FAIL'd layer in the verification pass — 7 FAILs and 13 PARTIALs across the tree-sitter audit. Most of them clustered around two missing structural rules: evidence shape on every EXTRACTED edge, and a cleanup mechanism keyed to it. Both rules already informally existed (CALLS edges carry evidence; the audit asks for cleanup). This contract made them universal across producers and tied them to the lifecycle authority that owns retirement.

ADR-065 closes the second cluster: producer-side precision (the v0.3.0 medusa run produced 20 EXTRACTED edges, 100% false positives) and observable failure mode (~90 medusa files silently dropped during the same run). Until both close, `get_divergences` (ADR-060) cannot be load-bearing — the layer it sits on is hallucinated and silently incomplete.

Full rationale and historical context: [ADR-032](../decisions.md#adr-032--static-extraction-contract), [ADR-065](../decisions.md#adr-065--static-extraction-precision-filters--loud-failure-mode-amends-adr-032).

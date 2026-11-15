---
name: identity
description: Node ids are constructed via @neat.is/types/identity helpers, never literals.
governs:
  - "packages/core/src/extract/**"
  - "packages/core/src/ingest.ts"
  - "packages/types/src/nodes.ts"
  - "packages/types/src/identity.ts"
adr: [ADR-028, ADR-122, ADR-123, ADR-125, ADR-158, ADR-274]
enforcement: [lint, review]
---

# Identity contract

Every node id in NEAT is constructed via the helpers in `packages/types/src/identity.ts`. Hand-rolled template literals like `` `service:${name}` `` are a contract violation.

## Helpers

```ts
import { serviceId, databaseId, configId, infraId, frontierId, graphqlOperationId, grpcMethodId, websocketChannelId, symbolId } from '@neat.is/types'

serviceId('checkout')                     // 'service:checkout'
databaseId('postgresql', 'db.example.com')  // 'database:postgresql:db.example.com'
configId('apps/web/.env')                 // 'config:apps/web/.env'
infraId('redis', 'cache.internal')        // 'infra:redis:cache.internal'
frontierId('payments-api:8080')           // 'frontier:payments-api:8080'
graphqlOperationId('api', 'query', 'GetUser')  // 'graphql:api:query GetUser'
grpcMethodId('orders.OrderService', 'GetOrder')  // 'grpc:orders.OrderService/GetOrder'
websocketChannelId('chat-api', '/chat')   // 'ws:chat-api:/chat'
symbolId('orders-api', 'src/order-service.ts', 'OrderService.create')  // 'symbol:orders-api:src/order-service.ts#OrderService.create'
symbolId('orders-api', 'src/order-service.ts', 'merge', 1)             // 'symbol:orders-api:src/order-service.ts#merge~1'
serverActionId('web', 'src/app/actions.ts', 'createUser')  // 'action:web:src/app/actions.ts#createUser'
```

Inverses (`parseServiceId`, `parseDatabaseId`, etc.) return the inner segment or `null` if the id doesn't match. Use them anywhere a consumer strips a prefix.

## Wire format (locked)

| Type          | Pattern                       | Source                                              |
|---------------|-------------------------------|-----------------------------------------------------|
| ServiceNode   | `service:<name>`              | manifest name verbatim                              |
| DatabaseNode  | `database:<engine>:<host>`    | canonical engine (`canonicalEngine`, compat.json `engineAliases`) + host; engine first so an IPv6 host's colons stay at the tail; port excluded (ADR-276). A service-local embedded DB is `database:<service>/<name>` (`localDatabaseId`) |
| ConfigNode    | `config:<relPath>`            | path relative to scan root, forward slashes         |
| InfraNode     | `infra:<kind>:<name>`         | free-string kind sub-typing per ADR-022             |
| FrontierNode  | `frontier:<host>`             | host:port from OTel peer attribute                  |
| GraphQLOperationNode | `graphql:<service>:<type> <name>` | serving service + lower-cased operation type + client operation name (ADR-122) |
| GrpcMethodNode | `grpc:<rpcService>/<rpcMethod>` | fully-qualified gRPC `rpc.service` (`<package>.<Service>`) + method — the wire contract, NOT the NEAT manifest name, so OBSERVED span and static `.proto` fuse (ADR-123) |
| WebSocketChannelNode | `ws:<service>:<channel>` | serving service manifest name + connection path/channel — scoped to the service like a route (a WS path is not globally unique), OBSERVED-only (ADR-125) |
| SymbolNode | `symbol:<service>:<relPath>#<qualname>` | owning service manifest name + service-relative path (the same two tokens as `fileId`, so a symbol scopes to its file) + source-declared qualname; an ordinal `~<n>` is appended only to separate same-named siblings. No provider/platform/framework/language token — the node is language-neutral (ADR-158) |
| ServerActionNode | `action:<service>:<module>#<exportName>` | owning service manifest name + service-relative module path (the same two tokens as `fileId` / `symbolId`, so an action scopes to its file) + exported binding name the client imports; `#` separates module from export name. No provider/platform/framework token — Next-specific in producer, not in id shape (ADR-168) |
| DependencyNode | `dep:<ecosystem>:<name>@<version>` | OSV ecosystem name verbatim + package name + resolved version, built by `dependencyId`. One node per resolved version, shared across a project's services (ADR-274) |
| Dependency SymbolNode | `symbol:dep:<ecosystem>:<name>@<version>:<relPath>#<qualname>` | a symbol inside dependency code, owned by its DependencyNode and never by a first-party service, built by `dependencySymbolId` (ADR-274) |

## Reconciliation rules

**Auto-created and static-extracted nodes merge by id.** When OTel ingest auto-creates a `ServiceNode` for an unseen `span.service` (issue #134) and static extraction later produces a `ServiceNode` with the same id, attributes merge — they do not coexist as duplicates. The id is the merge key. Static-extracted fields (`language`, `version`, `dependencies`) override OTel-derived fields where both exist.

**FrontierNode promotion preserves identity continuity.** When a `frontier:<host>` is promoted to a typed node (typically `service:<name>` after an alias resolves), the FrontierNode is removed and the typed node takes its place. Edges that pointed at the frontier id are rewritten to the new id. This is what `promoteFrontierNodes` already does in `ingest.ts`.

**A foreign-key edge resolves both endpoints to the same `infra:sql-table:<name>` node (ADR-161).** A `REFERENCES` edge (`infra:sql-table:<child> ──▶ infra:sql-table:<parent>`) uses `infraId('sql-table', name)` for both tables — the one id the column/table extractors and the OTLP `db.statement` parse already share. The parent is reproduced at the DATABASE table name the ORM actually uses (Drizzle's variable→`pgTable('...')` table, Prisma's `@@map`/model name, SQLAlchemy's `ForeignKey('table.col')` string), so the FK lands on the fused table node rather than minting a code-model twin — the same fidelity-is-the-fusion-key discipline as ADR-152/ADR-157. A parent NEAT cannot resolve to a real declared table is left unclaimed, never given an invented id.

**A differently-named observed service reconciles to its extracted twin by code path (#1707, ruled by Deniz 2026-11-15, recorded on that issue).** A telemetry `service.name` that is neither an extracted `ServiceNode` id nor a case or alias match for one (`resolveFusedServiceId`) would otherwise fork an observed-only `service:<name>` twin: its spans never attach to the extracted routes, files and databases, and the divergence list fills with false entries on both sides (NodeGoat sends `nodegoat`, NEAT extracts `owasp-nodejs-goat`). The service resolver takes three inputs, in order, the first that resolves winning:

1. **An explicit mapping** from a telemetry name to an extracted service, which overrides the other two. Its config surface is decided separately and is a marked gap here (pending Deniz's choice); the resolver takes the mapping as its first input so the surface plugs in without changing this rule.
2. **Name or alias** (`resolveFusedServiceId`): the extracted service whose name equals the telemetry name case-insensitively, or an alias of it (`extract/aliases.ts`).
3. **Code path**: the extracted service whose checkout the observed service's spans point into, read from each span's `code.filepath` (the observed files line up path for path with the extracted ones, `file:<observed>:<path>` against `file:<extracted>:<path>`).

Code-path reconciliation applies only when it is **unambiguous**: every located span of the observed service (every span carrying a `code.filepath`) resolves into the same single extracted service. The observed-only `ServiceNode` is then merged into that extracted service and its edges rewritten, the way `promoteFrontierNodes` rewrites a resolved frontier's edges, and the merge is recorded with provenance so a user can see that NEAT joined two names and on what evidence.

It does not merge, and the observed service stays distinct, when the observed service has no located span (no `code.filepath` to match on), or when its located spans point into two or more extracted services (ambiguous, never guessed).

**The match is re-evaluated, not frozen.** A merge made while only one extracted service matched is undone, and the observed service restored as distinct, once a second extracted service's files begin receiving that observed service's spans, so a later extraction that makes the match ambiguous brings the loud signal back rather than silently keeping a wrong merge.

An observed service that is not reconciled (no match, ambiguous, or unlocated) is made visible, not left silent: one clear divergence for the observed service as a whole, a `neat doctor` check and a `/health` line, in place of the list of false per-edge divergences the split produces today.

Reconciling changes which node an observed edge attaches to, so it changes ids where it applies (spans move off `service:<telemetry-name>` onto the extracted service). A snapshot already holding the orphan `service:<telemetry-name>` node is migrated: its observed edges are rewired onto the extracted service and the orphan is removed, the same rewrite the ingest pass performs.

## Identity modules (one per node kind)

A node's id and the canonicalisation that feeds it live in one module per node kind under `packages/core/src/identity/`, called by both static extraction and OTel ingest (#1641, option B, confirmed by Deniz 2026-11-15). The module holds that kind's canonicalisation (engine aliasing for databases, template canonicalisation and value-segment rejection for routes) and returns the id built from the `@neat.is/types/identity` helper above. Both sides call the one function, so a declared node and an observed node cannot be given different ids and twin.

Node creation and attribute merging stay with the callers (ADR-030 is unchanged); only id construction is shared. The canonicalisation stays in core because it reads core data (`compat.json` through `compat.ts`); `identity/` is substrate, so a module imports only `@neat.is/types` and other substrate. It lands kind by kind, each proving ids byte-identical on the existing fusion fixtures. Where the static and observed paths already disagree on an id, that is a bug filed with a fixture, not normalised silently.

- `identity/database.ts`: `databaseIdentity(engine, host)` and `localDatabaseIdentity(service, name)`, holding engine canonicalisation (`canonicalEngine`, ADR-276).
- `identity/route.ts`: `canonicalizeTemplate`, `normalizePathTemplate`, `observedRouteTemplate` and `VALUE_SEGMENT`, the route template canonicalisation and value-segment rejection.
- `identity/messaging.ts`: `messagingDestinationIdentity(system, destination)`, the messaging-destination InfraNode kind (`<system>-topic`) and its id, shared by the Kafka producer extractor and OTel ingest. A raw TCP socket (`extract/calls/socket.ts`) is a different infra kind, not a messaging destination; socket.io events are observed-first with no static twin.
- gRPC method: no module. The id is the wire FQN used verbatim through `grpcMethodId`, with no canonicalisation, so the static `.proto` and the observed span already agree and there is nothing to share.

## Deferred (do not silently re-engineer)

- **Workspace scoping.** A monorepo with two services both named `shared-utils` collides under `service:shared-utils`. Real fix is `service:<workspace>/<name>` with a snapshot migration; defer until a real codebase trips it.
- **Port in database ids.** Two databases of the same engine on one host at different ports still collide. Different engines on one host no longer do (ADR-276). Port stays out of the id because static config and spans don't both reliably know it, and an id only one side can compute never fuses.

## Enforcement

`packages/core/test/audits/contracts.test.ts` scans `packages/core/src/` and `packages/mcp/src/` for hand-rolled `` `service:${...}` `` template literals and fails CI on any match. The only allowed sites are inside `packages/types/src/identity.ts` itself, and inside test fixtures.

## Rationale

If two producers disagree on what id a node gets, OBSERVED edges from one never match EXTRACTED edges from the other and the coexistence contract (provenance.md) silently fails. Twelve hand-rolled id sites across nine files were kept consistent by good behavior alone before this contract; the contract makes that consistency mechanical.

Full rationale and historical context: [ADR-028](../decisions.md#adr-028--node-identity-is-constructed-via-helpers-not-string-literals).

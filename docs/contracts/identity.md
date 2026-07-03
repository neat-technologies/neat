---
name: identity
description: Node ids are constructed via @neat.is/types/identity helpers, never literals.
governs:
  - "packages/core/src/extract/**"
  - "packages/core/src/ingest.ts"
  - "packages/types/src/nodes.ts"
  - "packages/types/src/identity.ts"
adr: [ADR-028, ADR-122, ADR-123]
enforcement: [lint, review]
---

# Identity contract

Every node id in NEAT is constructed via the helpers in `packages/types/src/identity.ts`. Hand-rolled template literals like `` `service:${name}` `` are a contract violation.

## Helpers

```ts
import { serviceId, databaseId, configId, infraId, frontierId, graphqlOperationId, grpcMethodId } from '@neat.is/types'

serviceId('checkout')                     // 'service:checkout'
databaseId('db.example.com')              // 'database:db.example.com'
configId('apps/web/.env')                 // 'config:apps/web/.env'
infraId('redis', 'cache.internal')        // 'infra:redis:cache.internal'
frontierId('payments-api:8080')           // 'frontier:payments-api:8080'
graphqlOperationId('api', 'query', 'GetUser')  // 'graphql:api:query GetUser'
grpcMethodId('orders.OrderService', 'GetOrder')  // 'grpc:orders.OrderService/GetOrder'
```

Inverses (`parseServiceId`, `parseDatabaseId`, etc.) return the inner segment or `null` if the id doesn't match. Use them anywhere a consumer strips a prefix.

## Wire format (locked)

| Type          | Pattern                       | Source                                              |
|---------------|-------------------------------|-----------------------------------------------------|
| ServiceNode   | `service:<name>`              | manifest name verbatim                              |
| DatabaseNode  | `database:<host>`             | host only — port intentionally excluded             |
| ConfigNode    | `config:<relPath>`            | path relative to scan root, forward slashes         |
| InfraNode     | `infra:<kind>:<name>`         | free-string kind sub-typing per ADR-022             |
| FrontierNode  | `frontier:<host>`             | host:port from OTel peer attribute                  |
| GraphQLOperationNode | `graphql:<service>:<type> <name>` | serving service + lower-cased operation type + client operation name (ADR-122) |
| GrpcMethodNode | `grpc:<rpcService>/<rpcMethod>` | fully-qualified gRPC `rpc.service` (`<package>.<Service>`) + method — the wire contract, NOT the NEAT manifest name, so OBSERVED span and static `.proto` fuse (ADR-123) |

## Reconciliation rules

**Auto-created and static-extracted nodes merge by id.** When OTel ingest auto-creates a `ServiceNode` for an unseen `span.service` (issue #134) and static extraction later produces a `ServiceNode` with the same id, attributes merge — they do not coexist as duplicates. The id is the merge key. Static-extracted fields (`language`, `version`, `dependencies`) override OTel-derived fields where both exist.

**FrontierNode promotion preserves identity continuity.** When a `frontier:<host>` is promoted to a typed node (typically `service:<name>` after an alias resolves), the FrontierNode is removed and the typed node takes its place. Edges that pointed at the frontier id are rewritten to the new id. This is what `promoteFrontierNodes` already does in `ingest.ts`.

## Deferred (do not silently re-engineer)

- **Workspace scoping.** A monorepo with two services both named `shared-utils` collides under `service:shared-utils`. Real fix is `service:<workspace>/<name>` with a snapshot migration; defer until a real codebase trips it.
- **Host:port database ids.** Two databases on the same host different ports collide. Defer the fix; document the limitation.

## Enforcement

`packages/core/test/audits/contracts.test.ts` scans `packages/core/src/` and `packages/mcp/src/` for hand-rolled `` `service:${...}` `` template literals and fails CI on any match. The only allowed sites are inside `packages/types/src/identity.ts` itself, and inside test fixtures.

## Rationale

If two producers disagree on what id a node gets, OBSERVED edges from one never match EXTRACTED edges from the other and the coexistence contract (provenance.md) silently fails. Twelve hand-rolled id sites across nine files were kept consistent by good behavior alone before this contract; the contract makes that consistency mechanical.

Full rationale and historical context: [ADR-028](../decisions.md#adr-028--node-identity-is-constructed-via-helpers-not-string-literals).

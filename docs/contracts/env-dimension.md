---
name: env-dimension
description: OTel ingest carries an `env` discriminator. ServiceNode identity becomes `(service.name, env)`-scoped, parsed from `deployment.environment.name` with span-attr → resource-attr fallback chain landing on `'unknown'`. `serviceId(name, env?)` gains an optional second arg defaulting to `'unknown'`. Snapshot migration v3 → v4 rewrites legacy ids idempotently. FrontierNode / DatabaseNode / ConfigNode identity remain env-unscoped.
governs:
  - "packages/types/src/identity.ts"
  - "packages/core/src/ingest.ts"
  - "packages/core/src/otel.ts"
  - "packages/core/src/extract"
  - "packages/core/src/persist.ts"
adr: [ADR-074, ADR-028, ADR-031, ADR-066]
---

# Env-dimension at ingest contract

OTel spans carry a `deployment.environment.name` attribute that distinguishes prod traffic from staging traffic on the same `service.name`. ServiceNode identity grows an `env` component so the two land on distinct graph nodes, and the divergence query's OBSERVED-led weighting (ADR-066) scopes its per-edge confidence within an env rather than across the whole graph.

Six sections, one rule each.

## 1. ServiceNode identity is `(service.name, env)`-scoped

A ServiceNode's id wire format becomes `service:<env>:<name>`. Two services with the same `service.name` but different `deployment.environment.name` resolve to distinct ids and distinct nodes in the graph.

Examples:

- `serviceId('checkout', 'prod')` → `service:prod:checkout`
- `serviceId('checkout', 'staging')` → `service:staging:checkout`
- `serviceId('checkout')` → `service:unknown:checkout`
- `serviceId('checkout', undefined)` → `service:unknown:checkout`

OBSERVED edges from a prod span attach to `service:prod:checkout`; OBSERVED edges from a staging span attach to `service:staging:checkout`. They never merge into one node. EXTRACTED edges from static analysis (where no env signal exists at extract time) attach to `service:unknown:checkout` and are reconciled per the existing coexistence contract (contracts.md Rule 2) once OBSERVED traffic from an env-tagged span arrives.

## 2. `deployment.environment` parsing precedence

At ingest time (every OTel span), the ingest pipeline resolves the env discriminator in this order. The first hit wins; the fallback is the literal string `'unknown'`.

1. **Span attribute `deployment.environment.name`** — OTel Semantic Conventions v1.27+ canonical form.
2. **Span attribute `deployment.environment`** — OTel SC compat form (pre-v1.27 spans still carry this on some SDKs).
3. **Resource attribute `deployment.environment.name`** — preferred form when the env is declared once on the resource and shared across every span.
4. **Resource attribute `deployment.environment`** — compat resource form.
5. **Fall back to `'unknown'`** — no env signal anywhere in the span or its resource.

The fallback string is `'unknown'`, not `'development'` or `'production'`. Defaulting to either would bake a wrong assumption into every snapshot from a workload that does not yet advertise its env. `'unknown'` is honest about the absence of signal and lets future operator promotion fill the field without rewriting history.

## 3. `serviceId(name, env?)` is the identity surface

The `serviceId` helper in `packages/types/src/identity.ts` is the single source of truth for the wire format. The second positional argument is optional; when unset or explicitly `undefined`, the helper resolves to `'unknown'`.

```ts
export function serviceId(name: string, env?: string): string {
  return `service:${env ?? 'unknown'}:${name}`
}
```

The `parseServiceId` inverse returns `{ name, env }` instead of the bare `name` string. Consumers that only need the name (the existing call sites pre-env-dimension) destructure `.name` from the result.

Every other producer site in `packages/core/src/` and `packages/mcp/src/` continues to construct ids via the helper — hand-rolled template literals stay a contract violation per ADR-028 / [`identity.md`](./identity.md). The Rule 1-style scan in `contracts.test.ts` catches any escape.

## 4. Snapshot migration v3 → v4 rewrites legacy ids idempotently

`packages/core/src/persist.ts` ships a `migrateV3ToV4` step alongside the existing v1 → v2 and v2 → v3 migrations. The step:

- Walks every node whose id begins with `service:` and whose remainder does **not** already contain the env discriminator (no second colon segment matching the env pattern).
- Rewrites the id to `service:unknown:<original-name>`.
- Walks every edge whose `source` or `target` references a rewritten id and updates the reference (including the edge id's encoded source/target segments) so traversal and divergence consumers see the new wire format.

The migration is idempotent — re-running it on an already-v4 snapshot is a no-op. `SCHEMA_VERSION` bumps from `3` to `4`. Per [`schema.md`](./schema.md) and ADR-031, this is a shape change (node identity wire format) and requires both the ADR-074 ratification and the persist migration to land in the same release.

`saveGraphToDisk` writes `schemaVersion: 4` on every fresh write after v0.3.9 lands. `loadGraphFromDisk` runs the v1 → v2 → v3 → v4 migration chain in order on every load, so an operator who has been running NEAT since v0.1.x reaches v4 in one step.

## 5. ServiceNodes carry a `framework:` field

The `framework:` field on the install plan (introduced in ADR-073 §1 for the Next.js dispatch) becomes a first-class field on ServiceNode itself. Static extraction records:

```
framework: 'next' | 'remix' | 'sveltekit' | 'nuxt' | 'astro' | 'node' | 'python' | undefined
```

The field travels onto the node attributes at extraction time and surfaces to the divergence query, MCP tools, the REST API, and the web UI as an enrichment dimension. Per [`framework-installers.md`](./framework-installers.md), the JS installer's detection logic and the static extractor's framework recording are aligned: a project the installer recognises as Remix produces ServiceNodes with `framework: 'remix'`.

The field is **optional** — when the extractor cannot determine the framework (lib-only packages, ambiguous repos, languages without a framework concept), the field stays `undefined`. Consumers handle `undefined` cleanly; the field is enrichment, not identity.

## 6. FrontierNode / DatabaseNode / ConfigNode identity remain env-unscoped

The env discriminator applies to ServiceNode only in v0.3.9. The three other typed nodes keep their existing identity wire format:

- **FrontierNode** — `frontier:<host>`. FrontierNodes are unresolved peers; promoting them to env-scoped ids before the alias resolves would re-bake the same wrong-default problem in a different shape (every FrontierNode would carry `'unknown'` and the alias-resolution step would need a second rewrite pass).
- **DatabaseNode** — `database:<host>`. The host-keyed DatabaseNode is intentionally global per ADR-028 §6 — one DB across envs is the common deployment shape (a shared staging Postgres, a shared analytics warehouse), and the rare per-env DB case still resolves cleanly via the host.
- **ConfigNode** — `config:<relPath>`. ConfigNode identity is the file path relative to the scan root, which is already env-scoped by the directory tree (a monorepo's `apps/prod-api/.env` is a different file from `apps/staging-api/.env`).

InfraNode also stays env-unscoped — `infra:<kind>:<name>` remains the wire format. The free-string `kind` already provides the discrimination surface InfraNode needs, and env-scoping would force every infra producer to carry env signal it does not have today.

A successor ADR may extend env-scoping to FrontierNode (once alias resolution stabilises) or DatabaseNode (once per-env DB cases warrant the schema cost). v0.3.9 keeps the discriminator on ServiceNode where the divergence signal lives.

## Authority

- `packages/types/src/identity.ts` — `serviceId(name, env?)` signature and the `parseServiceId` inverse. Single source of truth for the wire format.
- `packages/core/src/ingest.ts` — `deployment.environment.name` parsing at OBSERVED edge construction; env passed through to `serviceId` calls on the producer side.
- `packages/core/src/otel.ts` — resource-attribute env extraction for spans whose resource carries the discriminator instead of the span itself.
- `packages/core/src/extract/*.ts` — `framework:` field set on every ServiceNode the static extractor produces.
- `packages/core/src/persist.ts` — `migrateV3ToV4` step and the `SCHEMA_VERSION = 4` bump.

## Enforcement

`describe('ADR-074 — neat sync + env-dimension + framework installers')` → nested `describe('§2 env-dimension at ingest')` in `packages/core/test/audits/contracts.test.ts`. Assertions land alongside the implementing PR; pre-implementation rows surface as `it.todo`.

Full rationale: [ADR-074](../decisions.md#adr-074--neat-sync-env-dimension-at-ingest-framework-installer-paths).

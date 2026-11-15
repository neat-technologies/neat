---
name: substrate
description: Six layers in packages/core (types, substrate, producers, queries, surfaces, entry points) with tooling beside queries. No file imports a layer above its own; producers may share ingest helpers; no import cycles. The map is docs/contracts/layers.json and scripts/check-layers.mjs enforces it in CI, with a shrink-only allowlist for today's violations.
governs:
  - "docs/contracts/layers.json"
  - "scripts/check-layers.mjs"
adr: []
enforcement: [lint, review]
---

# Substrate layers contract

Ruled by Deniz 2026-11-15, relayed by the orchestrator (#1373, parts A and B).

## 1. The rule

NEAT's core is six layers. A file may import from its own layer or any layer below it, never from a layer above. There are no import cycles between files.

| # | Layer | What lives there |
|---|-------|------------------|
| 1 | types | `packages/types`: schemas and shapes shared by every package |
| 2 | substrate | The graph, persistence, identity and registries, and the small shared primitives they rest on (credential scrub, ledger writes, OTLP wire shapes, spec diff, keychain, profiles) |
| 3 | producers | What writes facts into the graph: `extract`, `ingest`, `connectors`, `advisories`, `flag-stores`, the OTLP receivers, and the loops that derive graph facts (dependency code, healthy baseline, hang sensor) |
| 4 | queries | What reads the graph and answers: `traverse`, divergences, policy, security, search, ask, the incident card and its renderers, the PR verdict |
| 4 | tooling | `installers/`, `extend/`, `deploy/`: what acts on a user's project rather than on the graph. Same rank as queries; imports types and substrate |
| 5 | surfaces | The REST API, the SSE stream, every CLI verb and its presentation (`style`, `banner`, `welcome`), and `packages/mcp` |
| 6 | entry points | `cli.ts`, `daemon.ts` and its two planes, `neatd.ts`, `watch.ts`, `orchestrator.ts`, `server.ts`, and `index.ts` (the package's public barrel) |

Type-only imports count. A type that a lower layer needs belongs in that layer or in `packages/types`; moving it down is cheap, and an exemption would be a hole.

## 2. The producer exception

Producers may import each other's leaf helpers. That is what `extract` and `connectors` do with `ingest` today, and it is allowed.

The intent is that a producer imports the helper it needs from `ingest/<file>`, never through the `ingest.ts` barrel, which reaches into all of ingest. The check fails a new barrel import from a producer outside ingest. The existing ones are on their own allowlist (§5).

Two unit-level loops are known and allowed under this exception. Neither is a file-level cycle, which stays at zero:

- `extract/dependency-symbols` imports `advisories/fixdiff`, and `advisories` imports `extract`.
- `connectors/index` imports `healthy-baseline`, and `healthy-baseline` imports `connectors/types` and `connectors/kubernetes/*`.

## 3. The map

[`layers.json`](./layers.json) is the map, and it is authoritative. Every source file under `packages/core/src` and `packages/mcp/src` is placed in it, by file or by directory prefix. A new top-level file or directory needs an entry in the same PR, or the check fails with `unplaced`. Placement follows what the file does, not where it sits. When a file doesn't fit one layer cleanly, that usually means it is two modules.

`packages/mcp` is a surface. It may import `@neat.is/core` and `@neat.is/types`.

`@neat.is/core` may import `@neat.is/types` and `@neat.is/instrumentation-registry` and no other workspace package. Core importing a downstream consumer, such as the GitHub Action, is backwards.

## 4. The check

`scripts/check-layers.mjs` reads the import graph: every `import`, `export … from` and literal dynamic `import()`, type-only ones included, resolved through the TypeScript compiler's own scanner. It fails on:

1. an import cycle between files;
2. an import that goes up a layer;
3. a producer outside ingest importing the `ingest.ts` barrel;
4. a workspace-package import the package doesn't declare;
5. a source file the map doesn't place;
6. an allowlist entry whose import no longer exists.

It runs as a step in the CI job (`node scripts/check-layers.mjs`) and as one assertion in `packages/core/test/audits/contracts.test.ts`. It only reads files.

## 5. The allowlist only shrinks

Today's violations are listed in `layers.json` under `allowlist`, each with a reason and an issue:

- `upward`: 8 upward imports as of 2026-11-15 (#1681 orchestrator and daemon helpers used by surfaces, #1682 producers reading traverse and policy, #1683 installers importing banner, #1684 projects importing a search type, #1685 the dependency-code loop importing the security card);
- `producerBarrel`: 7 producers importing the `ingest.ts` barrel;
- `crossPackage`: `pr-verdict.ts` importing `@neat.is/action` (#1688).

A violation not on the list fails. So does an entry that no longer matches an import, so fixing a violation means deleting its entry in the same PR. Nothing is ever added to the allowlist to get a PR through. A new violation is fixed, or it goes to Deniz.

---
name: flag-grain
description: A feature-flag store is a dependency the services call, like a database, and its flags are its grain the way columns are a table's (ADR-157). One `flag-store` InfraNode per provider; each flag a provenanced entry in its `flags` list. EXTRACTED is the committed definition in the flag file plus the code that holds the key as a string literal. OBSERVED is what the store is serving, read from its sync service, and what a service's own evaluation reported in an OTel `feature_flag.evaluation` span event. A flag running in a state nobody committed is a `flag-mismatch` divergence on every service whose code reads the key, which the incident card carries. Provider names are data in compat.json and the reader table, never a branch in the reasoning core.
governs:
  - "packages/core/src/flags.ts"
  - "packages/core/src/extract/flags.ts"
  - "packages/core/src/flag-stores/**"
adr: [ADR-242, ADR-157, ADR-016, ADR-031, ADR-065, ADR-060, ADR-221, ADR-224]
enforcement: [lint, review]
---

# Flag grain contract

Sibling to [`divergence-query.md`](./divergence-query.md), which owns the divergence enum (§"The divergence types", `flag-mismatch`), and to [`incident-card.md`](./incident-card.md), which carries it. This contract covers what a flag store is, where each side of a flag comes from, and when the two sides disagree.

## 1. A flag store is a node; a flag is its grain

- **The node.** One `InfraNode` per provider: `id = infraId('flag-store', <provider>)` (`infra:flag-store:flagd`), `kind: 'flag-store'`, `provider` and `name` the provider.
- **The grain.** `InfraNode.flags: FlagAttr[]`, one entry per flag key, sorted by key. Absent on every other InfraNode. Additive schema growth (ADR-031).
- **Why an attribute, not a node.** Nothing traverses to a flag that doesn't traverse to the store. The store is the dependency a service calls, and the edge to it is what blast radius and root cause walk. This is the column rule (ADR-157 §1) applied to flags.

Each `FlagAttr` carries:

| field | provenance | meaning |
|---|---|---|
| `key` | — | the flag key |
| `provenances` | — | deduped, sorted: `EXTRACTED` when `declared` is set, `OBSERVED` when `observed` or `observedVariant` is set |
| `declared`, `declaredIn` | EXTRACTED | the committed definition (§2) and the flag file it came from |
| `readers` | EXTRACTED | `{ file, service, line }` for each code location holding the key as a literal (§3) |
| `observed`, `observedAt` | OBSERVED | the definition the store is serving (§4) and when it was read |
| `observedVariant`, `observedVariantReason`, `observedVariantAt` | OBSERVED | the variant a service's evaluation last reported, and the OpenFeature reason (§5) |

A definition is in **canonical form**: `{ state, defaultVariant, variants, targeting? }`, object keys sorted recursively. Bookkeeping (`description`, `metadata`, a provider's `source`, `selector`, `flagSetId`) is dropped, and an empty `targeting` is the same as none. Two canonical forms are equal exactly when they evaluate the same.

## 2. EXTRACTED: the flag file

A flag file is a `.json` file under the scan root, outside test paths, that:

- holds a top-level `flags` object whose entries carry a string `state` and a `variants` object; and
- names a provider in `$schema`, matched against `compat.json`'s `flagStores[].schemaPattern`.

Only the `flags` object is read. This is the one fenced content read ADR-242 adds to ADR-016's paths-only rule, and it never applies to an `.env`-shaped file (Rule 13). When two flag files declare the same key for one provider, the first by sorted path wins, so the result is stable.

The extraction pass replaces the EXTRACTED side whole. A flag deleted from the file, or a reader deleted from the code, drops out. The OBSERVED side of each flag is kept across passes.

## 3. EXTRACTED: the code that reads a key

A source file reads a flag when it holds a string literal exactly equal to a declared key.

- **Language-agnostic.** The match is on the literal, not on any SDK call shape: one regex over `"…"`, `'…'` and `` `…` `` literals on one line, after `maskCommentsInSource`. A wrapper (`check_feature_flag("k")`), a constant (`AD_FAILURE = "adFailure"`) and generated code all hold the literal in the service's own tree, so they match.
- **Skipped.** Test paths through `isTestPath` (ADR-065), which now also knows Cypress (`*.cy.*` and a `cypress` segment), and minified files.
- **What it mints.** The file gets a FileNode (if new) and an EXTRACTED `CONNECTS_TO` to the store, with evidence at the first matching literal's line. The flag records `{ file: <fileId>, service: <serviceId>, line }` in `readers`.
- **A key built at runtime** holds no literal and gets no reader. Nothing is guessed.

For the missing-observed/extracted compare, a `CONNECTS_TO` to a flag store rolls its file-grain source up to the owning service, as one to a database does (ADR-141): the literal is in one file, while the evaluation is often seen only at service grain.

## 4. OBSERVED: what the store is serving

The daemon reads `~/.neat/flag-stores.json`:

```json
{ "version": 1, "stores": [{ "id": "demo", "provider": "flagd", "endpoint": "localhost:8015", "project": "optional", "intervalMs": 15000 }] }
```

- **Not a `neat connector` provider.** Like the k8s substrate (ADR-224), a flag store is a dependency, not a SaaS vendor, so it has its own enable file and no `connectors.json` entry.
- **The endpoint is configuration.** How the daemon reaches the store (in-cluster DNS, a port-forward, a NodePort) is the operator's fact, never inferred.
- **Readers by provider.** `flag-stores/index.ts` holds the provider → reader table. `flagd` calls `flagd.sync.v1.FlagSyncService/FetchAllFlags`: one unary gRPC request over Node's `http2`, no auth, decoding `flag_configuration` (field 1) and skipping unknown fields.
- **The fold.** Each poll goes through ingest's `mergeObservedFlags`, so the mutation stays with ingest.ts (ADR-030). Only a declared flag takes an observed definition. A served flag with no committed twin mints nothing and is returned as `undeclared`. A declared flag the store no longer serves loses its observed copy.
- **A failed poll** (unreachable, timeout, non-zero `grpc-status`) writes nothing, so the last observed state stands. A change of state is logged once.
- **Evaluations are not definitions.** An evaluation endpoint (flagd's OFREP or `ResolveBoolean`) evaluates under a caller's context, so a targeting fault can read as the default. It never fills `observed`.

## 5. OBSERVED: a service's own evaluation

An OTel span event named `feature_flag.evaluation` (or the legacy `feature_flag`) carries one evaluation. `otel.ts` reads:

- `feature_flag.key` (required);
- the variant, from `feature_flag.result.variant`, else `feature_flag.variant`;
- the provider, from `feature_flag.provider.name`, else `feature_flag.provider_name`;
- the reason, from `feature_flag.result.reason`, else `feature_flag.evaluation.reason`.

`feature_flag.result.value` and the evaluation context are never read.

- **Which store.** The evaluation folds onto the store its provider names, else onto the only flag store in the graph, else it is dropped.
- **Declared flags only.** Only a declared flag takes the variant.
- **The edge.** A landed evaluation also upserts an OBSERVED `CONNECTS_TO` from the span's origin to the store: the twin of the literal join's edge.

## 6. The divergence: `flag-mismatch`

Computed, never stored, in `divergences.ts`, over every `flag-store` InfraNode. Provider names never appear there.

**When the store's served definition exists**, it is the authority. The divergence fires when its canonical form differs from the committed one. `changed` lists the fields that differ, in the order `state`, `defaultVariant`, `variants`, `targeting`. A targeting-only change fires too, which is why the whole definition is compared rather than only `defaultVariant`.

**Without a served definition**, an evaluation stands in, under two conditions:

- its reason is `static` or `default` (case-insensitive); a targeted variant is the flag working as committed;
- its variant differs from the committed `defaultVariant`.

`changed` is then `['defaultVariant']`.

**Where it lands.** One divergence per service with a reader: `source` = that service, `target` = the store, `readers` = that service's `file:line` list. With no reader, a single divergence lands on the store (`source` = `target`).

**What it carries.** `flagKey`, `changed`, `declaredVariant` and `observedVariant` (the defaults compared), `readers`, and confidence `0.9`: both sides are exact facts, as in `deploy-mismatch`.

**Rendering.** Every surface renders it through one phrase, `flagMismatchPhrase` in `incidents-render.ts`: the card's divergence summary, `neat divergences`, MCP `get_divergences` and the monitor stream. Example: `flag cartFailure: committed off, running on (read at src/services/CartService.cs:42)`.

**On the card.** The card's divergences are `computeDivergences(graph, { node: affected })`. A reading service's incident card, or its node-composed card (ADR-244), therefore names the flag with no card change.

## 7. Out of scope

- Policies on flags.
- Per-SDK call recognizers.
- YAML flag files and flags embedded in a manifest's ConfigMap.
- Providers other than flagd. The node, grain and divergence are provider-neutral; a provider adds a `compat.json` entry and a reader.
- Writing flags, and evaluating targeting.

## Enforcement

`packages/core/test/flag-grain.test.ts`:

- canonical form and compare, including a targeting-only change;
- flag-file recognition;
- the literal join across C# and TypeScript, which skips comments and a Cypress spec;
- the sync reader against a local HTTP/2 server speaking `FetchAllFlags`, including a failed poll leaving state intact;
- the divergence on the reading service, silence when served = committed, and the store-only case;
- the evaluation path's targeted vs untargeted rule;
- one end-to-end fixture: extract, poll, then the card for `service:cart` read through the REST route names the flag.

The MCP line is covered in `packages/mcp/test/tools.test.ts`.

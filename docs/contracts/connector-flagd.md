---
name: connector-flagd
description: DRAFT (ADR-242, Proposed). A flagd connector fuses each feature flag as a ConfigNode on the services whose code gates on it. EXTRACTED is the committed flag definition plus a CONFIGURED_BY edge from every non-test file holding the flag key as a string literal. OBSERVED is the definition flagd is actually serving, read from its sync service. A flag whose served definition differs from the committed one is a config-mismatch divergence on each gating service, which the incident card already carries. Flag definitions are the only config contents the extractor reads; .env stays paths-only.
governs:
  - "packages/core/src/extract/flags.ts"
  - "packages/core/src/connectors/flagd/**"
adr: [ADR-242, ADR-016, ADR-031, ADR-065, ADR-131, ADR-136, ADR-225]
enforcement: [review]
---

# flagd connector contract — DRAFT

> **Draft.** Governs nothing until ADR-242 is accepted. The OBSERVED transport (§4) is the open choice, and the rest assumes option A. No code lands against this file while it carries this banner.

Sibling to [`connectors.md`](./connectors.md), which owns the provider interface, the junction layer and poll health, and [`divergence-query.md`](./divergence-query.md), which owns the divergence enum. This contract covers what is specific to feature flags: what a flag node is, how a service gets attached to one, where the live definition comes from, and when the two disagree.

## 1. A flag is a `ConfigNode`, one per flag

- `id = configId("<flag file relPath>#<flagKey>")`
- `name` = the flag key
- `path` = the flag file
- `fileType = "flagd"`

Three optional fields join `ConfigNodeSchema`. The change is additive (ADR-031), and a non-flag ConfigNode carries none of them:

| field | provenance | shape |
|---|---|---|
| `declaredFlag` | EXTRACTED | canonical flag definition (§5) |
| `observedFlag` | OBSERVED | canonical flag definition (§5) |
| `observedFlagAt` | OBSERVED | ISO8601, the poll that wrote `observedFlag` |

Flags are nodes, not attributes on the file's node, because something traverses to them. The CONFIGURED_BY edge from a gating file is how an incident on a service reaches its flag.

## 2. Which files are flag files, and the one content read

**Recognition.** A `.json`, `.yaml` or `.yml` file is a flag file when either:

- its top level has a `flags` object whose entries carry `state` and `variants`; or
- its `$schema` names flagd's flag schema.

Nothing else is parsed.

**The content read.** ADR-016 keeps config extraction to paths only. This contract makes one fenced exception: a recognised flag file's `flags` object is read for the definitions. Nothing else is read:

- not the file's other keys;
- not `$evaluators`, which `targeting` references and which are inlined into the canonical form only to resolve a `$ref`;
- never an `.env`-shaped file (Rule 13).

A flag file the extractor finds outside every discovered service still yields its flag nodes, with no service edge until §3 attaches one.

## 3. EXTRACTED: a string literal equal to a known key is the call site

The flag files give a closed set of keys. A `CONFIGURED_BY` edge (EXTRACTED, `confidenceForExtracted('structural')`) goes from a FileNode to a flag node when that file contains a string literal exactly equal to the key.

- **Literals come from tree-sitter string nodes**, so comments and identifiers never match. A file is matched only if its language has an extractor.
- **The evidence is the literal's line.**
- **Test paths are skipped through `isTestPath`** (ADR-065). That helper is extended in the same change with `*.cy.*` and a `cypress` segment.
- **Indirection needs no special handling.** Wrappers (`check_feature_flag("k")`), constants (`AD_FAILURE = "adFailure"`) and generated code (`flags_gen.go`) all hold the key as a literal in the service's own tree, so the edge lands in that file. It is not necessarily the evaluating line.
- **Where code builds a key at runtime** (concatenation, a config lookup), no edge is minted. The divergence then has no gating service to land on and stays on the flag node alone. No edge is guessed.

## 4. OBSERVED: what flagd is serving

**Option A, recommended in ADR-242.**

- **The call.** The connector calls `flagd.sync.v1.FlagSyncService/FetchAllFlags`, default port 8015, as one unary gRPC request over Node's `http2`, through the junction layer (ADR-131).
- **What it writes.** For each returned flag whose node exists, it writes `observedFlag` and `observedFlagAt`.
- **A flag with no committed declaration** mints nothing. It is counted in the poll status (ADR-136) as `undeclared`, by key.
- **On failure** (unreachable, non-zero `grpc-status`), the connector writes nothing and records the error in poll status. A stale `observedFlag` is never refreshed from memory.
- **Config.** The `options` field of a `connectors.json` entry carries `endpoint` (host:port). There is no credential, because flagd's sync service has no auth. If an operator fronts it with one, a bearer env-ref follows `connector-config.md` §2.

**Option B, the alternative.** Read the `flagd-config` ConfigMap through the k8s leg. That needs a new `get configmaps` RBAC grant and a `connectors.md` §6 amendment, and it sees the declared ConfigMap rather than what flagd loaded.

**OFREP is not an OBSERVED source.** It returns evaluations under a caller-supplied context, so a targeting-branch fault reads as `off` without the right context (ADR-242). Never use it to fill `observedFlag`.

**When telemetry names the flag.** Where a span carries an OTel `feature_flag.key` attribute, ingest promotes the matching CONFIGURED_BY edge to OBSERVED, by the usual file-grain fusion (`connectors.md` §4). That is additive. The divergence never depends on it.

`observedFlag` and `observedFlagAt` are live state. They are stripped on every snapshot write and read, like `observedDeployContext` (ADR-241).

## 5. Canonical form and the divergence

**Canonical form.** `{state, defaultVariant, variants, targeting}` with object keys sorted recursively. `targeting` is absent when unset. flagd's added fields (`source`, `metadata`, `flagSetId`) are dropped.

**The divergence.** `config-mismatch` with `kind: 'flag'` is computed, never stored, like every divergence:

- **When.** A flag node with both `declaredFlag` and `observedFlag` whose canonical forms differ.
- **One per gating service.** `source` = `service:<name>` of each FileNode with a CONFIGURED_BY edge to the flag; `target` = the flag node.
- **Carried fields.** `flagKey`, `declared` and `observed` (the canonical forms), and `changed`: the top-level fields that differ (`defaultVariant`, `targeting`, `variants`, `state`).
- **No gating service.** One divergence with `source` = `target` = the flag node.
- **Whole definition, not `defaultVariant`.** A targeting-branch flip leaves `defaultVariant` untouched, so comparing only `defaultVariant` would miss it.
- **The card needs no change.** `buildIncidentCard` already includes `computeDivergences(graph, { node: affected })`. `divergenceSummary` gains the case `flag <key> changed <fields>`.

Adding the type means the enum grows by one, in the same change. That includes every exhaustive `Record<DivergenceType, …>` and `switch` (web `DivergencesPage.tsx`, core `TYPE_LEADERSHIP`, `divergenceSummary`), built without `--filter`.

## 6. Out of scope

- Flag providers other than flagd, such as LaunchDarkly or Unleash. `kind` leaves room for them.
- Writing flags.
- Evaluating targeting.
- Guessing a runtime-built key.

## Enforcement

Review until the build lands. Then:

- a fixture test over a copy of the demo's flag file plus two services;
- a live test against a real flagd binary, with no mock on the poll path (`connectors.md` §5).

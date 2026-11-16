---
name: no-regression-gate
description: The hidden `neat gate` verb and the action's `no-regression-gate` input (ADR-277). The verb turns a pull request's base and head checkouts into the NoRegressionGateVerdict (four tri-state conditions: blast radius bounded, test suite green, no new divergence, security scan clear, plus a parallel Sniper-targetable findings list), reusing pr-verdict's buildGateVerdict over two extracted graphs, and prints the verdict as JSON. neat-action shells to it in CI, posts the four conditions, and blocks a merge only when a repo opts in with no-regression-gate: fail. Off by default, fail-closed.
governs:
  - "packages/core/src/gate-cli.ts"
  - "packages/core/test/gate-cli.test.ts"
  - "packages/action/src/gate.mjs"
  - "packages/action/src/gate-step.mjs"
  - "packages/action/action.yml"
adr: [ADR-277, ADR-235]
enforcement: [lint, review]
---

# No-regression gate contract

The build-out of ADR-277's opt-in, fail-closed pre-merge gate on the CI path. The verdict, its four conditions and its findings are fixed by ADR-277 and the `@neat.is/types` `gate.ts` schemas; this contract governs the seam the action reaches it through.

## 1. The hidden `neat gate` verb

```
neat gate --base <checkout> --head <checkout> \
  --max-files <N> --max-services <N> [--tests pass|fail]
```

- **Hidden.** `gate` is an internal CI seam, the same way `assess` is ([`candidate-assessment.md`](./candidate-assessment.md)). It appears in no public help.
  - It is not in `usage()` or in `QUERY_VERBS`, and it is not among the verbs [`cli-surface.md`](./cli-surface.md) lists. `cli-surface.md` is deliberately left unchanged.
  - An audit test holds it out of `usage()` and `QUERY_VERBS`.
  - A public `neat gate` verb is a separate `cli-surface.md` item and its own decision; the verb is promotable later without touching the action.
- **Required flags.** `--base`, `--head` and the two ceilings are required; the ceilings are positive integers. `--tests` is the one optional flag: absent, the tests condition is `unknown`.
- **Checkouts, not graphs.** `--base` and `--head` are two checkouts on disk. The caller gives them the same leaf directory name, so a `package.json` with no name is the same service on both sides (#1557), not one removed and one added.
- **Usage errors.** A missing or malformed flag, or a checkout that is not a directory, exits 2.

## 2. Placement

The code follows the layer contract ([`substrate.md`](./substrate.md), `layers.json`):

- **`pr-verdict.ts` (queries).** `gateFromCheckouts` extracts the two checkouts into scratch graphs and assembles the verdict with `buildGateVerdict`, the same assembly the hosted `POST /pr-verdict` route (ADR-235) runs. The gate is computed one way for both paths.
- **`gate-cli.ts` (surfaces).** The verb: flag parsing, producer silencing, the JSON print.

## 3. Isolation and output

The verb writes nothing. Both graphs are scratch, registered under no project, and dropped when the process exits. Extraction runs with producers silenced, because the one line on stdout is the verdict.

- **One JSON object on stdout**, the `NoRegressionGateVerdict` the caller decodes: `{ conditions, findings, passed }`. Finding fields carry identifiers and loci only, never messages, snippets or source.
- **No live OBSERVED graph.** A CI run has no connected daemon, so observed breaks are empty here. A runtime break is a Sniper target on the hosted path, never a gate condition (ADR-277).
- **Security is the one network step** (the advisory lookup). A failure, or advisories off, leaves the security condition `unknown`, never a pass.
- **Exit codes.** 0 means the gate passed. 1 means it did not (a verdict is printed either way), or the graphs could not be built (no verdict, read as unevaluable). 2 means malformed usage. Fail-closed: a caller treats a missing or non-pass verdict as not passed.

## 4. The action input

`no-regression-gate` wires the verb into neat-action, with the same exit-code shape as the security gate ([`policy-actions.md`](./policy-actions.md), `exit.mjs` sets `process.exitCode = 1` and does not throw, so the comments still post):

- **`off` (default).** The gate does not run. The gate is opt-in, so an existing action user pays nothing until they ask for it.
- **`report`.** The gate runs and posts the four conditions as a sticky comment, and never fails the check.
- **`fail`.** The gate runs, posts the four conditions, and fails the check when the verdict does not pass. A condition NEAT cannot evaluate counts as not passed (fail-closed), so a missing input never reads as a pass.

In both `report` and `fail`, the comment shows all four conditions, so a repo sees the answers before it opts in to blocking. `tests-result` carries the workflow's test-job outcome (`success` is green, `failure` is red, anything else leaves the condition unknown), and `gate-max-files` / `gate-max-services` set the blast-radius ceiling. A full checkout (`fetch-depth: 0`) lets the action read the base commit; without it the gate is unevaluable and fails closed when it blocks.

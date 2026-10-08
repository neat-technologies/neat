---
name: detached-assessment
description: Assess a sandbox checkout against a graph baseline without changing the tenant daemon, writing source or snapshots, or approving past a block.
governs:
  - 'packages/core/src/extract/assess.ts'
  - 'packages/core/src/assess-cli.ts'
  - 'packages/core/test/assess*.test.ts'
enforcement: [lint, review]
---

# Detached checkout assessment

Refs #1301. This is an internal Sniper confidence seam, deliberately absent
from public CLI help and `cli-surface.md`. It is not the live governance kernel
or a claim that a patch fixes an incident.

## Inputs and isolation

`neat assess --path <checkout> --baseline <graph.json> --policies <policy.json>
--origin <node-id> --max-files <N> --max-services <N>` prints one JSON verdict.
Every flag is required; bounds are positive integers. Baseline input accepts the
daemon's `{nodes, edges}` wire shape or a graphology snapshot's `{graph}` shape.
Policies come from the run's authoritative policy read, never the patched
checkout's potentially changed policy file. Missing or malformed inputs fail.

Extraction runs in a fresh graph, without using the project graph registry,
connecting to a daemon, loading connectors, or writing a snapshot, error sidecar,
registry, or source. Producer diagnostics are suppressed by the CLI; generic
error codes replace messages which might contain source. Any extraction error,
intentional unparsed source skip, missing origin, invalid graph entry, dangling
baseline edge, or unresolved runtime endpoint refuses the assessment.

## Proposed state

Fresh extraction replaces the baseline's EXTRACTED layer. OBSERVED, INFERRED and
STALE edges retain their baseline evidence and endpoints. FRONTIER edges do not
enter the settled proposal. A static endpoint deleted by the patch is never
resurrected to keep an old runtime edge alive: assessment fails instead. Runtime
enrichment of a surviving static node is preserved, while fresh declaration fields
win. Baseline FileNodes, static SymbolNodes and endpoints of EXTRACTED edges are
static-owned; other baseline nodes may remain as runtime-only facts.

The existing policy evaluator checks the proposed state with the authoritative
policies. Any `onViolation: block` prevents pass, including pre-existing blocks;
only a human changes policy. The existing inbound blast-radius traversal runs
from the origin, using enough depth to cover this finite graph. Origin plus
reachable FileNodes and ServiceNodes must remain within the run's bounds.

## Output and failure

The output is `{passed, reason, violations, blastRadius, graphDiff}`. `reason` is
a fixed code. Violations contain only policy id, action, rule type and subject
node/edge ids. The blast radius contains sorted node ids and file/service counts.
Graph changes contain sorted added/removed/changed node and edge ids, never node
attributes, edge evidence, snippets, policy messages, error text, or source.
The same baseline, policies and checkout produce the same verdict; timestamps
and absolute extraction paths do not enter output.

Exit 0 means passed, 1 means assessed/refused or unavailable, and 2 means malformed
CLI usage. Both refusal and unavailable produce a structured verdict. Confidence
callers require exit 0 AND `passed: true`; missing evidence is never a pass.

<!-- NEAT graph-first guidance. Paste this block into your agent's project
     instructions — CLAUDE.md, AGENTS.md, .cursorrules, or the equivalent —
     so the agent reaches for NEAT's graph before scanning files by hand.
     Agent-agnostic: it is plain guidance, no Claude Code features required. -->

## Reach for NEAT's graph before grepping

This project has NEAT wired in. NEAT keeps a live semantic graph of the system —
code, infrastructure, and runtime behaviour fused into one model — reachable over
MCP (and a REST API). Every edge carries provenance: `EXTRACTED` from source,
`OBSERVED` from OpenTelemetry, `INFERRED` where the trace stitcher bridges a gap,
`STALE` when runtime goes quiet — so you know how much to trust each answer.

When you need to understand this codebase, query the graph first. It is usually
faster and more accurate than `grep`/`glob`/`find`, and it can tell you what the
system *actually does at runtime*, not only what the source declares.

Reach for these MCP tools before raw text search:

- `semantic_search` — find code/nodes by a natural-language description.
- `get_dependencies` — a node's transitive outgoing dependencies (declared, `EXTRACTED`).
- `get_observed_dependencies` — only what a node calls *in production* (`OBSERVED` via OTel).
- `get_divergences` — where the code (`EXTRACTED`) and production (`OBSERVED`) disagree.
  The most NEAT-shaped query; reach for it on "is anything weird here?"
- `get_root_cause` — trace a failing node up its dependency graph to the culprit.
- `get_blast_radius` — everything downstream of a node: what breaks if it changes or fails.
- `get_incident_history` — recent OTel error events recorded against a node.
- `check_policies` — the project's `policy.json` violations, actual or hypothetical.

Text search is still a fine fallback. If the graph does not have what you need —
comments, string literals, config minutiae, a file NEAT does not model — go ahead
and `grep`. The point is order: ask the graph first, then fall back to scanning.

If the tools are not available, the NEAT daemon may not be running (`neatd status`)
or the MCP server may not be wired in (`neat skill --apply`).

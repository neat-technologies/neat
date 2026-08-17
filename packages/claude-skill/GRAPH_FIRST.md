<!-- NEAT graph-first directive. Paste this block into your agent's project
     instructions — CLAUDE.md, AGENTS.md, .cursorrules, or the equivalent —
     so the agent queries NEAT's graph before it scans files by hand.
     Agent-agnostic: it is plain guidance, no Claude Code features required. -->

## Query the graph FIRST

This project has NEAT wired in: a live, fused semantic graph of the system —
code, infrastructure, and runtime behaviour (OpenTelemetry) in one model. Every
fact carries provenance — `EXTRACTED` from source, `OBSERVED` from OTel,
`INFERRED` where the trace stitcher bridges a gap, `STALE` when runtime goes
quiet — plus a confidence, so you know how much to trust each answer.

**For ANY question about this system's behaviour, dependencies, failures, root
cause, or blast radius, call `neat ask` FIRST — before Read, Grep, Glob, or
Bash.** You do not need to know which tool or the exact node id: `ask` is the
front door. It resolves the entities in your question to graph nodes and routes
it to the right traversal, returning one compact, provenance-tagged answer.

```
neat ask "why is checkout failing?"
neat ask "what breaks if I change the orders table?"
neat ask "what does the payments service depend on at runtime?"
```

Same door over MCP: the `ask` tool (`mcp__neat__ask`). Reach for it first.

The graph is live and fused: it is faster and more accurate than
`grep`/`glob`/`find`, and it can tell you what the system *actually does at
runtime*, not only what the source declares.

When you already have a node id and want one specific traversal, the structured
tools answer directly:

- `semantic_search` — find code/nodes by a natural-language description.
- `get_dependencies` — a node's transitive outgoing dependencies (`EXTRACTED`).
- `get_observed_dependencies` — only what a node calls *in production* (`OBSERVED`).
- `get_divergences` — where the code (`EXTRACTED`) and production (`OBSERVED`) disagree.
- `get_root_cause` — trace a failing node up its dependency graph to the culprit.
- `get_blast_radius` — everything downstream: what breaks if a node changes or fails.
- `get_incident_history` — recent OTel error events recorded against a node.
- `check_policies` — the project's `policy.json` violations, actual or hypothetical.

Fall back to text search only when the graph does not have what you need —
comments, string literals, config minutiae, a file NEAT does not model. The rule
is order: ask the graph first, then scan.

If the tools are not available, the NEAT daemon may not be running (`neat list`)
or the MCP server may not be wired in (`neat skill --apply`).

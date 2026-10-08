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
cause, or blast radius, call the MCP `ask` tool (`mcp__neat__ask`) FIRST — before Read, Grep, Glob, or
Bash.** You do not need to know which tool or the exact node id: `ask` is the
front door. It resolves the entities in your question to graph nodes and routes
it to the right traversal, returning one compact, provenance-tagged answer.

```
npx neat.is ask "why is checkout failing?"
npx neat.is ask "what breaks if I change the orders table?"
npx neat.is ask "what does the payments service depend on at runtime?"
```

Use the CLI examples when MCP is not configured.

When something is failing, ask what failed, get its `get_incident_card`, then
use `expand` and `relate` to walk the root-cause chain. The card gives the
incident locus, root cause, blast radius, policies, and divergence in one work
order. Check the provenance and confidence of each claim before acting.

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
- `get_incident_card` — an incident work order with cause, impact, policies, and divergence.
- `expand` / `relate` — walk the graph around a failure and test whether two nodes are connected by the failure signal.
- `get_graph_diff` — compare a saved graph snapshot with the live graph.
- `get_recent_stale_edges` — find observed integrations that have gone quiet.
- `check_policies` — the project's `policy.json` violations, actual or hypothetical.

Fall back to text search only when the graph does not have what you need —
comments, string literals, config minutiae, a file NEAT does not model. The rule
is order: ask the graph first, then scan.

If the tools are not available, check the daemon with `npx neat.is list` or
restart it with `npx neat.is up`. Wire MCP with `npx neat.is skill --apply`.

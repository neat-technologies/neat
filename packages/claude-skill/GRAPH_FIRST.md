<!-- NEAT graph-first directive. Paste this block into your agent's project
     instructions — CLAUDE.md, AGENTS.md, .cursorrules, or the equivalent.
     Agent-agnostic: it is plain guidance, no Claude Code features required. -->

## Let NEAT investigate before you search files

This project has NEAT. It does the investigation for this system so you can
spend your effort on the code: what exists, what actually ran, where a failure
began, and what a change will reach. It answers from a live graph that fuses
code, data and infrastructure declarations with runtime traffic, incidents and
supported provider telemetry. The graph is deterministic: you supply the
reasoning about the fix; NEAT resolves named nodes and traverses recorded
evidence rather than asking an LLM to infer architecture from file names.

Every claim carries provenance and confidence. `EXTRACTED` comes from recognized
source or configuration, `OBSERVED` from spans or supported provider signals,
`INFERRED` from a bridged relationship, and `STALE` marks an observed edge that
went quiet. Missing runtime evidence does not prove a path never runs.

**For questions about this system's behavior, structure, data dependencies,
failures, or change impact, call the MCP `ask` tool (`mcp__neat__ask`) before
Read/Grep/Glob/Bash.** You do not need an exact node id. `ask` resolves names
and routes to the relevant graph traversal, returning provenance-tagged facts.
When MCP is unavailable, use the same door through the CLI:

```
npx neat.is ask "why is checkout failing?"
npx neat.is ask "what breaks if I change the orders table?"
npx neat.is ask "what does the payments service depend on at runtime?"
```

For a failure, call `get_incident_card` on the failing service, file or symbol
(if you don't know which, `ask` what is failing first). The card is the
investigation already done: the incident, its likely cause chain, blast radius,
the governing policies and divergence, in one work order. Use `expand` one hop
at a time and `relate` to test whether the suspected cause and symptom share a
signal. Check provenance and confidence before acting.

Before a change, use `get_blast_radius` and `check_policies` to see dependents
and advisory architectural rules. Use `get_divergences` to compare declared
intent with observed behavior, `get_graph_diff` to compare a saved snapshot
with the live graph, and `get_recent_stale_edges` when traffic goes quiet.
`get_dependencies` maps a node's outgoing graph; `get_observed_dependencies`
shows only seen runtime/provider calls. `semantic_search` finds node labels,
not arbitrary source text.

Read source when the graph does not model what you need: comments, arbitrary
string literals, config details, unsupported syntax, or a repository that has
not been extracted or connected. If a graph answer is empty, check the daemon
with `npx neat.is list` or restart it with `npx neat.is up`; wire MCP with
`npx neat.is skill --apply`.

<!-- NEAT graph-first directive. Paste this block into your agent's project
     instructions — CLAUDE.md, AGENTS.md, .cursorrules, or the equivalent.
     Agent-agnostic: it is plain guidance, no Claude Code features required. -->

## Let NEAT investigate before you search files

**Anything failing, slow, or crashing: call `investigate` first** — give it the
service, the symptom, or a node id, before kubectl, logs, Read, or Grep. One call
composes the incident: the cause with its provenance, the blast radius, and the
fix locus.

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

For a failing system, start with `investigate` — give it the service or the
symptom and it composes one work order: the recorded failure with its deploy/env
context, the likely cause chain with provenance, the blast radius, the governing
policies, and where declared and observed behaviour diverge. (`get_incident_card`
composes the same from an exact node id; `ask` what is failing first if you don't
know the node.) It is one view of the incident, not a separate source of truth;
NEAT also pushes this card to you when it detects a failure worth one (via `neat
monitor`), the work order handed to you rather than fetched. Then
`get_incident_history` and `get_root_cause` for the parts, and `expand` one hop at
a time with `relate` to test whether a suspected cause and symptom share a signal.

Before a change, use `get_blast_radius` and `check_policies` to see dependents
and advisory architectural rules. Use `get_divergences` to compare declared
intent with observed behavior, `get_graph_diff` to compare a saved snapshot
with the live graph, and `get_recent_stale_edges` when traffic goes quiet.
`get_dependencies` maps a node's outgoing graph; `get_observed_dependencies`
shows only seen runtime/provider calls. `semantic_search` finds node labels,
not arbitrary source text.

Trust the graph's answer by its provenance, and stop when the fault is localized
— the failing node and what is wrong with it. Match one query to the symptom
rather than re-running the same query or sweeping every tool; a provenance-tagged
result is the answer, not a cue to re-confirm it by reading source.

Read source when the graph does not model what you need: comments, arbitrary
string literals, config details, unsupported syntax, or a repository that has
not been extracted or connected. If a graph answer is empty, check the daemon
with `npx neat.is list` or restart it with `npx neat.is up`; wire MCP with
`npx neat.is skill --apply`.

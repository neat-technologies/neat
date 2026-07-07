---
name: mcp-tools
description: MCP tool surface — manifest-driven, all read-only over REST, three-part response (NL + structured + confidence/provenance footer), get_dependencies is transitive, project scoping consistent.
governs:
  - "packages/mcp/src/**"
adr: [ADR-039, ADR-091, ADR-102, ADR-132]
enforcement: [lint, review]
---

# MCP tool surface contract

Governs `packages/mcp/src/`. Tools call REST against `NEAT_CORE_URL`; never read `graph.json` or mutate the graph.

## Tool surface (manifest-driven)

The registered tool set is whatever `MCP_TOOL_NAMES` exports from `@neat.is/types`. One manifest, every surface — the MCP server registration and the contracts audit both derive from it, so they never disagree about what tools exist. Adding or renaming a tool is a single edit in that file; the count is not locked here.

The audit's `evaluate_policy` + `get_policy_violations` two-tool split remains rejected per CLAUDE.md framing — `check_policies` handles both modes via optional `hypotheticalAction`.

## Three-part response (issue #143)

```
{NL paragraph — what was found, why it matters}

{structured block — typed payload, formatted}

confidence: X.XX · provenance: OBSERVED|EXTRACTED|...
```

Confidence and provenance derived per-result. Empty result → footer reads `confidence: n/a · provenance: n/a`.

A helper `formatToolResponse({ summary, block, confidence?, provenance? })` lives in `packages/mcp/src/format.ts`. Every tool routes through it.

## Transitive `get_dependencies` (issue #144)

Default depth 3, max 10. Calls the core endpoint `GET /graph/dependencies/:nodeId?depth=N` (see ADR-040). Returns flat list with distance, edge type, provenance. Direct-only consumers pass `depth=1`.

## REST-only data path

Every tool calls the daemon's REST API via `client.ts`. No `graph.json` reads.

## Profile resolution and remote mode (ADR-102)

The base URL the tools call is the selected **profile's** `endpoint` — the one seam shared with the CLI and the GUI ([`client-profiles.md`](./client-profiles.md)). The MCP server resolves it (`packages/mcp/src/base-url.ts`) by precedence: `NEAT_CORE_URL` (+ `NEAT_AUTH_TOKEN`; `NEAT_API_URL` honored as alias) → the nearest `neat-out/daemon.json` walking up from cwd → the loopback default. Resolution never throws — a missing, malformed, or `status:"stopped"` daemon record falls through to the next level.

A profile may point at a local per-project daemon or a hosted one, so an agent can be pinned at a hosted daemon and run the read/OBSERVED tool surface against production data. The read tools are profile-routable; the `/neat extend` operative tools mutate the local filesystem and stay local-only.

## Project scoping

Optional `project?: string`, defaulting to `'default'` per ADR-026. Multi-project routing happens at REST.

## No demo-name hardcoding

`payments-db`, `pg`, `postgresql` allowed only inside Zod `.describe()` strings. Never in branching logic.

## `semantic_search`

Tool description reflects the ADR-025 embedder chain (Ollama → MiniLM → substring), not "keyword search."

## Stdio only

HTTP / SSE / WebSocket transports remain post-MVP.

## Authority

Read-only. Mutation-authority scan in `contracts.test.ts` enforces this for `packages/mcp/src/`.

Full rationale: [ADR-039](../decisions.md#adr-039--mcp-tool-surface-contract).

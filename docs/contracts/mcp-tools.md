---
name: mcp-tools
description: MCP tool surface — manifest-driven, all read-only over REST, three-part response (NL + structured + confidence/provenance footer), get_dependencies is transitive, project scoping consistent.
governs:
  - "packages/mcp/src/**"
adr: [ADR-039, ADR-091, ADR-102, ADR-132, ADR-198]
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

## Startup endpoint validation (#1069)

Resolution never throws, but the URL it lands on can still be the wrong server: outside any NEAT project, with no `NEAT_CORE_URL`, resolution falls back to `http://localhost:8080` — and if another service happens to hold that port, the tools would silently query it and hand the agent an opaque HTML/404 on every call. So once, at boot (before the MCP handshake), the server probes the resolved URL's `/health` — NEAT's identity signal, `{ ok: true, uptimeMs, … }` JSON, mounted ahead of every project route so a real daemon never 404s it ([`rest-api.md`](./rest-api.md), #343). Three outcomes:

- **NEAT** — `/health` answered with that shape → start normally. The happy path costs one extra loopback GET.
- **foreign** — a real HTTP response that is definitively not NEAT (HTML, a 404, some other JSON) → the server prints an actionable error naming the URL, the resolution source, and the fix (run from inside a NEAT project, or set `NEAT_CORE_URL`), then exits non-zero. A fast, legible failure beats a confusing 404 on every tool call.
- **unreachable** — no HTTP response, or an ambiguous `401` / `403` / `5xx` → start normally. A daemon that is merely slow to boot, or gated behind auth this server lacks the token for, must not be misread as foreign; the per-request path already surfaces a clean, bounded error.

`NEAT_SKIP_ENDPOINT_CHECK=1` bypasses the probe for exotic setups (e.g. a proxy that rewrites `/health`). The check lives in `endpoint-check.ts` and runs from `index.ts`; `base-url.ts` reports which precedence level resolved the URL so the message can be specific. This is the MCP instance of [`client-profiles.md`](./client-profiles.md) §5's rule — a wrong endpoint is reported, never silently used.

## Project scoping

Optional `project?: string`, defaulting to `'default'` per ADR-026. Multi-project routing happens at REST.

## No demo-name hardcoding

`payments-db`, `pg`, `postgresql` allowed only inside Zod `.describe()` strings. Never in branching logic.

## `semantic_search`

Tool description reflects the ADR-025 embedder chain (Ollama → MiniLM → substring), not "keyword search."

## `ask` — the plain-language door (ADR-198)

`ask` is the front door: one natural-language `question`, one compact provenance-tagged answer. It exists so an agent does not have to know *which* structured tool or the *exact node id* before it can reach the graph — that prerequisite is what pushes an agent to grep instead. `ask` calls `GET /graph/ask?q=…`; the core resolves the question to nodes (token/label overlap + the `semantic_search` embedder against node labels) and routes it to the traversals that already exist (root cause, dependencies, observed runtime calls, incidents, divergences, blast radius), leading with `get_root_cause`'s navigation when the question is root-cause-shaped. Deterministic — the engine calls no LLM ([`llm-policy.md`](./llm-policy.md)); the agent that calls `ask` is the only model. The response routes through `formatToolResponse` like every tool: the compact answer is the summary, the composed sections are the block, and the footer carries the aggregate confidence + provenance. The structured tools stay the right reach when a node id is already in hand and only one traversal is wanted.

A broad opening question that names no entity — "give me an overview", "any divergences?", "recent incidents" — is answered graph-wide rather than dead-ending: `overview` returns a system summary, `divergence` runs the divergence query over the whole graph, `incidents` aggregates the incident store across all nodes. The other intents (dependencies / blast-radius / root-cause / observed) need a subject and return naming guidance when none resolves. The result carries an optional `scope` (`'node'` | `'global'`) recording which path answered; `sections` / `primaryNode` are unchanged, so the shape stays back-compatible.

## Stdio only

HTTP / SSE / WebSocket transports remain post-MVP.

## Authority

Read-only. Mutation-authority scan in `contracts.test.ts` enforces this for `packages/mcp/src/`.

Full rationale: [ADR-039](../decisions.md#adr-039--mcp-tool-surface-contract).

---
name: cli-surface
description: Eleven `neat <verb>` commands mirroring the MCP tool allowlist. REST-only data path. Two output modes (human + --json). Exit codes branch on misuse vs server error vs daemon-down.
governs:
  - "packages/core/src/cli.ts"
  - "packages/core/src/cli-verbs.ts"
  - "packages/core/src/cli-client.ts"
  - "packages/core/src/monitor.ts"
  - "packages/core/src/editors-cli.ts"
adr: [ADR-050, ADR-039, ADR-026, ADR-060, ADR-102, ADR-130, ADR-132, ADR-159, ADR-162, ADR-163, ADR-164]
enforcement: [lint, review]
---

# CLI surface contract

The first of two v0.2.8 contracts. Sibling: [`frontend-api.md`](./frontend-api.md).

Closes the terminal-vs-agent gap. Today every reach into the graph goes through MCP. Engineers debugging at a terminal need the same query tools without a Claude wrapper.

## Eleven verbs, locked

```
neat root-cause <node-id>                            ← get_root_cause
neat blast-radius <node-id>                          ← get_blast_radius
neat dependencies <node-id> [--depth N]              ← get_dependencies
neat observed-dependencies <node-id>                 ← get_observed_dependencies
neat incidents [--limit N]                           ← get_incident_history
neat search <query>                                  ← semantic_search
neat diff [--since <date>]                           ← get_graph_diff
neat stale-edges                                     ← get_recent_stale_edges
neat policies [--node <id>] [--hypothetical-action <action>]   ← check_policies
neat divergences [--min-confidence N]                ← get_divergences
neat logs [--source <name>] [--service <name>] [--limit N] [--since <date>]   ← get_logs
```

`divergences` joined the verb set with the divergence query (ADR-060); `logs` joined it with the unified logs surface (ADR-132) — `--source` is repeatable, filtering to one or more of `native | supabase | railway | firebase | cloudflare | vercel`. The verb set is locked the same way the MCP allowlist is locked (ADR-039). Adding a twelfth verb requires a successor ADR.

## Naming convention

- Drop the `get_` prefix.
- Kebab-case.
- Prefer noun verbs (`incidents`, `policies`) over `get-*`.
- Action-flavored only where the noun would be ambiguous (`search`, `diff`).

## REST-only data path

Every verb hits `NEAT_API_URL` (default `http://localhost:8080`) via a shared client. **No `graph.json` reads at request time.** Multi-project routing follows `--project <name>` flag → `NEAT_PROJECT` env → registry resolution (ADR-026).

When neither the flag nor the env is set, the bare verb resolves its target from the daemon's registered projects (`GET /projects`) rather than blindly routing to `'default'` (issue #500 — `npx neat.is` registers under the cwd basename, so no `'default'` slot exists after a one-command run): exactly one registered project is used; a project literally named `'default'` keeps the legacy unprefixed routes; several registered with no `'default'` errors and lists them (exit 2, never a silent pick); none registered errors clearly. A daemon that can't be reached still exits 3 with the "is the daemon running?" message.

The CLI client and the MCP client share the same REST helper module. One endpoint surface, two consumers.

## Profiles and remote mode (ADR-102)

The endpoint every verb hits is the selected **profile's** `endpoint` — `{ endpoint, authToken? }`, the one seam shared with the MCP server and the GUI ([`client-profiles.md`](./client-profiles.md)). Selection precedence: `--profile <name>` / `NEAT_PROFILE` → `NEAT_CORE_URL` (+ `NEAT_AUTH_TOKEN`) → local `neat-out/daemon.json` discovery → loopback default.

A profile may point at a local per-project daemon or a hosted one. The query verbs are **profile-routable**: `neat --profile <hosted> blast-radius …` runs the read/OBSERVED surface against a hosted daemon over a bearer, so an engineer — or an agent during development — queries production NEAT from the terminal. Lifecycle verbs (`init`, `watch`, the bare-`<path>` orchestrator) stay local: they operate on the local filesystem and the local daemon and ignore a remote profile. `neat sync --to <url|profile>` remains the one verb that writes to a remote daemon.

A verb run against an unreachable profile exits `3`, the same as an unreachable local daemon; a selected profile is never silently swapped for a different endpoint.

## Two output modes

**Default (human):** prose summary + plain-text table + `confidence: X.XX · provenance: ...` footer. Mirrors the three-part MCP response from ADR-039 in plain text.

**`--json`:** machine-readable JSON, same three sections as named fields:

```json
{
  "summary": "service:checkout fails because pg@7.4.0 is incompatible with PostgreSQL 15.",
  "block": { ... typed payload ... },
  "confidence": 0.84,
  "provenance": "OBSERVED"
}
```

Stdout for results. Stderr for diagnostics. Never mix the two.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | server error (4xx / 5xx — body's error message goes to stderr) |
| `2` | misuse (missing required arg, malformed flag — handled before any network call) |
| `3` | daemon not reachable (connection refused / timeout) |

`3` is distinct from `1` so scripts can branch on "is the daemon up?" without parsing error text.

## Read-only

Every MCP tool is read-only and so is every CLI verb. Lifecycle commands (`init`, `watch`, `pause`, etc.) keep their existing semantics; mutation never lands behind a query verb.

## `neat monitor` — the live-context stream (ADR-159)

`neat monitor [--project <name>] [--json]` is a lifecycle/config-style verb, alongside `watch` / `connector` / `hooks` / `codex` — **not** a twelfth query verb, so it stays off the locked query allowlist above (which still needs a successor ADR to grow). It is read-only: it composes surface that already exists — the daemon's SSE `/events` bus as the trigger, the REST reads as the context — and computes nothing new.

It resolves the daemon exactly like a query verb (profile / `NEAT_CORE_URL` → local daemon record → loopback) and holds the SSE connection open instead of doing a one-shot read. On a structural trigger it debounces briefly and reads the matching live query, then emits **one human-readable line per new high-signal fact** to stdout. The trigger→read→line pairs (ADR-162 extends the set to the finer grains and the policy query):

- a fresh divergence between declared and observed (`⚠ divergence [<type>] …`, read from `GET /graph/divergences` on an `extraction-complete`, a new OBSERVED `edge-added`, or a `stale-transition`). At **column grain** the line names the drifting column (`orders.amount declared, never observed in production` / `production writes orders.amount — not declared in code`, ADR-157), not just the table;
- an integration that just went stale (`⋯ stale  <src> → <tgt>`, from the `stale-transition` payload);
- a new observed runtime dependency (`+ observed  <src> → <tgt>`, from the OBSERVED `edge-added` payload, gated to the dependency edge types);
- a freshly-tripped **policy violation** (`⚠ policy [<severity>] <policyName> — <message>  (<subject>)`, read from `GET /policies/violations` on a `policy-violation` trigger). This is the soft-guardrail "before you edit" fact (ADR-108) made ambient — deduped on the violation's deterministic id (ADR-043), read authoritatively from the query rather than the event payload.

A seen-set keeps each fact to one line, so the stream stays **silent when nothing is new**. It never fabricates — only facts the graph already computed reach stdout — and an unreachable daemon means a clean exit (code 0) with no output and no stack trace, so the plugin's `monitors/` mechanism reads nothing and the agent hears nothing. `--json` emits one JSON object per line for non-Claude consumers; stdout carries facts, stderr carries diagnostics, never mixed. The SSE taxonomy (eight types, ADR-051) is unchanged, no new REST route is added (the monitor is a REST client of the existing divergence and policy endpoints), and divergence stays a computed query, not a persisted event. Observed-only symbols (ADR-158 §5) are held back until a query surfaces them — the divergence detector excludes symbol-grained buckets by design, so there is no computed set for the monitor to render yet.

## `neat codex` — install NEAT into the OpenAI Codex CLI (ADR-163)

`neat codex [--apply | --print-config | --print-guide]` is a config command family alongside `neat connector` / `neat hooks` — **not** a twelfth query verb, so it stays off the locked query allowlist. It mirrors `neat skill`/`neat hooks` (ADR-145) for a second agent, closing the Codex half of the ADR-159 distribution gap.

Plan by default: with no flag it prints what it would change and writes nothing; `--apply` writes. It does two things, both merges:

- Adds an `[mcp_servers.neat]` table to `~/.codex/config.toml` (Codex's user-level MCP config; a project-scoped `.codex/config.toml` is also read by Codex) — `command = "npx"`, `args = ["-y", "@neat.is/mcp"]`, `env = { NEAT_CORE_URL = "http://localhost:8080" }`, the same invocation and canonical daemon-URL env var the Claude skill writes. The file is parsed with `smol-toml` and only NEAT's own table is spliced in; every other server, key, and comment is preserved, the result is re-verified against the original parse before write, and a re-run writes identical bytes. A malformed existing config is a clear error with **no partial write** — a wrong config stops Codex at startup, worse than none.
- Writes NEAT's agent-agnostic graph-first block (`packages/claude-skill/GRAPH_FIRST.md`, verbatim — the same one `neat hooks --print-guide` emits) into `AGENTS.md` at the project root, delimited by stable `<!-- neat:graph-first -->` … `<!-- /neat:graph-first -->` markers so a re-run replaces only NEAT's block and leaves the user's own instructions intact.

Codex has no equivalent of the Claude Code PreToolUse hook, so the search-nudge is not part of this command; the guidance block is how a Codex agent learns to reach for the graph first. `--print-config` / `--print-guide` print the two artifacts for a manual install.
## `neat cursor` / `neat devin` — install into the VS Code MCP family (ADR-164)

`neat cursor` and `neat devin` are config commands, alongside `skill` / `hooks` / `connector` — **not** query verbs, so they stay off the locked allowlist above and each parses its own argv. Each wires NEAT into one VS Code-family MCP client the way `neat skill` wires it into Claude Code: it writes NEAT's stdio MCP server (`{ "command": "npx", "args": ["-y", "@neat.is/mcp"] }`) into the client's `mcpServers` config, and NEAT's graph-first guidance (`packages/claude-skill/GRAPH_FIRST.md`, the same block `neat hooks` hands out) into the client's rules file. The destinations, verified against each client's docs:

- **Cursor** — MCP config `~/.cursor/mcp.json` (top-level `mcpServers`; project `.cursor/mcp.json` is the same shape); rules file `.cursorrules` at the project root.
- **Devin Desktop (Cascade)** — MCP config `~/.codeium/windsurf/mcp_config.json` (Cognition's successor to Windsurf kept the legacy Codeium path; same top-level `mcpServers`); rules file `.windsurfrules` at the project root — the legacy surface the Cascade agent inherited from Windsurf. Devin's current docs don't re-document an always-on rules file, so the MCP config is the verified half and the guidance write is best-effort (additive, marker-fenced, harmless if a Cascade build ignores it).

Both follow the `neat init` discipline (ADR-046): **plan by default** (print what would change, write nothing), `--apply` to write. The MCP write is **additive** — every other server and top-level key is preserved, only `mcpServers.neat` is set. The guidance is **marker-fenced** (`<!-- neat:graph-first -->` … `<!-- /neat:graph-first -->`) so a re-run replaces only NEAT's block and leaves the rest of the rules file untouched; re-running either verb produces byte-identical files. A malformed existing MCP config is a **hard stop** — the verb names the file to fix and exits non-zero with nothing written, no partial state. The MCP server env override (`NEAT_CORE_URL`) points the client at a non-default daemon, matching `neat skill`.

## No demo-name hardcoding

Same rule as MCP (cross-cutting rule 8). `--help` examples reference real-shape ids (`service:<name>`, `database:<host>`) without committing to specific demo names.

## `--help` is binding documentation

Each verb's `--help` lists args, flags, exit codes, and one example invocation. `neat --help` lists every verb (lifecycle + query) in one block. `--help` text is treated as part of the contract surface — drift between contract and `--help` is a regression.

## Authority

`packages/core/src/cli.ts` extends to dispatch the new verbs. New file `packages/core/src/cli-verbs.ts` for the handlers if the surface gets large. REST client at `packages/core/src/cli-client.ts`, shared with `packages/mcp/src/client.ts`.

## Enforcement

`it.todo` for v0.2.8 #23. Regression tests cover: every verb registered, REST-only data path, exit-code branching, `--json` shape matches the three-part schema, `--project` propagation matches ADR-026.

Full rationale: [ADR-050](../decisions.md#adr-050--cli-surface-contract).

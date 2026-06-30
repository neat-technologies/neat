---
name: cli-surface
description: Ten `neat <verb>` commands mirroring the MCP tool allowlist. REST-only data path. Two output modes (human + --json). Exit codes branch on misuse vs server error vs daemon-down.
governs:
  - "packages/core/src/cli.ts"
  - "packages/core/src/cli-verbs.ts"
  - "packages/core/src/cli-client.ts"
adr: [ADR-050, ADR-039, ADR-026, ADR-060, ADR-102]
enforcement: [lint, review]
---

# CLI surface contract

The first of two v0.2.8 contracts. Sibling: [`frontend-api.md`](./frontend-api.md).

Closes the terminal-vs-agent gap. Today every reach into the graph goes through MCP. Engineers debugging at a terminal need the same query tools without a Claude wrapper.

## Ten verbs, locked

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
```

`divergences` joined the verb set with the divergence query (ADR-060). The verb set is locked the same way the MCP allowlist is locked (ADR-039). Adding an eleventh verb requires a successor ADR.

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

## No demo-name hardcoding

Same rule as MCP (cross-cutting rule 8). `--help` examples reference real-shape ids (`service:<name>`, `database:<host>`) without committing to specific demo names.

## `--help` is binding documentation

Each verb's `--help` lists args, flags, exit codes, and one example invocation. `neat --help` lists every verb (lifecycle + query) in one block. `--help` text is treated as part of the contract surface — drift between contract and `--help` is a regression.

## Authority

`packages/core/src/cli.ts` extends to dispatch the new verbs. New file `packages/core/src/cli-verbs.ts` for the handlers if the surface gets large. REST client at `packages/core/src/cli-client.ts`, shared with `packages/mcp/src/client.ts`.

## Enforcement

`it.todo` for v0.2.8 #23. Regression tests cover: every verb registered, REST-only data path, exit-code branching, `--json` shape matches the three-part schema, `--project` propagation matches ADR-026.

Full rationale: [ADR-050](../decisions.md#adr-050--cli-surface-contract).

# @neat.is/claude-skill

Drop-in MCP config that hooks NEAT's sixteen MCP tools into Claude Code.

See [SKILL.md](./SKILL.md) for the tool list, install steps, and prerequisites.

The shipped artifact is `claude_code_config.json` — a single object you merge into your `~/.claude.json` under `mcpServers.neat`. The `neat skill` CLI verb (in `@neat.is/core`) handles the merge for you.

Alongside the MCP config, this package ships the affordances that make an agent reach for the graph before it grep-scans a repo: a Claude Code search-nudge `PreToolUse` hook (`hooks/neat-search-nudge.mjs`) and agent-agnostic graph-first guidance (`GRAPH_FIRST.md`). `neat hooks --apply` installs both. See [SKILL.md](./SKILL.md#reach-for-the-graph-first).

## Files

- `claude_code_config.json` — the MCP server snippet
- `hooks/neat-search-nudge.mjs` — the Claude Code search-nudge PreToolUse hook
- `GRAPH_FIRST.md` — agent-agnostic graph-first guidance to paste into project instructions
- `SKILL.md` — what the skill exposes and how to install
- `package.json` — workspace metadata; this package ships no compiled code

## When this drifts

If the sixteen MCP tools change shape or the `@neat.is/mcp` package ships a different stdio entrypoint, this snippet needs to keep up. The contract test in `packages/core/test/audits/contracts.test.ts` enforces the snippet shape — `command: 'npx'`, args wired to `@neat.is/mcp`, type `stdio`, plus `NEAT_API_URL` env wired through.

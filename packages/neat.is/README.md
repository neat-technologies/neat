# neat.is

NEAT keeps a live semantic graph of a software system — code, infrastructure, runtime — and exposes it to AI agents over MCP.

## Prerequisites

- **Node.js 20 or newer.** Enforced via `engines`; older versions fail at install.
- **A C toolchain**, because `@neat.is/core` builds native bindings for `tree-sitter` (JS, TS, Python parsers) at install time:
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Debian/Ubuntu: `build-essential` plus `python3` (for `node-gyp`)
  - Alpine: `build-base python3`
  - Windows: Visual Studio Build Tools with the "Desktop development with C++" workload

If `npm install -g neat.is` fails partway through with a `gyp` error, the toolchain is the cause. Install it and re-run.

## Install

```bash
npm install -g neat.is
```

That puts three binaries on your PATH:

- `neat` — CLI (init, watch, list, skill, plus the nine query verbs that mirror the MCP tool surface)
- `neatd` — daemon (start, stop, status, reload)
- `neat-mcp` — MCP stdio server for Claude Code and other agents

## Quick start

```bash
neat init /path/to/your/repo --project myrepo
neatd start
```

Snapshot lands at `<repo>/neat-out/myrepo.json`. The daemon watches for file changes and OTel traces (`:4318` HTTP by default) and keeps the graph live.

## What's in the box

`neat.is` is an umbrella that pulls in:

- [`@neat.is/core`](https://www.npmjs.com/package/@neat.is/core) — graph engine, extractors, REST + OTel ingest
- [`@neat.is/mcp`](https://www.npmjs.com/package/@neat.is/mcp) — MCP server exposing graph queries to agents
- [`@neat.is/claude-skill`](https://www.npmjs.com/package/@neat.is/claude-skill) — drop-in Claude Code skill

## License

Apache License 2.0 — see [LICENSE](https://github.com/neat-technologies/neat/blob/main/LICENSE) in the repository.

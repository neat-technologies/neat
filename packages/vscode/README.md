# NEAT for VS Code

Wire [NEAT](https://neat.is)'s MCP server into your editor, and keep an eye on the
local NEAT daemon from the status bar. That's it — this extension does two small
things and leaves the graph itself to the NEAT dashboard.

NEAT keeps a live semantic graph of your system — static code fused with runtime
behavior — and serves it to your AI agent over MCP. This extension is the wire
into the editor.

## What it does

### Configure the MCP server for this editor

Run **NEAT: Configure MCP server for this editor** from the command palette.

- On **VS Code 1.101+**, NEAT registers itself through the built-in MCP provider
  API. The server (`npx -y @neat.is/mcp`) shows up under the MCP servers view;
  VS Code manages its lifecycle. This is the one-click path.
- On a **fork** — Cursor, Windsurf/Cascade, Kiro — that API isn't available, so
  the command writes the fork's own MCP config file instead. It reuses the
  `neat` CLI (`neat cursor --apply` / `neat devin --apply`) when it's on your
  PATH, and otherwise merges the server into the fork's config directly. Either
  way it **never clobbers** your other MCP servers — it only sets the `neat`
  entry.

"One-click" is literal only on VS Code proper; on the forks it's a config-file
write, and this copy says so.

### Daemon health in the status bar

A status-bar item polls the local daemon's `/health` endpoint and shows whether
it's up and how many nodes the graph holds. Point it at a non-default daemon with
the `neat.daemonUrl` setting, and pass a bearer token with `neat.daemonToken` if
your daemon is gated.

## Settings

| Setting | Default | Description |
|---|---|---|
| `neat.daemonUrl` | `http://127.0.0.1:8080` | Base URL of the local NEAT daemon's REST API. |
| `neat.daemonToken` | _(empty)_ | Optional bearer token for a gated daemon. |

## What it deliberately doesn't do

No in-editor graph rendering, no per-file CodeLens or diagnostics, no commands
that just re-expose MCP tools your agent already calls. The dashboard in the NEAT
web app owns the graph surface. This extension is thin on purpose.

## Requirements

You'll want NEAT running locally — `npx neat.is` in your project starts the
daemon. See [neat.is](https://neat.is).

## License

Apache-2.0.

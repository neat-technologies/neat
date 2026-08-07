# Changelog

## 0.1.0

First release. Two things:

- **Configure MCP server for this editor.** Registers `@neat.is/mcp` through the
  native MCP provider API on VS Code 1.101+, and writes the fork's own MCP config
  file on Cursor, Windsurf/Cascade, and Kiro — reusing the `neat` CLI when it's on
  PATH, merging directly otherwise, and never overwriting your other MCP servers.
- **Daemon-health status bar.** Polls the local NEAT daemon's `/health` and shows
  whether it's up and how many nodes the graph holds. Configurable daemon URL and
  optional bearer token.

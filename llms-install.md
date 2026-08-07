# Installing the NEAT MCP server

This guide is written for an AI agent setting up NEAT's MCP server on a user's machine. Follow it in order.

## What you're installing

NEAT keeps a live semantic graph of the user's software system — static code fused with runtime OpenTelemetry behavior — and serves it over MCP as `@neat.is/mcp`. That MCP server is a **bridge to a local NEAT daemon**: it answers from the daemon's graph and has nothing to serve on its own. So you must start the daemon before the MCP server is useful. Installing the server without a running daemon will connect to nothing and every tool call will fail — this is the most common install mistake.

## Steps

1. **Install the CLI.**

   ```bash
   npm install -g neat.is
   ```

   This puts `neat`, `neatd`, and `neat-mcp` on PATH. (No global install is fine too — substitute `npx neat.is` for `neat` below and `npx -y @neat.is/mcp` for `neat-mcp`.)

2. **Start NEAT in the user's project.** From the project root:

   ```bash
   neat .
   ```

   This extracts the static graph, wires in OpenTelemetry, and starts the daemon on `http://localhost:8080`. It writes `neat-out/daemon.json` in the project. Confirm the daemon is up:

   ```bash
   curl -s http://localhost:8080/health
   ```

   Leave the daemon running. The `OBSERVED` layer fills in once the user runs their app.

3. **Register the MCP server** in the client's config. Use `NEAT_CORE_URL` so resolution doesn't depend on the directory the client launches the server from:

   ```json
   {
     "mcpServers": {
       "neat": {
         "command": "npx",
         "args": ["-y", "@neat.is/mcp"],
         "env": { "NEAT_CORE_URL": "http://localhost:8080" }
       }
     }
   }
   ```

   If the CLI was installed globally, `"command": "neat-mcp"` (no `args`) is equivalent.

4. **Verify.** Ask the server for something small — call `get_dependencies` or `semantic_search`. A connection error means the daemon from step 2 isn't running; start it again before continuing.

## Notes

- The server reads `NEAT_CORE_URL` (or the `NEAT_API_URL` alias) to find the daemon; without it, it walks up from the working directory to the nearest `neat-out/daemon.json`, then falls back to `http://localhost:8080`.
- Every tool result carries a provenance — `OBSERVED`, `INFERRED`, `EXTRACTED`, or `STALE` — and a confidence. Surface those to the user; they say how far to trust each fact.
- Full tool list and details: [`packages/mcp/README.md`](./packages/mcp/README.md).

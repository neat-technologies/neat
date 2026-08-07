// The NEAT MCP server entry, and the merge that wires it into a fork's config
// without disturbing anything else.
//
// The stdio shape is the exact one the CLI already writes (see
// `packages/core/src/editors-cli.ts` — `NEAT_MCP_SERVER`): `npx -y @neat.is/mcp`
// with no env by default, since the server falls back to the local daemon at
// http://127.0.0.1:8080 and reads `NEAT_CORE_URL` to reach a non-default one.
// When the user points the extension at a non-default daemon we pin that URL
// through the same `NEAT_CORE_URL` env the CLI documents.
//
// Pure module: no `vscode` import, so the merge unit-tests directly.

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:8080'

// The minimal server object, matching `NEAT_MCP_SERVER` in the CLI byte-for-byte
// for the default case.
export interface NeatServerEntry {
  command: 'npx'
  args: string[]
  env?: Record<string, string>
}

// Build the server entry. Includes `env.NEAT_CORE_URL` only when the configured
// daemon URL differs from the default the MCP server already assumes — so the
// default case stays identical to what `neat cursor` / `neat devin` write.
export function neatServerEntry(daemonUrl?: string): NeatServerEntry {
  const entry: NeatServerEntry = { command: 'npx', args: ['-y', '@neat.is/mcp'] }
  const url = (daemonUrl ?? '').trim()
  if (url.length > 0 && url !== DEFAULT_DAEMON_URL) {
    entry.env = { NEAT_CORE_URL: url }
  }
  return entry
}

export interface McpConfigFile {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

// MERGE-NEVER-CLOBBER. Spread the existing config, spread its existing
// `mcpServers`, and set only the `neat` key. Every other server the user wired
// by hand and every other top-level key survive untouched. `changed` is false
// when the `neat` entry already matches, so a re-run is a clean no-op — the same
// contract `mergeMcpConfig` keeps in `packages/core/src/editors-cli.ts`.
export function mergeForkMcpConfig(
  existing: McpConfigFile,
  server: NeatServerEntry,
): { merged: McpConfigFile; changed: boolean } {
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>
  const already = JSON.stringify(servers.neat) === JSON.stringify(server)
  const merged: McpConfigFile = {
    ...existing,
    mcpServers: { ...servers, neat: server },
  }
  return { merged, changed: !already }
}

// Resolve the daemon URL the MCP server talks to.
//
// `NEAT_CORE_URL` is the canonical name (the README and the MCP server both use
// it). `NEAT_API_URL` is honored as an accepted alias so configs written by
// older `neat skill` versions — which emitted `NEAT_API_URL` — still reach the
// daemon (#488). `NEAT_CORE_URL` wins when both are set. Neither set falls back
// to the loopback default. Lives in its own module so the resolution is
// testable without importing index.ts, which starts the stdio transport on load.
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.NEAT_CORE_URL ?? env.NEAT_API_URL ?? 'http://localhost:8080'
}

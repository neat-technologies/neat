// The tool registry: the one shape every family declares its tools in, so
// index.ts registers them in a single loop instead of 28 hand-written call
// sites. Adding a tool is one `defineTool({...})` entry in its family module;
// the manifest in @neat.is/types (ADR-091) and the contracts audit still gate
// the set.

import { z } from 'zod'
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MCPToolName } from '@neat.is/types'
import type { HttpClient } from '../client.js'
import type { ConnectorDeps } from '../connectors.js'

// What a tool's handler needs at registration time, assembled once per server.
// The graph tools read `client`/`projectFor`; the hosted connector tools read
// `connectorDeps` (the control plane) instead.
export interface ToolContext {
  client: HttpClient
  projectFor: (input: { project?: string }) => string | undefined
  connectorDeps: ConnectorDeps | null
}

// One registered tool, as data. `build` closes over the context to produce the
// MCP callback, so a family declares the tool without holding the live client.
export interface ToolDef {
  name: MCPToolName
  description: string
  schema: z.ZodRawShape
  build: (ctx: ToolContext) => ToolCallback<z.ZodRawShape>
}

// Each tool fixes its own schema shape, so defineTool is generic over it: inside
// one call, `schema` and the `build` callback's input are checked against the
// same Args. The result widens to ToolDef so a heterogeneous set of tools lives
// in one array behind one registration loop.
export function defineTool<Args extends z.ZodRawShape>(def: {
  name: MCPToolName
  description: string
  schema: Args
  build: (ctx: ToolContext) => ToolCallback<Args>
}): ToolDef {
  return def as unknown as ToolDef
}

// The project arg every graph tool carries. Shared so each family's schema reads
// the same, and the one description stays single-sourced.
export const projectField = z
  .string()
  .optional()
  .describe(
    'Project name when the core hosts more than one (set NEAT_PROJECTS=...). Omit to use the default project.',
  )

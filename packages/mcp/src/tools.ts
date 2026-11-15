// Barrel for the MCP tool implementations. The handlers are split into
// per-family modules under ./tools/ (ADR-039 / mcp-tools.md): investigation,
// navigation, policy, instrumentation, security, connect, plus the shared infra
// helpers and the registry. This file re-exports them under one path so existing
// consumers — the test suites and index.ts — resolve through `./tools.js`, and
// assembles the full registered set so index.ts registers it in one loop.
// Adding a tool is one defineTool({...}) entry in one family module.

import { investigationTools } from './tools/investigation.js'
import { navigationTools } from './tools/navigation.js'
import { policyTools } from './tools/policy.js'
import { instrumentationTools } from './tools/instrumentation.js'
import { securityTools } from './tools/security.js'
import { connectTools } from './tools/connect.js'
import type { ToolDef } from './tools/registry.js'

export type { ToolResponse } from './format.js'
export type { ToolContext, ToolDef } from './tools/registry.js'

export * from './tools/shared.js'
export * from './tools/investigation.js'
export * from './tools/navigation.js'
export * from './tools/policy.js'
export * from './tools/instrumentation.js'
export * from './tools/security.js'
export * from './tools/connect.js'

// The full registered set — the MCP_TOOL_NAMES manifest (ADR-091). index.ts
// loops over this and skips any name a lean session hides (session-surface.ts),
// so the registration site is one loop rather than 28 hand-written calls.
export const allTools: ToolDef[] = [
  ...investigationTools,
  ...navigationTools,
  ...policyTools,
  ...instrumentationTools,
  ...securityTools,
  ...connectTools,
]

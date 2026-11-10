// #1610 — the lean session switches, end to end through the built server.
//
// A stand-in daemon holds a live incident, so the default server prepends the
// ADR-260 session-start lead to its instructions. With NEAT_SESSION_LEAD=0 the
// instructions are the static protocol alone, byte-identical to the default's
// minus the lead, which is what lets a client's prompt cache reuse them across
// sessions. With NEAT_MCP_TOOLS=core, tools/list is the manifest minus the
// extend and connector groups.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MCP_TOOL_NAMES } from '@neat.is/types'
import { hiddenTools } from '../src/session-surface.js'

const here = dirname(fileURLToPath(import.meta.url))
const serverEntry = join(here, '..', 'dist', 'index.cjs')

let daemon: Server
let coreUrl: string

beforeAll(async () => {
  daemon = createServer((req, res) => {
    if (req.url?.startsWith('/incidents/lead')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ranked: [{ node: 'service:checkout', kind: 'error' }] }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((r) => daemon.listen(0, '127.0.0.1', r))
  coreUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((r) => daemon.close(r))
})

async function session(extraEnv: Record<string, string>): Promise<{ instructions: string; tools: string[] }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.NEAT_SESSION_LEAD
  delete env.NEAT_MCP_TOOLS
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...env, NEAT_CORE_URL: coreUrl, NEAT_RESOURCE_POLL_MS: '0', NEAT_SKIP_ENDPOINT_CHECK: '1', ...extraEnv },
    stderr: 'inherit',
  })
  const client = new Client({ name: 'neat-lean-session', version: '0.0.0' })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    return { instructions: client.getInstructions() ?? '', tools: tools.map((t) => t.name).sort() }
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
  }
}

describe('lean session switches through the built server', () => {
  it('by default the live incident leads the instructions and every tool registers', async () => {
    const s = await session({})
    expect(s.instructions.startsWith('NEAT has a live incident on service:checkout')).toBe(true)
    expect(s.tools).toEqual([...MCP_TOOL_NAMES].sort())
  }, 20_000)

  it('NEAT_SESSION_LEAD=0 gives the static instructions alone, identical to the default minus the lead', async () => {
    const lead = await session({})
    const lean = await session({ NEAT_SESSION_LEAD: '0' })
    expect(lean.instructions).not.toContain('live incident')
    expect(lead.instructions.endsWith(`\n\n${lean.instructions}`)).toBe(true)
    const again = await session({ NEAT_SESSION_LEAD: '0' })
    expect(again.instructions).toBe(lean.instructions)
  }, 30_000)

  it('NEAT_MCP_TOOLS=core lists the manifest minus the extend and connector tools', async () => {
    const s = await session({ NEAT_MCP_TOOLS: 'core' })
    const hidden = hiddenTools({ NEAT_MCP_TOOLS: 'core' })
    expect(s.tools).toEqual(MCP_TOOL_NAMES.filter((n) => !hidden.has(n)).sort())
  }, 20_000)
})

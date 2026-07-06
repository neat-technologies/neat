// One live stdio smoke for the MCP server. Everything above this file unit-
// tests the tool wrappers against a stubbed HttpClient; nothing actually
// cold-starts the built server and speaks JSON-RPC over a pipe. This does.
//
// It spawns the built `dist/index.cjs` with @modelcontextprotocol/sdk's Client
// over a StdioClientTransport, runs the real initialize handshake, asserts
// tools/list returns every name in MCP_TOOL_NAMES, and chains two tools/call
// requests to prove the wrappers execute end-to-end through the registration.
//
// It deliberately does NOT stand up a real neat-core daemon. A live daemon is
// the flakiest thing we could put in an unattended test — port races, snapshot
// I/O, slow boot, zombie processes. Instead NEAT_CORE_URL is pinned at a closed
// loopback port, so the server boots cleanly (resolveBaseUrl just takes the env
// override) and each tools/call drives the wrapper all the way to the HTTP fetch
// — which fails connecting and comes back as a formatted isError ToolResponse.
// That proves the registration, argument plumbing, and error-formatting path
// without the daemon's operational surface. The data-formatting happy paths are
// covered exhaustively by the stubbed-client unit tests in tools.test.ts.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MCP_TOOL_NAMES } from '@neat.is/types'

const here = dirname(fileURLToPath(import.meta.url))
const serverEntry = join(here, '..', 'dist', 'index.cjs')

// A loopback port nothing is listening on. The MCP server boots fine — it only
// resolves the URL — and every tools/call fails its fetch against this, which is
// exactly the "wrapper ran, core unreachable" signal we want to assert.
const DEAD_CORE_URL = 'http://127.0.0.1:1'

let client: Client
let transport: StdioClientTransport

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      NEAT_CORE_URL: DEAD_CORE_URL,
      // Keep the incidents-resource poller from firing against the dead port on
      // a timer for the life of the test.
      NEAT_RESOURCE_POLL_MS: '0',
    },
    // Surface the child's stderr if it crashes on boot instead of swallowing it.
    stderr: 'inherit',
  })
  client = new Client({ name: 'neat-stdio-smoke', version: '0.0.0' })
  // connect() runs the initialize handshake. The SDK rejects if the child never
  // speaks, so a hung boot fails the test rather than hanging the suite.
  await client.connect(transport)
}, 20_000)

afterAll(async () => {
  // close() ends the transport and kills the spawned child. Guarded so a failed
  // beforeAll doesn't mask the real error with an undefined deref.
  await client?.close().catch(() => {})
  await transport?.close().catch(() => {})
})

describe('MCP server stdio smoke', () => {
  it('completes initialize and reports server info', () => {
    const info = client.getServerVersion()
    expect(info?.name).toBe('neat')
  })

  it('lists exactly the manifest tool surface (all 17 names)', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...MCP_TOOL_NAMES].sort())
    // The manifest is 17 today (eleven read tools + six extend tools).
    expect(names).toHaveLength(17)
  })

  it('drives a read wrapper to the core and surfaces the unreachable core as isError', async () => {
    // get_root_cause runs through the same registration → wrapper → HttpClient
    // path the real tool uses. With the core at a dead port the fetch fails and
    // the wrapper returns a formatted error rather than throwing — that round
    // trip is the thing this smoke proves.
    const res = await client.callTool({
      name: 'get_root_cause',
      arguments: { errorNode: 'database:payments-db' },
    })
    expect(res.isError).toBe(true)
    const text = (res.content as { type: string; text: string }[])[0].text
    expect(text).toContain('Error talking to neat-core')
  })

  it('drives an extend wrapper the same way', async () => {
    const res = await client.callTool({
      name: 'neat_list_uninstrumented',
      arguments: {},
    })
    expect(res.isError).toBe(true)
    const text = (res.content as { type: string; text: string }[])[0].text
    expect(text).toContain('Error talking to neat-core')
  })
})

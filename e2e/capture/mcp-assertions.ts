#!/usr/bin/env tsx
// The MCP-surface mirror of assertions.ts (issue #789).
//
// assertions.ts proves the capture facts land in the graph and reads them over
// REST. Nothing drove the MCP tool surface — the thing agents actually query —
// against a live daemon. The one existing MCP live test (packages/mcp/test/
// stdio-smoke.test.ts) deliberately pins NEAT_CORE_URL at a dead loopback port,
// so it only ever proves "wrapper ran, core unreachable → clean isError." The
// happy path — a tool call reaching a real daemon and coming back with real
// graph facts — was untested end to end.
//
// This closes that gap. It spawns the *built* MCP server (packages/mcp/dist/
// index.cjs) over StdioClientTransport with NEAT_CORE_URL pointed at the live
// capture daemon and NEAT_DEFAULT_PROJECT pinned to the capture project, runs
// the initialize handshake, and drives four tools against known capture nodes:
//
//   get_observed_dependencies — the load-bearing one: the same file-first
//     OBSERVED facts assertions.ts checks over REST, now surfaced through the
//     tool an agent calls (file-grained edges, OBSERVED provenance footer).
//   get_dependencies          — the transitive walk (service ─CONTAINS▶ file
//     ─CALLS/CONNECTS_TO▶ target) reaches the file-grained targets.
//   get_root_cause            — round-trips to the LIVE core (never the
//     "can't reach neat-core" error the dead-port unit smoke asserts).
//   get_divergences           — round-trips and returns a real divergence
//     verdict from the fused graph.
//
// OBSERVED edges land async, so a discovery phase polls the graph (same budget
// as assertions.ts) to learn the real target ids before it drives the tools —
// the node names the ingest mints aren't hardcodeable, exactly as assertions.ts
// works from prefixes rather than fixed ids.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const NEAT_BASE = process.env.NEAT_BASE ?? 'http://localhost:8080'
const PROJECT = process.env.CAPTURE_PROJECT ?? 'app'
const SERVICE = process.env.CAPTURE_SERVICE ?? 'neat-capture-app'
const TIMEOUT_MS = Number.parseInt(
  process.env.MCP_ASSERT_TIMEOUT_MS ?? process.env.ASSERT_TIMEOUT_MS ?? '30000',
  10,
)
const POLL_INTERVAL_MS = 1000

const SERVICE_ID = `service:${SERVICE}`
const FILE_PREFIX = `file:${SERVICE}:`
// The outbound edge types the capture tiers produce: fetch/http/aws land CALLS
// toward a frontier/service; pg/prisma land CONNECTS_TO toward a database.
const OUTBOUND_TYPES = new Set(['CALLS', 'CONNECTS_TO'])

const here = dirname(fileURLToPath(import.meta.url))
// e2e/capture/mcp-assertions.ts → repo root is two up; the built server the MCP
// clients out there actually run is packages/mcp/dist/index.cjs.
const serverEntry = join(here, '..', '..', 'packages', 'mcp', 'dist', 'index.cjs')

type GraphEdge = {
  id: string
  source: string
  target: string
  type: string
  provenance: string
}
type GraphNode = { id: string; type: string }
type Graph = { nodes: GraphNode[]; edges: GraphEdge[] }

// The MCP CallToolResult shape we read: an array of typed content parts plus an
// optional isError flag. We only need the text parts.
type ToolContent = { type: string; text?: string }[]

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function fail(message: string): never {
  console.error(`[mcp-assert] FAIL: ${message}`)
  process.exit(1)
}

async function fetchGraph(): Promise<Graph> {
  const r = await fetch(`${NEAT_BASE}/projects/${PROJECT}/graph`)
  if (!r.ok) throw new Error(`GET /projects/${PROJECT}/graph → ${r.status}`)
  return (await r.json()) as Graph
}

function fileGrainedObserved(graph: Graph): GraphEdge[] {
  return graph.edges.filter(
    (e) =>
      e.provenance === 'OBSERVED' &&
      OUTBOUND_TYPES.has(e.type) &&
      e.source.startsWith(FILE_PREFIX),
  )
}

interface CaptureFacts {
  dbTarget: string
  callTarget: string
}

// Discovery phase — learn the real target ids from the live graph before we
// drive the tools. Polls to the same budget assertions.ts uses because the
// off-stack tiers (fetch, prisma) are the slowest OBSERVED edges to land.
async function discoverFacts(): Promise<CaptureFacts> {
  const deadline = Date.now() + TIMEOUT_MS
  let dbEdge: GraphEdge | undefined
  let callEdge: GraphEdge | undefined
  while (Date.now() < deadline) {
    try {
      const grained = fileGrainedObserved(await fetchGraph())
      dbEdge = grained.find((e) => e.type === 'CONNECTS_TO')
      callEdge = grained.find((e) => e.type === 'CALLS')
      // Wait for both tiers, mirroring assertions.ts's DB-tier + call-tier gate.
      if (dbEdge && callEdge) break
    } catch (err) {
      console.error(`[mcp-assert] discovery poll (will retry): ${(err as Error).message}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  if (!dbEdge || !callEdge) {
    fail(
      `did not observe both a file-grained CONNECTS_TO and a CALLS edge from ${SERVICE_ID} ` +
        `within ${TIMEOUT_MS}ms — is the capture app up and the load driver run? ` +
        `(this is the same precondition assertions.ts needs)`,
    )
  }
  return { dbTarget: dbEdge.target, callTarget: callEdge.target }
}

function toolText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as ToolContent)
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const res = await client.callTool({ name, arguments: args })
  return { isError: res.isError === true, text: toolText(res.content) }
}

// 1 — get_observed_dependencies on the service node. The load-bearing mirror:
// the same file-first OBSERVED facts assertions.ts verifies over REST, now read
// through the tool an agent calls. Retries within the budget in case the MCP
// read trails the raw graph fetch by a beat.
async function assertObservedDeps(client: Client, facts: CaptureFacts): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    const { isError, text } = await callTool(client, 'get_observed_dependencies', {
      nodeId: SERVICE_ID,
    })
    last = text
    // Against a live core an isError here is a real failure, not the expected
    // unreachable-core signal the dead-port smoke asserts.
    if (isError) {
      fail(`get_observed_dependencies returned isError against the live core:\n${text}`)
    }
    const fileFirst = text.includes(`via ${FILE_PREFIX}`)
    const provOk = text.includes('provenance: OBSERVED')
    const namesTargets = text.includes(facts.dbTarget) && text.includes(facts.callTarget)
    const confirmed = text.includes('confirmed by OTel')
    if (fileFirst && provOk && namesTargets && confirmed) {
      console.log(
        '[mcp-assert] get_observed_dependencies OK — file-grained OBSERVED deps, ' +
          `names ${facts.dbTarget} + ${facts.callTarget}`,
      )
      return
    }
    await sleep(POLL_INTERVAL_MS)
  }
  fail(
    `get_observed_dependencies never surfaced file-grained OBSERVED deps naming ` +
      `${facts.dbTarget} + ${facts.callTarget} within ${TIMEOUT_MS}ms. last response:\n${last}`,
  )
}

// 2 — get_dependencies transitively. The walk goes service ─CONTAINS▶ file
// ─CALLS/CONNECTS_TO▶ target, so both file-grained targets must surface as
// dependencies of the service.
async function assertDependencies(client: Client, facts: CaptureFacts): Promise<void> {
  const { isError, text } = await callTool(client, 'get_dependencies', {
    nodeId: SERVICE_ID,
    depth: 3,
  })
  if (isError) {
    fail(`get_dependencies returned isError against the live core:\n${text}`)
  }
  if (text.includes('has no dependencies')) {
    fail(
      `get_dependencies(${SERVICE_ID}) reported no dependencies — the transitive walk ` +
        `should reach the file-grained targets. response:\n${text}`,
    )
  }
  const missing = [facts.dbTarget, facts.callTarget].filter((t) => !text.includes(t))
  if (missing.length > 0) {
    fail(
      `get_dependencies(${SERVICE_ID}) did not reach: ${missing.join(', ')}. response:\n${text}`,
    )
  }
  console.log('[mcp-assert] get_dependencies OK — transitive walk reached both file-grained targets')
}

// 3 — get_root_cause round-trips to the LIVE core. We can't guarantee an
// incident exists, so the guaranteed fact is the live round-trip: against a real
// daemon this must never be the "can't reach neat-core" error the dead-port unit
// smoke asserts. It is either a real root-cause report or the clean "no root
// cause" for a healthy node — both prove the wrapper reached a real core.
async function assertRootCause(client: Client): Promise<void> {
  const { text } = await callTool(client, 'get_root_cause', { errorNode: SERVICE_ID })
  if (text.includes('Error talking to neat-core')) {
    fail(`get_root_cause could not reach the live core:\n${text}`)
  }
  const realShape = text.includes('Root cause for') || text.includes('No root cause found')
  if (!realShape) {
    fail(`get_root_cause returned an unexpected shape from the live core:\n${text}`)
  }
  console.log('[mcp-assert] get_root_cause OK — live round-trip against the real core')
}

// 4 — get_divergences round-trips and returns a real divergence verdict from the
// fused graph (either "Found N divergences…" or the clean "No divergences
// found…"), never the unreachable-core error.
async function assertDivergences(client: Client): Promise<void> {
  const { text } = await callTool(client, 'get_divergences', {})
  if (text.includes('Error talking to neat-core')) {
    fail(`get_divergences could not reach the live core:\n${text}`)
  }
  if (!text.includes('divergence')) {
    fail(`get_divergences returned an unexpected shape from the live core:\n${text}`)
  }
  console.log('[mcp-assert] get_divergences OK — live round-trip returned a real verdict')
}

async function main(): Promise<void> {
  if (!existsSync(serverEntry)) {
    fail(`built MCP server missing at ${serverEntry} — run \`npx turbo build\` first`)
  }

  console.log(`[mcp-assert] discovering capture facts from ${NEAT_BASE}/projects/${PROJECT}/graph`)
  const facts = await discoverFacts()
  console.log(
    `[mcp-assert] ground truth: db target ${facts.dbTarget}, call target ${facts.callTarget}`,
  )

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      // Pin the MCP server at the live capture daemon + project (base-url.ts
      // takes NEAT_CORE_URL outright; index.ts reads NEAT_DEFAULT_PROJECT).
      NEAT_CORE_URL: NEAT_BASE,
      NEAT_DEFAULT_PROJECT: PROJECT,
      // Don't let the incidents-resource poller fire on a timer for the run.
      NEAT_RESOURCE_POLL_MS: '0',
    },
    // Surface the child's stderr if it crashes on boot instead of swallowing it.
    stderr: 'inherit',
  })
  const client = new Client({ name: 'neat-capture-mcp-assert', version: '0.0.0' })

  try {
    // connect() runs the initialize handshake; the SDK rejects if the child
    // never speaks, so a hung boot fails here rather than hanging the harness.
    await client.connect(transport)

    // Handshake sanity — the four tools we drive must be on the surface.
    const { tools } = await client.listTools()
    const names = new Set(tools.map((t) => t.name))
    for (const need of [
      'get_dependencies',
      'get_observed_dependencies',
      'get_root_cause',
      'get_divergences',
    ]) {
      if (!names.has(need)) {
        fail(`MCP server did not register ${need} (surface: ${[...names].sort().join(', ')})`)
      }
    }

    await assertObservedDeps(client, facts)
    await assertDependencies(client, facts)
    await assertRootCause(client)
    await assertDivergences(client)

    console.log('[mcp-assert] OK — all four tools returned live capture facts over the MCP surface')
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('[mcp-assert] fatal:', err)
  process.exit(1)
})

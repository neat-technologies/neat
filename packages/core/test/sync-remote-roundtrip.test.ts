import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApi } from '../src/api.js'
import { resetGraph, getGraph } from '../src/graph.js'
import { Projects, pathsForProject } from '../src/projects.js'
import { addProject } from '../src/registry.js'
import { runSync } from '../src/cli-verbs.js'

// Issue #534 — `neat sync --to <url>` is the one sync branch with no
// integration coverage: runSync (remote mode) → pushSnapshotToRemote → POST
// /projects/:project/snapshot → mergeSnapshot on the receiving daemon. The
// contracts audit only string-matches the source. These tests stand up a real
// listening daemon on a loopback port, register a matching project in an
// isolated NEAT_HOME, run the real verb against a small on-disk fixture, and
// assert the snapshot actually merged into the daemon's live graph.

const PROJECT = 'roundtrip-fixture'

// Daemon graph key kept distinct from the project name so the daemon's
// in-memory graph never aliases the one runSync builds locally during
// extraction (both share this test's module-level graph map).
const DAEMON_GRAPH_KEY = 'roundtrip-daemon'

interface Harness {
  app: FastifyInstance
  baseUrl: string
  neatHome: string
  projectDir: string
}

// Write a tiny but real project: a service package with two source files.
// The full discovery + extraction pipeline turns this into a ServiceNode,
// FileNodes, and CONTAINS edges — enough nodes and edges to prove the merge
// moved real graph content, not an empty payload.
async function writeFixture(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: PROJECT, version: '1.0.0', main: 'index.ts' }, null, 2),
  )
  await fs.writeFile(
    path.join(dir, 'index.ts'),
    "import { greet } from './greet.js'\n\nexport function main(): string {\n  return greet('world')\n}\n",
  )
  await fs.writeFile(
    path.join(dir, 'greet.ts'),
    "export function greet(name: string): string {\n  return `hello ${name}`\n}\n",
  )
}

async function standUp(): Promise<Harness> {
  const neatHome = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-sync-home-'))
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-sync-proj-'))
  await writeFixture(projectDir)

  // The daemon starts with an empty graph for this project so the post-merge
  // node/edge counts equal exactly what the snapshot carried.
  resetGraph(DAEMON_GRAPH_KEY)
  const daemonGraph = getGraph(DAEMON_GRAPH_KEY)
  expect(daemonGraph.order).toBe(0)

  const registry = new Projects()
  registry.set(PROJECT, {
    graph: daemonGraph,
    paths: pathsForProject(PROJECT, path.join(projectDir, 'neat-out')),
  })

  const app = await buildApi({ projects: registry })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const addr = app.server.address()
  if (!addr || typeof addr === 'string') throw new Error('no listen address')
  const baseUrl = `http://127.0.0.1:${addr.port}`

  return { app, baseUrl, neatHome, projectDir }
}

async function tearDown(harness: Harness | undefined): Promise<void> {
  if (!harness) return
  await harness.app.close()
  await fs.rm(harness.neatHome, { recursive: true, force: true })
  await fs.rm(harness.projectDir, { recursive: true, force: true })
  resetGraph(DAEMON_GRAPH_KEY)
}

interface SerializedGraph {
  nodes: Array<{ type?: string; name?: string }>
  edges: Array<unknown>
}

async function fetchGraph(baseUrl: string): Promise<SerializedGraph> {
  const res = await fetch(`${baseUrl}/projects/${PROJECT}/graph`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`GET /graph returned ${res.status}`)
  return (await res.json()) as SerializedGraph
}

describe('neat sync --to <url> remote round-trip (#534)', () => {
  let prevHome: string | undefined
  let prevFloor: string | undefined
  let harness: Harness | undefined
  const prevLog = console.log
  const prevErr = console.error

  beforeEach(() => {
    prevHome = process.env.NEAT_HOME
    prevFloor = process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    process.env.NEAT_EXTRACTED_PRECISION_FLOOR = '0'
    // Quiet the verb's stdout/stderr; the assertions read the returned result.
    console.log = () => {}
    console.error = () => {}
    harness = undefined
  })

  afterEach(async () => {
    console.log = prevLog
    console.error = prevErr
    await tearDown(harness)
    if (prevHome === undefined) delete process.env.NEAT_HOME
    else process.env.NEAT_HOME = prevHome
    if (prevFloor === undefined) delete process.env.NEAT_EXTRACTED_PRECISION_FLOOR
    else process.env.NEAT_EXTRACTED_PRECISION_FLOOR = prevFloor
  })

  it('pushes the extracted snapshot and it merges into the daemon graph', async () => {
    harness = await standUp()
    process.env.NEAT_HOME = harness.neatHome
    await addProject({ name: PROJECT, path: harness.projectDir, languages: ['typescript'] })

    const result = await runSync({
      project: PROJECT,
      to: harness.baseUrl,
      dryRun: false,
      noInstrument: true,
      json: false,
    })

    // The remote branch reports a clean push.
    expect(result.exitCode).toBe(0)
    expect(result.mode).toBe('remote')
    expect(result.daemon).toBe('remote-ok')

    // Extraction produced real graph content.
    expect(result.nodesAdded).toBeGreaterThan(0)
    expect(result.edgesAdded).toBeGreaterThan(0)

    // The daemon's live graph gained exactly that content — proof mergeSnapshot
    // ran on the receiving side, not just that the POST returned 200.
    const graph = await fetchGraph(harness.baseUrl)
    expect(graph.nodes.length).toBe(result.nodesAdded)
    expect(graph.edges.length).toBe(result.edgesAdded)

    // The service the fixture declares is present in the merged graph.
    expect(
      graph.nodes.some((n) => n.type === 'ServiceNode' && n.name === PROJECT),
    ).toBe(true)
  })

  it('exits non-zero without merging when the remote daemon is unreachable', async () => {
    // Stand up only to reserve an isolated NEAT_HOME + fixture, then close the
    // daemon so the push connects to a dead port.
    harness = await standUp()
    process.env.NEAT_HOME = harness.neatHome
    await addProject({ name: PROJECT, path: harness.projectDir, languages: ['typescript'] })
    const deadUrl = harness.baseUrl
    await harness.app.close()

    const result = await runSync({
      project: PROJECT,
      to: deadUrl,
      dryRun: false,
      noInstrument: true,
      json: false,
    })

    // A transport failure on the remote branch is exit 3; the daemon state
    // falls back to skipped and no merge happened.
    expect(result.exitCode).toBe(3)
    expect(result.mode).toBe('remote')
    expect(result.daemon).toBe('skipped')
  })

  it('surfaces a non-success exit when pointed at a bad URL', async () => {
    harness = await standUp()
    process.env.NEAT_HOME = harness.neatHome
    await addProject({ name: PROJECT, path: harness.projectDir, languages: ['typescript'] })

    const result = await runSync({
      project: PROJECT,
      to: 'http://127.0.0.1:1/nope',
      dryRun: false,
      noInstrument: true,
      json: false,
    })

    // Whatever the failure mode, the verb never reports a successful push.
    expect(result.daemon).not.toBe('remote-ok')
    expect(result.exitCode).not.toBe(0)
  })
})

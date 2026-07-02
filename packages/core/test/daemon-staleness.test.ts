import { describe, it, expect, afterEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { EdgeType, type GraphEdge, NodeType, Provenance } from '@neat.is/types'
import { readStaleEvents } from '../src/ingest.js'

// Issue #532. The OBSERVED→STALE clock-decay lives in ingest.ts
// (markStaleEdges + startStalenessLoop) and, until now, only ran under the
// legacy dev server and `neat watch`. The shipped `npx neat.is` path routes
// through the per-project daemon (daemon.ts#bootstrapProject), which built
// slots without starting the staleness loop — so on a running daemon OBSERVED
// edges sat live forever once traffic quieted, and STALE never activated.
//
// These tests exercise the daemon path directly: a bootstrapped slot's graph
// must decay an OBSERVED edge past its threshold to STALE on the loop's tick,
// the transition must land in that slot's stale-events.ndjson (where the REST
// `/stale-events` route reads it from), and tearing the slot down must stop
// the loop so no interval leaks.

interface Sandbox {
  home: string
  projectPaths: Map<string, string>
  cleanup: () => Promise<void>
}

// Registry sandbox under a throwaway NEAT_HOME, mirroring daemon-events. No
// listeners bind (bindListeners:false), so ports don't matter.
async function setupSandbox(projectNames: string[]): Promise<Sandbox> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neatd-stale-home-'))
  const projectPaths = new Map<string, string>()
  const cleanups: Array<() => Promise<void>> = []
  const savedEnv = new Map<string, string | undefined>()
  for (const key of ['NEAT_HOME', 'PORT', 'OTEL_PORT', 'HOST', 'NEAT_AUTH_TOKEN']) {
    savedEnv.set(key, process.env[key])
  }
  process.env.NEAT_HOME = home
  process.env.PORT = '0'
  process.env.OTEL_PORT = '0'
  process.env.HOST = '127.0.0.1'
  delete process.env.NEAT_AUTH_TOKEN

  const { addProject } = await import('../src/registry.js')
  for (const name of projectNames) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `neatd-stale-${name}-`))
    const real = await fs.realpath(dir)
    await fs.writeFile(
      path.join(real, 'package.json'),
      JSON.stringify({ name, version: '0.0.0' }),
    )
    await addProject({ name, path: real, languages: ['javascript'] })
    projectPaths.set(name, real)
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  }

  return {
    home,
    projectPaths,
    cleanup: async () => {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      for (const c of cleanups) await c().catch(() => {})
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

// Plant an OBSERVED CALLS edge whose last sighting is well past the default
// CALLS threshold (1h), so the next staleness tick must demote it.
function addStaleWorthyEdge(graph: import('../src/graph.js').NeatGraph): string {
  const id = 'CALLS:OBSERVED:service:caller->service:callee'
  graph.mergeNode('service:caller', {
    id: 'service:caller',
    type: NodeType.ServiceNode,
    name: 'caller',
    language: 'javascript',
  })
  graph.mergeNode('service:callee', {
    id: 'service:callee',
    type: NodeType.ServiceNode,
    name: 'callee',
    language: 'javascript',
  })
  const lastObserved = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  graph.addEdgeWithKey(id, 'service:caller', 'service:callee', {
    id,
    source: 'service:caller',
    target: 'service:callee',
    type: EdgeType.CALLS,
    provenance: Provenance.OBSERVED,
    lastObserved,
    callCount: 4,
    confidence: 1,
  })
  return id
}

// Poll the stale-events ndjson (real timers) until the transition for `edgeId`
// has been flushed by the loop's fire-and-forget tick.
async function waitForStaleEvent(
  staleEventsPath: string,
  edgeId: string,
): Promise<Awaited<ReturnType<typeof readStaleEvents>>> {
  const deadline = Date.now() + 2000
  let events = await readStaleEvents(staleEventsPath)
  while (Date.now() < deadline && !events.some((e) => e.edgeId === edgeId)) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    events = await readStaleEvents(staleEventsPath)
  }
  return events
}

describe('daemon slots decay OBSERVED edges to STALE (issue #532)', () => {
  const pendingCleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    vi.useRealTimers()
    while (pendingCleanups.length > 0) {
      await pendingCleanups.pop()!().catch(() => {})
    }
  })

  it('a bootstrapped slot ticks OBSERVED→STALE and records the transition', async () => {
    const sandbox = await setupSandbox(['stale-alpha'])
    pendingCleanups.push(sandbox.cleanup)

    // Fake only the timer functions — Date stays real, so the edge age below
    // is honest and extraction (which reads real file mtimes) is untouched.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })

    const { startDaemon } = await import('../src/daemon.js')
    const handle = await startDaemon({ bindListeners: false })
    pendingCleanups.push(handle.stop)
    await handle.initialBootstrap

    const slot = handle.slots.get('stale-alpha')
    expect(slot, 'slot bootstrapped').toBeDefined()
    expect(slot!.status).toBe('active')

    const edgeId = addStaleWorthyEdge(slot!.graph)
    expect((slot!.graph.getEdgeAttributes(edgeId) as GraphEdge).provenance).toBe(
      Provenance.OBSERVED,
    )

    // Fire the daemon's own 60s staleness interval and flush the async tick.
    await vi.advanceTimersByTimeAsync(60_000)

    expect((slot!.graph.getEdgeAttributes(edgeId) as GraphEdge).provenance).toBe(
      Provenance.STALE,
    )
    expect((slot!.graph.getEdgeAttributes(edgeId) as GraphEdge).confidence).toBe(0.3)

    // The transition lands in this slot's stale-events log — the same file the
    // REST `/stale-events` route reads from (staleEventsPathFor in api.ts).
    // The loop's tick is fire-and-forget, so the ndjson append settles on the
    // event loop after the fake-timer advance; poll it back on real timers.
    vi.useRealTimers()
    const persisted = await waitForStaleEvent(slot!.paths.staleEventsPath, edgeId)
    expect(persisted.some((e) => e.edgeId === edgeId)).toBe(true)
  })

  it('tearing the daemon down stops the loop — no leaked interval keeps decaying', async () => {
    const sandbox = await setupSandbox(['stale-beta'])
    pendingCleanups.push(sandbox.cleanup)

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })

    const { startDaemon } = await import('../src/daemon.js')
    const handle = await startDaemon({ bindListeners: false })
    pendingCleanups.push(handle.stop)
    await handle.initialBootstrap

    const slot = handle.slots.get('stale-beta')
    expect(slot?.status).toBe('active')
    const graph = slot!.graph

    // Real timers for the shutdown flush, then stop — teardownSlot calls
    // slot.stopStaleness() alongside slot.stopPersist().
    vi.useRealTimers()
    await handle.stop()

    // Back to fake timers, plant a would-be-stale edge, and let a couple of
    // intervals' worth of time pass. A leaked loop would demote it; a stopped
    // one leaves it OBSERVED.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const edgeId = addStaleWorthyEdge(graph)
    await vi.advanceTimersByTimeAsync(180_000)

    expect((graph.getEdgeAttributes(edgeId) as GraphEdge).provenance).toBe(
      Provenance.OBSERVED,
    )
  })
})

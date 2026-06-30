import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { AddressInfo } from 'node:net'

// One-command-cli contract §1 / ADR-096 — the bare-run readiness gate is a
// single-project question. The orchestrator spawns a daemon scoped to the one
// project it just started, so the wait must resolve on that project alone. A
// broken or stale sibling sitting in the machine registry (here: a
// "recoverable" entry pointing at a deleted temp path) belongs to a different
// daemon and must not gate this run — the harvest bug was exactly that, where
// any broken sibling timed the whole start out at 60s.
//
// The fake daemon below answers /health in the single-project shape (top-level
// `project`, no `projects` array), returns 200 for the started project's
// per-project /health, and 503 for everyone else. If the gate ever probes the
// sibling again it would read 503 forever and never go ready.

interface FakeDaemon {
  port: number
  startedProject: string
  probedPaths: string[]
  close: () => Promise<void>
}

async function startFakeDaemon(startedProject: string): Promise<FakeDaemon> {
  const probedPaths: string[] = []
  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    probedPaths.push(url)
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, project: startedProject }))
      return
    }
    if (url === `/projects/${encodeURIComponent(startedProject)}/health`) {
      res.writeHead(200)
      res.end()
      return
    }
    // Any other project — including a broken sibling — never comes ready.
    res.writeHead(503)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    startedProject,
    probedPaths,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('orchestrator readiness gate scopes to the started project (ADR-096)', () => {
  const cleanups: Array<() => Promise<void>> = []
  let savedHome: string | undefined

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c().catch(() => {})
    if (savedHome === undefined) delete process.env.NEAT_HOME
    else process.env.NEAT_HOME = savedHome
  })

  it('resolves on the healthy just-started project and never probes a broken sibling', async () => {
    savedHome = process.env.NEAT_HOME
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-readiness-home-'))
    process.env.NEAT_HOME = home
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))

    // A healthy project we "just started", and a broken sibling whose path was
    // deleted — the exact poison shape from the run-#2 harvest.
    const { addProject, setStatus } = await import('../src/registry.js')
    const started = 'harvest-app'
    const startedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-readiness-started-'))
    cleanups.push(() => fs.rm(startedDir, { recursive: true, force: true }))
    await addProject({ name: started, path: startedDir, languages: ['javascript'] })

    const sibling = 'recoverable'
    const siblingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-readiness-sibling-'))
    await addProject({ name: sibling, path: siblingDir, languages: ['javascript'] })
    await setStatus(sibling, 'broken')
    // Delete the sibling's path — a stale registry entry pointing at nothing.
    await fs.rm(siblingDir, { recursive: true, force: true })

    const daemon = await startFakeDaemon(started)
    cleanups.push(daemon.close)

    const { waitForDaemonReadyForTest } = await import('../src/orchestrator.js')
    const start = Date.now()
    const result = await waitForDaemonReadyForTest(daemon.port, started, 5_000)
    const elapsed = Date.now() - start

    expect(result.ready).toBe(true)
    expect(result.stillBootstrapping).toEqual([])
    // Resolved on the first probe — nowhere near the timeout.
    expect(elapsed).toBeLessThan(2_000)
    // The broken sibling was never consulted; the gate is scoped.
    expect(daemon.probedPaths.some((p) => p.includes(sibling))).toBe(false)
  })
})

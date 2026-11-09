import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getGraph } from '../src/graph.js'
import { projectConnectorsPath } from '../src/connectors-config.js'
import { startConnectorPolling } from '../src/connectors/registry.js'
import { getConnectorStatus, resetConnectorStatus } from '../src/connectors/status.js'
import { addProject } from '../src/registry.js'
import { runUpCommand } from '../src/up-cli.js'
import { runDoctorCommand } from '../src/doctor-cli.js'
import type { DaemonRecord } from '../src/daemon.js'

// Newdryve #5 / WO-0.8 case 9 — a connector the daemon skips (its $TOKEN is
// unset) shows in the command's own output. Before, `neat up` printed "started"
// and `neat doctor` "all good" while the skip lived only in daemon.log, and
// GET /connectors reported the connector as idle, as if a first poll were due.

const SKIPPED = {
  id: 'rw-a',
  provider: 'railway',
  credentialRef: '$RAILWAY_TOKEN',
  status: { state: 'error', lastPollAt: null, lastOutcome: 'error', lastError: 'not polling — $RAILWAY_TOKEN is unset', signalsLastPoll: 0 },
}
const LINE = 'connector "rw-a" (railway) is not polling — $RAILWAY_TOKEN is unset'

// A daemon that answers /health and /projects/<p>/connectors.
const daemonFetch = (connectors: unknown[]) =>
  (async (url: string) =>
    url.endsWith('/connectors')
      ? new Response(JSON.stringify({ connectors }), { status: 200 })
      : new Response(JSON.stringify({ ok: true, project: 'repoA', projects: [{ name: 'repoA', nodeCount: 3, edgeCount: 2 }] }), { status: 200 })) as unknown as typeof fetch

let home: string
let prevHome: string | undefined
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-skip-home-')))
  prevHome = process.env.NEAT_HOME
  process.env.NEAT_HOME = home
  resetConnectorStatus()
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.NEAT_HOME
  else process.env.NEAT_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
})

describe('a skipped connector is reported, not idle (#5)', () => {
  it('the status tracker records the skip as an error with no poll time', async () => {
    delete process.env.SKIP_TEST_RAILWAY_TOKEN
    const file = projectConnectorsPath(home)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, connectors: [{ id: 'rw-a', provider: 'railway', credential: '$SKIP_TEST_RAILWAY_TOKEN', options: { environmentId: 'e', serviceId: 's', serviceNameById: { s: 'api' } } }] }),
    )
    const skipped: string[] = []
    const stop = await startConnectorPolling({ project: 'repoA', graph: getGraph('skip-test'), projectDir: home, onSkip: (e) => skipped.push(e.id) })
    stop()
    expect(skipped).toEqual(['rw-a'])
    expect(getConnectorStatus('rw-a')).toMatchObject({ state: 'error', lastPollAt: null, lastError: 'not polling — $SKIP_TEST_RAILWAY_TOKEN is unset' })
  })

  it('neat up names the skipped connector on stderr and still exits 0', async () => {
    const dir = path.join(home, 'repoA')
    await fs.mkdir(dir)
    await addProject({ name: 'repoA', path: dir })
    const out: string[] = []
    const err: string[] = []
    const code = await runUpCommand([], {
      cwd: dir,
      env: {},
      resolveTarget: async () => ({ endpoint: 'this machine', local: true, via: 'test' }),
      ensureDaemon: async () => ({ status: 'spawned', ports: { rest: 8081, otlp: 4319, web: 6329 }, brokenProjects: [] }),
      fetchImpl: daemonFetch([SKIPPED]),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    })
    expect(code).toBe(0)
    expect(out.some((l) => l.startsWith('neat up: started repoA'))).toBe(true)
    expect(err).toContain(`neat up: ${LINE}`)
  })

  it('neat doctor fails a connectors check instead of "all good"', async () => {
    const record: DaemonRecord = { project: 'repoA', projectPath: home, pid: 1, status: 'running', ports: { rest: 8081, otlp: 4319, web: 6329 }, startedAt: '2026-10-22T00:00:00.000Z', neatVersion: '0.10.11' }
    const lines: string[] = []
    const code = await runDoctorCommand(['--json'], { cwd: home, nodeVersion: '20.11.0', env: {}, resolve: () => ({ project: { name: 'repoA', detail: 'repoA' }, endpoint: 'http://localhost:8081', daemonProject: 'repoA', via: 'local' }), readRecord: async () => record, fetchImpl: daemonFetch([SKIPPED]), out: (l) => lines.push(l) })
    const report = JSON.parse(lines.join('\n'))
    expect(code).toBe(1)
    expect(report.checks.find((c: { name: string }) => c.name === 'connectors')).toMatchObject({ ok: false, detail: LINE })
  })

  it('a healthy connector set passes, and none configured adds no check', async () => {
    const record: DaemonRecord = { project: 'repoA', projectPath: home, pid: 1, status: 'running', ports: { rest: 8081, otlp: 4319, web: 6329 }, startedAt: '2026-10-22T00:00:00.000Z', neatVersion: '0.10.11' }
    const run = async (connectors: unknown[]) => {
      const lines: string[] = []
      const code = await runDoctorCommand(['--json'], { cwd: home, nodeVersion: '20.11.0', env: {}, resolve: () => ({ project: { name: 'repoA', detail: 'repoA' }, endpoint: 'http://localhost:8081', daemonProject: 'repoA', via: 'local' }), readRecord: async () => record, fetchImpl: daemonFetch(connectors), out: (l) => lines.push(l) })
      return { code, checks: JSON.parse(lines.join('\n')).checks as Array<{ name: string; ok: boolean }> }
    }
    const healthy = await run([{ ...SKIPPED, status: { state: 'healthy', lastPollAt: '2026-10-22T00:00:00.000Z', lastOutcome: 'ok', lastError: null, signalsLastPoll: 4 } }])
    expect(healthy.code).toBe(0)
    expect(healthy.checks.find((c) => c.name === 'connectors')).toMatchObject({ ok: true })
    const none = await run([])
    expect(none.code).toBe(0)
    expect(none.checks.map((c) => c.name)).toEqual(['node', 'project', 'daemon'])
  })
})

import { describe, it, expect, afterEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { getGraph } from '../src/graph.js'
import { connectorsConfigPath } from '../src/connectors-config.js'
import { loadConnectorRegistrations } from '../src/connectors/registry.js'
import { CloudflareConnector } from '../src/connectors/cloudflare/index.js'
import type { ConnectorContext, ObservedSignal } from '../src/connectors/index.js'

// docs/contracts/connector-config.md §6 — the daemon reads
// ~/.neat/connectors.json at slot bootstrap, resolves the env-ref credential
// into memory, and hands one registration per matched entry to the poll loop
// that already exists. This is the moment the connectors plane turns on: a
// real connectors.json at a temp NEAT_HOME → running poll loops.

interface Sandbox {
  home: string
  projectPaths: Map<string, string>
  cleanup: () => Promise<void>
}

// Mirrors daemon-staleness.test.ts's sandbox: a throwaway NEAT_HOME + a
// registered project, no listeners bound.
async function setupSandbox(projectNames: string[], extraEnv: string[] = []): Promise<Sandbox> {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neatd-conn-home-')))
  const projectPaths = new Map<string, string>()
  const cleanups: Array<() => Promise<void>> = []
  const savedEnv = new Map<string, string | undefined>()
  for (const key of ['NEAT_HOME', 'PORT', 'OTEL_PORT', 'HOST', 'NEAT_AUTH_TOKEN', ...extraEnv]) {
    savedEnv.set(key, process.env[key])
  }
  process.env.NEAT_HOME = home
  process.env.PORT = '0'
  process.env.OTEL_PORT = '0'
  process.env.HOST = '127.0.0.1'
  delete process.env.NEAT_AUTH_TOKEN

  const { addProject } = await import('../src/registry.js')
  for (const name of projectNames) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `neatd-conn-${name}-`)))
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
    await addProject({ name, path: dir, languages: ['javascript'] })
    projectPaths.set(name, dir)
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
      await fs.rm(home, { recursive: true, force: true }).catch(() => {})
    },
  }
}

async function writeConnectorsJson(home: string, connectors: unknown[]): Promise<void> {
  const file = connectorsConfigPath(home)
  await fs.writeFile(file, JSON.stringify({ version: 1, connectors }))
  await fs.chmod(file, 0o600)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) {
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('daemon reads connectors.json at slot bootstrap (ADR-130 §6)', () => {
  const pendingCleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    vi.restoreAllMocks()
    while (pendingCleanups.length > 0) {
      await pendingCleanups.pop()!().catch(() => {})
    }
  })

  it('a real connectors.json populates the slot with a poll loop that fires with the resolved credential', async () => {
    const sandbox = await setupSandbox(['conn-alpha'], ['CONN_TEST_CF_TOKEN'])
    pendingCleanups.push(sandbox.cleanup)

    // The credential is a pointer: connectors.json holds "$CONN_TEST_CF_TOKEN",
    // the value lives only in the environment and only resolves at read time.
    process.env.CONN_TEST_CF_TOKEN = 'cf_secret_value'
    await writeConnectorsJson(sandbox.home, [
      {
        id: 'cf-alpha',
        provider: 'cloudflare',
        // project omitted → binds to whatever project this daemon bootstraps.
        credential: '$CONN_TEST_CF_TOKEN',
        options: {
          accountId: 'acct-xyz',
          workers: { 'my-worker': { service: 'api', entryFile: 'src/index.ts' } },
          // Tighten the loop so the tick fires within the test window instead
          // of the 60s production default.
          intervalMs: 20,
        },
      },
    ])

    // Capture the ctx the loop drives poll() with — without hitting the
    // network. The spy stands in for Cloudflare's telemetry API.
    const seen: ConnectorContext[] = []
    vi.spyOn(CloudflareConnector.prototype, 'poll').mockImplementation(
      async (ctx: ConnectorContext): Promise<ObservedSignal[]> => {
        seen.push(ctx)
        return []
      },
    )

    const { startDaemon } = await import('../src/daemon.js')
    const handle = await startDaemon({ bindListeners: false })
    pendingCleanups.push(handle.stop)
    await handle.initialBootstrap

    const slot = handle.slots.get('conn-alpha')
    expect(slot?.status).toBe('active')

    await waitUntil(() => seen.length > 0)

    // The plane is on: the file-configured connector's poll() ran, driven by
    // the loop the daemon wired from connectors.json.
    expect(seen.length).toBeGreaterThan(0)
    const ctx = seen[0]
    // The env-ref resolved to the real value, in memory, and reached poll()
    // via ctx.credentials — never written to the file or the snapshot.
    expect(ctx.credentials.apiToken).toBe('cf_secret_value')
    expect(ctx.projectDir).toBe(sandbox.projectPaths.get('conn-alpha'))
  })

  it('the same read path populates registrations deterministically (opts.connectors seam)', async () => {
    // The daemon composes readConnectorsConfig + the dispatch table via
    // loadConnectorRegistrations; assert that seam directly against a real
    // file so the "opts.connectors populates" moment isn't only timing-based.
    const sandbox = await setupSandbox([], ['CONN_TEST_CF_TOKEN'])
    pendingCleanups.push(sandbox.cleanup)
    process.env.CONN_TEST_CF_TOKEN = 'cf_secret_value'
    await writeConnectorsJson(sandbox.home, [
      {
        id: 'cf-alpha',
        provider: 'cloudflare',
        project: 'conn-alpha',
        credential: '$CONN_TEST_CF_TOKEN',
        options: { accountId: 'acct-xyz', workers: {} },
      },
    ])

    const registrations = await loadConnectorRegistrations({
      project: 'conn-alpha',
      graph: getGraph('conn-alpha-read-test'),
      home: sandbox.home,
    })

    expect(registrations).toHaveLength(1)
    expect(registrations[0].connector.provider).toBe('cloudflare')
    expect(registrations[0].credentials.apiToken).toBe('cf_secret_value')
    expect(typeof registrations[0].resolveTarget).toBe('function')
  })
})

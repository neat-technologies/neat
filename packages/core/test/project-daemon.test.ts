import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'

// ADR-096 / project-daemon contract — the make-or-break slice (§1).
//
// Under one-daemon-per-project, only one daemon binds the canonical 4318; a
// second project's daemon steps to another OTLP port. If the second project's
// app were still baked to 4318 it would send spans to the FIRST project's
// daemon, which has no slot for them, and they'd drop silently to
// errors.ndjson — the second project's OBSERVED layer goes dark. This suite
// proves that path is dead:
//
//   1. Two daemons for two different projects, on allocated (here: ephemeral)
//      ports under an isolated NEAT_HOME. Each writes its own daemon.json.
//   2. Each app resolves its OTLP endpoint from its OWN daemon.json via the
//      exact resolver snippet the generated otel-init ships — and they differ.
//   3. Spans driven to BOTH endpoints land each in its own project's graph,
//      and nothing drops to either project's errors.ndjson.
//   4. Port stability across a daemon restart (the daemon.json ports are
//      reused) and the /health project-identity check (a different project's
//      daemon on a reused port is detected as not-mine).
//
// Isolation: every daemon binds ephemeral ports (restPort/otlpPort 0) under a
// throwaway NEAT_HOME. The live daemon on 8080/4318/6328 and the real ~/.neat
// are never touched, and only the handles spawned here are torn down.

interface Sandbox {
  home: string
  projectPaths: Map<string, string>
  cleanup: () => Promise<void>
}

async function setupSandbox(projectNames: string[]): Promise<Sandbox> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neatd-pd-home-'))
  const projectPaths = new Map<string, string>()
  const cleanups: Array<() => Promise<void>> = []
  const savedEnv = new Map<string, string | undefined>()
  for (const key of [
    'NEAT_HOME',
    'PORT',
    'OTEL_PORT',
    'HOST',
    'NEAT_AUTH_TOKEN',
    'NEAT_PROJECT',
    'NEAT_PROJECT_PATH',
    'NEAT_WEB_PORT',
  ]) {
    savedEnv.set(key, process.env[key])
  }
  process.env.NEAT_HOME = home
  // Loopback bind, no token — keeps OTLP + REST open so the wire test needs no
  // bearer plumbing.
  process.env.HOST = '127.0.0.1'
  delete process.env.NEAT_AUTH_TOKEN
  // Make sure no stray PORT/OTEL_PORT/NEAT_PROJECT leak into startDaemon — the
  // suite passes ports explicitly via opts.
  delete process.env.PORT
  delete process.env.OTEL_PORT
  delete process.env.NEAT_PROJECT
  delete process.env.NEAT_PROJECT_PATH
  delete process.env.NEAT_WEB_PORT

  const { addProject } = await import('../src/registry.js')
  for (const name of projectNames) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `neatd-pd-${name}-`))
    const real = await fs.realpath(dir)
    await fs.writeFile(
      path.join(real, 'package.json'),
      JSON.stringify({ name, version: '0.0.0' }),
    )
    // Wave 1 is additive — the registry write stays (Wave 2 retires it). The
    // single-project daemon takes its project from spawn args regardless, but
    // registering keeps the path identical to a real `neat init`.
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

// Run the exact CJS endpoint-resolver snippet the generated otel-init ships,
// with process.cwd() pointed at the app's project dir. Returns the resolved
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT — i.e. what the instrumented app would
// actually send its spans to. This is the faithful test of §1: the app reads
// its endpoint back from its OWN daemon.json.
async function resolveEndpointAsApp(projectDir: string): Promise<string> {
  const { OTEL_ENDPOINT_RESOLVER_CJS } = await import('../src/installers/templates.js')
  const savedCwd = process.cwd()
  const savedEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  const savedGeneric = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  try {
    process.chdir(projectDir)
    // The snippet is a top-level IIFE that mutates process.env. `require` is in
    // scope in this CJS-transpiled test module, mirroring a require-based app.
    new Function('require', 'process', OTEL_ENDPOINT_RESOLVER_CJS)(require, process)
    return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? ''
  } finally {
    process.chdir(savedCwd)
    if (savedEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = savedEndpoint
    if (savedGeneric === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedGeneric
  }
}

// A CLIENT span against an unresolvable peer host — mints a FrontierNode + an
// OBSERVED CALLS edge (ADR-068). The frontier host is unique per project so we
// can prove the span landed in the right graph.
function clientSpanBody(service: string, host: string, spanId: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: service } }],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'aabbccddeeff00112233445566778899',
                spanId,
                name: 'GET /upstream',
                kind: 3,
                startTimeUnixNano: '1770000000000000000',
                endTimeUnixNano: '1770000000050000000',
                attributes: [
                  { key: 'http.method', value: { stringValue: 'GET' } },
                  { key: 'server.address', value: { stringValue: host } },
                  { key: 'server.port', value: { intValue: '443' } },
                ],
                status: { code: 0 },
              },
            ],
          },
        ],
      },
    ],
  })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return predicate()
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

describe('per-project daemon — §1 spans land in the right graph, none drop (ADR-096)', () => {
  const pending: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (pending.length > 0) await pending.pop()!().catch(() => {})
  })

  it('two daemons, two projects: each app resolves its own endpoint and spans never cross or drop', async () => {
    const sandbox = await setupSandbox(['alpha-svc', 'beta-svc'])
    pending.push(sandbox.cleanup)
    const { startDaemon } = await import('../src/daemon.js')

    const alphaPath = sandbox.projectPaths.get('alpha-svc')!
    const betaPath = sandbox.projectPaths.get('beta-svc')!

    // Two per-project daemons on ephemeral ports — the allocation analogue of
    // "second daemon steps off 4318". Each writes its own daemon.json.
    const alpha = await startDaemon({
      project: 'alpha-svc',
      projectPath: alphaPath,
      restPort: 0,
      otlpPort: 0,
    })
    pending.push(alpha.stop)
    const beta = await startDaemon({
      project: 'beta-svc',
      projectPath: betaPath,
      restPort: 0,
      otlpPort: 0,
    })
    pending.push(beta.stop)
    await Promise.all([alpha.initialBootstrap, beta.initialBootstrap])

    // Each daemon recorded its own self-description with distinct OTLP ports.
    expect(alpha.daemonRecord).not.toBeNull()
    expect(beta.daemonRecord).not.toBeNull()
    expect(alpha.daemonRecord!.project).toBe('alpha-svc')
    expect(beta.daemonRecord!.project).toBe('beta-svc')
    expect(alpha.daemonRecord!.ports.otlp).not.toBe(beta.daemonRecord!.ports.otlp)

    // daemon.json is on disk at each project root.
    expect(await fileExists(path.join(alphaPath, 'neat-out', 'daemon.json'))).toBe(true)
    expect(await fileExists(path.join(betaPath, 'neat-out', 'daemon.json'))).toBe(true)

    // The discovery copies landed under the isolated NEAT_HOME.
    expect(await fileExists(path.join(sandbox.home, 'daemons', 'alpha-svc.json'))).toBe(true)
    expect(await fileExists(path.join(sandbox.home, 'daemons', 'beta-svc.json'))).toBe(true)

    // THE PROOF: each app resolves its endpoint from its own daemon.json, and
    // the two endpoints differ. On the old baked-4318 path they'd be identical
    // and beta's spans would land on alpha's daemon.
    const alphaEndpoint = await resolveEndpointAsApp(alphaPath)
    const betaEndpoint = await resolveEndpointAsApp(betaPath)
    expect(alphaEndpoint).toBe(`http://localhost:${alpha.daemonRecord!.ports.otlp}/v1/traces`)
    expect(betaEndpoint).toBe(`http://localhost:${beta.daemonRecord!.ports.otlp}/v1/traces`)
    expect(alphaEndpoint).not.toBe(betaEndpoint)

    // Drive a span to EACH resolved endpoint, exactly as each app's exporter
    // would.
    const alphaRes = await fetch(alphaEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: clientSpanBody('alpha-svc', 'alpha-frontier.example.test', '1111111111111111'),
    })
    expect(alphaRes.status).toBe(200)
    const betaRes = await fetch(betaEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: clientSpanBody('beta-svc', 'beta-frontier.example.test', '2222222222222222'),
    })
    expect(betaRes.status).toBe(200)

    // Each project's OBSERVED edge lands in ITS OWN graph.
    const alphaSlot = alpha.slots.get('alpha-svc')!
    const betaSlot = beta.slots.get('beta-svc')!
    const alphaLanded = await waitFor(
      () => [...alphaSlot.graph.nodes()].some((id) => id.includes('alpha-frontier.example.test')),
      10_000,
    )
    expect(alphaLanded, 'alpha span minted a node in alpha graph').toBe(true)
    const betaLanded = await waitFor(
      () => [...betaSlot.graph.nodes()].some((id) => id.includes('beta-frontier.example.test')),
      10_000,
    )
    expect(betaLanded, 'beta span minted a node in beta graph').toBe(true)

    // No cross-contamination: alpha's frontier host never appears in beta's
    // graph, and vice versa.
    expect([...betaSlot.graph.nodes()].some((id) => id.includes('alpha-frontier.example.test'))).toBe(false)
    expect([...alphaSlot.graph.nodes()].some((id) => id.includes('beta-frontier.example.test'))).toBe(false)

    // Nothing dropped: neither project's errors.ndjson nor the home-level
    // unrouted errors.ndjson exists (the single-project path never writes the
    // no-route drop).
    expect(await fileExists(alphaSlot.paths.errorsPath)).toBe(false)
    expect(await fileExists(betaSlot.paths.errorsPath)).toBe(false)
    expect(await fileExists(path.join(sandbox.home, 'errors.ndjson'))).toBe(false)
  })

  it('single-project mode quarantines a sibling project\'s span instead of merging it (refs #339)', async () => {
    const sandbox = await setupSandbox(['own-svc'])
    pending.push(sandbox.cleanup)
    const { startDaemon } = await import('../src/daemon.js')
    const ownPath = sandbox.projectPaths.get('own-svc')!

    const daemon = await startDaemon({
      project: 'own-svc',
      projectPath: ownPath,
      restPort: 0,
      otlpPort: 0,
    })
    pending.push(daemon.stop)
    await daemon.initialBootstrap
    const endpoint = `${daemon.otlpAddress}/v1/traces`

    // A foreign service's exporter found this daemon's shared OTLP port (the
    // OS-default 4318 analogue). Its service.name belongs to no part of this
    // project — neither the project name nor any extracted ServiceNode.
    const foreignRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: clientSpanBody('foreign-svc', 'foreign-frontier.example.test', '4444444444444444'),
    })
    expect(foreignRes.status).toBe(200) // OTLP spec — always 200.

    // This project's own span, posted after, lands normally.
    const ownRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: clientSpanBody('own-svc', 'own-frontier.example.test', '5555555555555555'),
    })
    expect(ownRes.status).toBe(200)

    const slot = daemon.slots.get('own-svc')!
    const ownLanded = await waitFor(
      () => [...slot.graph.nodes()].some((id) => id.includes('own-frontier.example.test')),
      10_000,
    )
    expect(ownLanded, 'own span minted a node in own graph').toBe(true)

    // The foreign span never merged: neither its peer host nor its service node
    // appear in this project's graph.
    expect([...slot.graph.nodes()].some((id) => id.includes('foreign-frontier.example.test'))).toBe(false)
    expect([...slot.graph.nodes()].some((id) => id.includes('foreign-svc'))).toBe(false)

    // It quarantined to the home-level unrouted ledger rather than going dark.
    const quarantined = await waitFor(
      () => fileExists(path.join(sandbox.home, 'errors.ndjson')),
      10_000,
    )
    expect(quarantined, 'foreign span recorded to the unrouted ledger').toBe(true)
  })

  it('ports are stable across a daemon restart — the persisted triple is reused', async () => {
    const sandbox = await setupSandbox(['restart-svc'])
    pending.push(sandbox.cleanup)
    const { startDaemon } = await import('../src/daemon.js')
    const projectPath = sandbox.projectPaths.get('restart-svc')!

    // First boot on a fixed alt port far from the canonical triple, well clear
    // of the live daemon. The daemon records this port in daemon.json.
    const first = await startDaemon({
      project: 'restart-svc',
      projectPath,
      restPort: 18091,
      otlpPort: 14391,
      webPort: 16391,
    })
    await first.initialBootstrap
    expect(first.daemonRecord!.ports.otlp).toBe(14391)
    await first.stop()

    // The orchestrator reads the persisted ports back for reuse.
    const { persistedPortsFor } = await import('../src/orchestrator.js')
    const reused = await persistedPortsFor(projectPath)
    expect(reused).toEqual({ rest: 18091, otlp: 14391, web: 16391 })

    // Second boot on the same ports — the app's exporter endpoint is unchanged,
    // which is the whole point of stable reuse (§3).
    const second = await startDaemon({
      project: 'restart-svc',
      projectPath,
      restPort: 18091,
      otlpPort: 14391,
      webPort: 16391,
    })
    pending.push(second.stop)
    await second.initialBootstrap
    expect(second.daemonRecord!.ports.otlp).toBe(14391)
    const endpoint = await resolveEndpointAsApp(projectPath)
    expect(endpoint).toBe('http://localhost:14391/v1/traces')
  })

  it('endpoint resolver precedence: explicit env override wins, else daemon.json, else canonical default', async () => {
    const { OTEL_ENDPOINT_RESOLVER_CJS } = await import('../src/installers/templates.js')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-resolver-'))
    pending.push(() => fs.rm(dir, { recursive: true, force: true }))

    const run = (cwd: string): string => {
      const savedCwd = process.cwd()
      const savedEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      const savedGeneric = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      try {
        process.chdir(cwd)
        new Function('require', 'process', OTEL_ENDPOINT_RESOLVER_CJS)(require, process)
        return process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? ''
      } finally {
        process.chdir(savedCwd)
        if (savedEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = savedEndpoint
        if (savedGeneric === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedGeneric
      }
    }

    // No daemon.json anywhere up the tree → canonical bare default.
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    expect(run(dir)).toBe('http://localhost:4318/v1/traces')

    // daemon.json present with an alt port → that port's bare route.
    await fs.mkdir(path.join(dir, 'neat-out'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'neat-out', 'daemon.json'),
      JSON.stringify({ project: 'p', ports: { rest: 8085, otlp: 4323, web: 6333 } }),
    )
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    expect(run(dir)).toBe('http://localhost:4323/v1/traces')

    // An explicit env override beats daemon.json (prod/hosted path).
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://collector.example/v1/traces'
    expect(run(dir)).toBe('https://collector.example/v1/traces')
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  })

  it('/health carries the project name — a different project on the same port is not-mine', async () => {
    const sandbox = await setupSandbox(['ident-svc'])
    pending.push(sandbox.cleanup)
    const { startDaemon } = await import('../src/daemon.js')
    const projectPath = sandbox.projectPaths.get('ident-svc')!

    const handle = await startDaemon({
      project: 'ident-svc',
      projectPath,
      restPort: 0,
      otlpPort: 0,
    })
    pending.push(handle.stop)
    await handle.initialBootstrap
    expect(handle.restAddress).not.toBe('')

    // /health carries the top-level project name (the spawn-reuse identity).
    const res = await fetch(`${handle.restAddress}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { project?: string; ok?: boolean }
    expect(body.ok).toBe(true)
    expect(body.project).toBe('ident-svc')

    // The orchestrator's identity check accepts the matching project and
    // rejects a different one reusing the same port.
    const restPort = handle.daemonRecord!.ports.rest
    const { healthIsForProjectForTest } = await import('../src/orchestrator.js')
    expect(await healthIsForProjectForTest(restPort, 'ident-svc')).toBe(true)
    expect(await healthIsForProjectForTest(restPort, 'someone-else')).toBe(false)
  })

  // §4/§5 — "the daemon is the project." GET /projects reports only the project
  // this daemon serves, even when the machine registry holds others (and even
  // when this one is marked `paused` there by sibling-pause). So the dashboard,
  // which pins to the first active entry, lands on this daemon's own project
  // instead of a sibling it doesn't host (#513).
  it('GET /projects reports only the daemon\'s own project, active, ignoring siblings in the registry (#513)', async () => {
    // Two projects on the machine. The orchestrator pauses the idle sibling
    // when the other activates — so this daemon's project sits `paused` in the
    // machine registry while its daemon is up and serving it.
    const sandbox = await setupSandbox(['pa-svc', 'pb-svc'])
    pending.push(sandbox.cleanup)
    const { startDaemon } = await import('../src/daemon.js')
    const { setStatus } = await import('../src/registry.js')
    await setStatus('pa-svc', 'paused')

    const projectPath = sandbox.projectPaths.get('pa-svc')!
    const handle = await startDaemon({
      project: 'pa-svc',
      projectPath,
      restPort: 0,
      otlpPort: 0,
    })
    pending.push(handle.stop)
    await handle.initialBootstrap

    const res = await fetch(`${handle.restAddress}/projects`)
    expect(res.status).toBe(200)
    const list = (await res.json()) as Array<{ name: string; status?: string }>

    // Only this daemon's project — never the sibling, never the machine list.
    expect(list.map((p) => p.name)).toEqual(['pa-svc'])
    // Reported active: the daemon is serving it, regardless of the registry's
    // `paused` sibling-pause bookkeeping. The dashboard's first-active pin lands
    // here rather than on a project this daemon doesn't host.
    expect(list[0]!.status).toBe('active')
  })

  // §2/§6 — a graceful stop is the daemon's to finish. It flushes the graph,
  // flips its neat-out/ record to "stopped", and removes both the machine-wide
  // discovery copy and the pid file. The persist loops it runs no longer exit
  // the process on a signal (exitOnSignal: false), so this teardown runs to
  // completion instead of being cut short mid-cleanup (#514).
  it('graceful stop flips daemon.json to stopped and removes the discovery copy + pid file (#514)', async () => {
    const sandbox = await setupSandbox(['stop-svc'])
    pending.push(sandbox.cleanup)
    const { startDaemon, readDaemonRecord, daemonDiscoveryPath } = await import('../src/daemon.js')
    const projectPath = sandbox.projectPaths.get('stop-svc')!

    const handle = await startDaemon({
      project: 'stop-svc',
      projectPath,
      restPort: 18092,
      otlpPort: 14392,
      webPort: 16392,
    })
    // stop() is idempotent; queue it so a failed assertion still tears down.
    pending.push(handle.stop)
    await handle.initialBootstrap

    const discoveryPath = daemonDiscoveryPath('stop-svc', sandbox.home)
    const pidPath = path.join(sandbox.home, 'neatd.pid')

    // Running: both records present, the authoritative one reads "running".
    expect(await fileExists(discoveryPath)).toBe(true)
    expect(await fileExists(pidPath)).toBe(true)
    expect((await readDaemonRecord(projectPath))!.status).toBe('running')

    await handle.stop()

    // Stopped: the discovery copy and pid file are gone, and the neat-out/
    // record is flipped to "stopped" (kept so a later read tells "shut down
    // cleanly" from "never ran").
    expect(await fileExists(discoveryPath)).toBe(false)
    expect(await fileExists(pidPath)).toBe(false)
    expect((await readDaemonRecord(projectPath))!.status).toBe('stopped')
  })

  // §4 — "the daemon is the project; a request needs no project name to
  // disambiguate." A per-project daemon answers read routes that carry no
  // project, the legacy `default` alias, or its own real name — all routing to
  // its one project. Only a request naming a *different* project 404s. This is
  // what lets an agent wired with just NEAT_CORE_URL (no project arg, no
  // NEAT_DEFAULT_PROJECT) query the graph of a project not named `default`
  // (#519).
  it('resolves unprefixed / default / own-name read routes to its project; a different name 404s (#519)', async () => {
    const sandbox = await setupSandbox(['route-svc'])
    pending.push(sandbox.cleanup)
    const { startDaemon } = await import('../src/daemon.js')
    const projectPath = sandbox.projectPaths.get('route-svc')!

    const handle = await startDaemon({
      project: 'route-svc',
      projectPath,
      restPort: 0,
      otlpPort: 0,
    })
    pending.push(handle.stop)
    await handle.initialBootstrap
    const base = handle.restAddress

    // /search is a read route; project resolution is identical for every query
    // verb. Each of these must land on this daemon's project — a 200 search
    // body, never a 404 "project not found: default".
    for (const url of [
      `${base}/search?q=route`, // unprefixed — names no project
      `${base}/projects/default/search?q=route`, // the legacy `default` alias
      `${base}/projects/route-svc/search?q=route`, // its own real name
    ]) {
      const res = await fetch(url)
      expect(res.status, `expected 200 for ${url}`).toBe(200)
      const body = (await res.json()) as { matches?: unknown[]; error?: string }
      expect(body.error, `unexpected error body for ${url}`).toBeUndefined()
      expect(Array.isArray(body.matches), `expected a search body for ${url}`).toBe(true)
    }

    // A genuinely different project name is not this daemon's project → 404.
    const miss = await fetch(`${base}/projects/some-other/search?q=route`)
    expect(miss.status).toBe(404)
    expect(((await miss.json()) as { error?: string }).error).toBe('project not found')
  })
})

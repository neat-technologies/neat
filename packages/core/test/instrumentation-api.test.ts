import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { resetGraph, getGraph } from '../src/graph.js'
import { buildApi } from '../src/api.js'

// #823 — GET /instrumentation backs the web ObservedOverlay's honesty probe.
// The daemon serves the ROOT `/instrumentation` the web proxy
// (packages/web/app/api/instrumentation/route.ts) hits. It fuses
// describeProjectInstrumentation (hook state) with listUninstrumented (registry
// coverage gaps) and answers the overlay's contract shape:
//   { engaged: boolean | null, diagnosis?: { reason, fixCommand, detail } }.
// Honesty rule: only a real, named gap yields engaged:false + a diagnosis; a
// wired-and-clean setup is engaged:true; an undeterminable one is engaged:null.

describe('GET /instrumentation (ObservedOverlay probe)', () => {
  let app: FastifyInstance | null = null
  let scan: string

  async function writePkg(deps: Record<string, string>): Promise<void> {
    await fs.writeFile(
      path.join(scan, 'package.json'),
      JSON.stringify({ name: 'probe-fixture', dependencies: deps }, null, 2),
    )
  }

  async function writeHook(): Promise<void> {
    // A basename starting with `otel-init` is a hook file (extend/index.ts).
    await fs.writeFile(path.join(scan, 'otel-init.cjs'), '// hook\nnew NodeSDK({})\n')
  }

  async function start(scanPath?: string): Promise<void> {
    resetGraph()
    app = await buildApi({ graph: getGraph(), scanPath })
  }

  beforeEach(async () => {
    scan = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-instr-')))
  })

  afterEach(async () => {
    if (app) await app.close()
    app = null
    await fs.rm(scan, { recursive: true, force: true }).catch(() => {})
  })

  it('reports engaged:false with a `neat init` diagnosis when no OTel hook exists', async () => {
    await writePkg({ lodash: '^4.17.0' })
    await start(scan)
    const res = await app!.inject({ method: 'GET', url: '/instrumentation' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.engaged).toBe(false)
    expect(body.diagnosis.fixCommand).toBe('neat init')
    expect(body.diagnosis.reason).toMatch(/entry point/i)
    expect(typeof body.diagnosis.detail).toBe('string')
  })

  it('reports engaged:false with a `neat extend` diagnosis naming an uninstrumented library', async () => {
    await writeHook()
    // hono resolves to a `gap` registry entry — listUninstrumented keeps it.
    await writePkg({ hono: '^4.0.0' })
    await start(scan)
    const res = await app!.inject({ method: 'GET', url: '/instrumentation' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.engaged).toBe(false)
    expect(body.diagnosis.fixCommand).toBe('neat extend')
    expect(body.diagnosis.reason).toContain('hono')
    expect(body.diagnosis.detail).toContain('hono')
  })

  it('reports engaged:true with no diagnosis when the hook is wired and nothing is missing', async () => {
    await writeHook()
    // lodash isn't in the registry, so it never surfaces as a coverage gap.
    await writePkg({ lodash: '^4.17.0' })
    await start(scan)
    const res = await app!.inject({ method: 'GET', url: '/instrumentation' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ engaged: true })
  })

  it('is dual-mounted: the same verdict under /projects/default/instrumentation', async () => {
    await writeHook()
    await writePkg({ lodash: '^4.17.0' })
    await start(scan)
    const res = await app!.inject({ method: 'GET', url: '/projects/default/instrumentation' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ engaged: true })
  })

  it('reports engaged:null (neutral) when the project has no scan path', async () => {
    await start(undefined)
    const res = await app!.inject({ method: 'GET', url: '/instrumentation' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ engaged: null })
  })

  it('reports engaged:null (neutral) rather than erroring when package.json is unreadable', async () => {
    // Scan path set but no package.json — describeProjectInstrumentation throws;
    // the probe swallows it into a neutral verdict, never a fabricated cause.
    await start(scan)
    const res = await app!.inject({ method: 'GET', url: '/instrumentation' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ engaged: null })
  })
})

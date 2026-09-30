import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runOrchestrator } from '../src/orchestrator.js'
import { readPackageVersion } from '../src/banner.js'

// #1242 — the front door prints the wordmark and version, then hands over to the
// orchestrator, which used to print its own banner a few lines later. When the
// door has introduced the run the banner is skipped; every other way in keeps it.
//
// An empty directory is enough: the banner is the first thing printed, and with
// no services the run stops before it registers or spawns anything.

let dir: string
let lines: string[]

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-banner-'))
  lines = []
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    lines.push(String(msg ?? ''))
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

const base = () => ({
  scanPath: dir,
  project: path.basename(dir),
  projectExplicit: false,
  noInstrument: true,
  noOpen: true,
  yes: true,
})

const hasBanner = (): boolean => lines.some((l) => l.includes(`v${readPackageVersion()}`))

describe('orchestrator banner', () => {
  it('opens a direct run with the banner', async () => {
    await runOrchestrator(base())
    expect(hasBanner()).toBe(true)
  })

  it('skips it when the front door already printed the header', async () => {
    await runOrchestrator({ ...base(), skipBanner: true })
    expect(hasBanner()).toBe(false)
    // The run itself still says where it is working.
    expect(lines).toContain(`neat: ${dir}`)
  })
})

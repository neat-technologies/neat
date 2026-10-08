import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { javascriptInstaller } from '../src/installers/index.js'

// ADR-232 — `neat init --source-edit` is one of the explicit routes to
// source-edit injection, so init has to hand the flag to every installer's
// plan. Without it the flag parses and is then dropped.

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})

async function initWith(sourceEdit: boolean | undefined): Promise<unknown[]> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-init-home-'))
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-init-repo-'))
  dirs.push(home, repo)
  await fs.writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'orders', version: '1.0.0', main: 'index.js', dependencies: { express: '^4.19.0' } }),
  )
  await fs.writeFile(path.join(repo, 'index.js'), "require('express')().listen(3000)\n")

  const spy = vi.spyOn(javascriptInstaller, 'plan')
  const prevHome = process.env.NEAT_HOME
  const prevLog = console.log
  process.env.NEAT_HOME = home
  console.log = () => {}
  try {
    const { runInit } = await import('../src/cli.js')
    await runInit({
      scanPath: repo,
      outPath: path.join(repo, 'neat-out', 'graph.json'),
      project: 'orders-init',
      projectExplicit: true,
      apply: false,
      dryRun: true,
      noInstall: false,
      verbose: false,
      ...(sourceEdit === undefined ? {} : { sourceEdit }),
    })
  } finally {
    console.log = prevLog
    if (prevHome === undefined) delete process.env.NEAT_HOME
    else process.env.NEAT_HOME = prevHome
  }
  return spy.mock.calls.map((c) => c[1])
}

describe('neat init --source-edit', () => {
  it('passes sourceEdit to the installer plan', async () => {
    const opts = await initWith(true)
    expect(opts.length).toBeGreaterThan(0)
    for (const o of opts) expect(o).toEqual(expect.objectContaining({ sourceEdit: true }))
  })

  it('plans attachment when the flag is absent', async () => {
    const opts = await initWith(undefined)
    expect(opts.length).toBeGreaterThan(0)
    for (const o of opts) expect((o as { sourceEdit?: boolean }).sourceEdit).toBeFalsy()
  })
})

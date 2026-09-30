import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'

// The guard on the guard (#1244). `test/setup-neat-home.ts` points NEAT_HOME at
// a per-file sandbox before anything loads; if that stops happening — a renamed
// setup file, a dropped `setupFiles` entry — the suite goes back to reading and
// writing the developer's real registry, and the way that got noticed last time
// was a wiped projects.json.

describe('NEAT_HOME isolation', () => {
  it('is set, and points somewhere under the temp dir', () => {
    const home = process.env.NEAT_HOME
    expect(home, 'setupFiles did not run — the suite would use the real ~/.neat').toBeDefined()
    expect(path.resolve(home!).startsWith(path.resolve(os.tmpdir()))).toBe(true)
  })

  it('is not the real ~/.neat, however the env was inherited', () => {
    // Unconditional by design: a developer with NEAT_HOME exported in their
    // shell must not be able to point the suite back at real state.
    expect(path.resolve(process.env.NEAT_HOME!)).not.toBe(path.join(os.homedir(), '.neat'))
  })

  it('is writable, so a test that registers a project touches only the sandbox', async () => {
    const probe = path.join(process.env.NEAT_HOME!, 'projects.json')
    await fs.writeFile(probe, JSON.stringify({ version: 1, projects: [] }), 'utf8')
    expect(JSON.parse(await fs.readFile(probe, 'utf8'))).toEqual({ version: 1, projects: [] })
    await fs.rm(probe, { force: true })
  })
})

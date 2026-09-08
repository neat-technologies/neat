import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { runLoginCommand, runLogoutCommand } from '../src/login-cli.js'
import { getActiveProfile, resolveProfile, readProfilesConfig, upsertProfile } from '../src/profiles.js'

// docs/contracts/cli-surface.md §neat login — the write side of the client
// profile store. `login` probes the endpoint with the token, then writes
// `{ name, endpoint, authToken }` and makes it active; `logout` clears the
// active pointer or removes a profile. Exit codes: 0 done, 1 rejected, 2 misuse,
// 3 unreachable.

const tmpDirs: string[] = []

async function makeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-login-'))
  const real = await fs.realpath(dir)
  tmpDirs.push(real)
  return real
}

// A fetch stub the probe can call — a Response-shaped object is all it reads.
function fetchReturning(status: number, contentType = 'application/json'): typeof fetch {
  return (async () =>
    ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    }) as unknown as Response) as unknown as typeof fetch
}

function fetchThrowing(): typeof fetch {
  return (async () => {
    throw new Error('connect ECONNREFUSED')
  }) as unknown as typeof fetch
}

interface Captured {
  out: string[]
  err: string[]
}

function capture(): { deps: { out: (l: string) => void; err: (l: string) => void }; cap: Captured } {
  const cap: Captured = { out: [], err: [] }
  return { deps: { out: (l) => cap.out.push(l), err: (l) => cap.err.push(l) }, cap }
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

describe('runLoginCommand', () => {
  it('writes an active profile when the probe succeeds', async () => {
    const home = await makeHome()
    const { deps, cap } = capture()
    const code = await runLoginCommand(
      ['--endpoint', 'https://neat-acme.run.app', '--token', 'dtok'],
      { ...deps, home, fetchImpl: fetchReturning(200), env: {} },
    )
    expect(code).toBe(0)
    expect(cap.out.join('\n')).toContain('Logged in')
    const active = await getActiveProfile(home)
    expect(active).toEqual({ name: 'hosted', endpoint: 'https://neat-acme.run.app', authToken: 'dtok' })
  })

  it('honors --name for the profile label', async () => {
    const home = await makeHome()
    const { deps } = capture()
    await runLoginCommand(
      ['--endpoint', 'https://h.run.app', '--token', 't', '--name', 'prod'],
      { ...deps, home, fetchImpl: fetchReturning(200), env: {} },
    )
    expect(await resolveProfile('prod', home)).toMatchObject({ name: 'prod' })
    expect((await readProfilesConfig(home)).active).toBe('prod')
  })

  it('rejects a bad token (401) and writes nothing', async () => {
    const home = await makeHome()
    const { deps, cap } = capture()
    const code = await runLoginCommand(
      ['--endpoint', 'https://h.run.app', '--token', 'wrong'],
      { ...deps, home, fetchImpl: fetchReturning(401), env: {} },
    )
    expect(code).toBe(1)
    expect(cap.err.join('\n')).toContain('rejected the token')
    expect(await getActiveProfile(home)).toBeUndefined()
  })

  it('exits 3 when the endpoint is unreachable', async () => {
    const home = await makeHome()
    const { deps, cap } = capture()
    const code = await runLoginCommand(
      ['--endpoint', 'https://down.example', '--token', 't'],
      { ...deps, home, fetchImpl: fetchThrowing(), env: {} },
    )
    expect(code).toBe(3)
    expect(cap.err.join('\n')).toContain("can't reach")
  })

  it('treats a non-JSON 200 as not-NEAT', async () => {
    const home = await makeHome()
    const { deps, cap } = capture()
    const code = await runLoginCommand(
      ['--endpoint', 'https://not-neat.example', '--token', 't'],
      { ...deps, home, fetchImpl: fetchReturning(200, 'text/html'), env: {} },
    )
    expect(code).toBe(1)
    expect(cap.err.join('\n')).toContain('does not look like a NEAT daemon')
  })

  it('is misuse (2) when the endpoint is missing and there is no terminal', async () => {
    const home = await makeHome()
    const { deps, cap } = capture()
    // No readLine/readSecret provided → non-interactive.
    const code = await runLoginCommand(['--token', 't'], { ...deps, home, env: {} })
    expect(code).toBe(2)
    expect(cap.err.join('\n')).toContain('endpoint is required')
  })

  it('is misuse (2) when the token is missing and there is no terminal', async () => {
    const home = await makeHome()
    const { deps, cap } = capture()
    const code = await runLoginCommand(['--endpoint', 'https://h.run.app'], { ...deps, home, env: {} })
    expect(code).toBe(2)
    expect(cap.err.join('\n')).toContain('token is required')
  })

  it('rejects a non-URL endpoint', async () => {
    const home = await makeHome()
    const { deps, cap } = capture()
    const code = await runLoginCommand(
      ['--endpoint', 'not-a-url', '--token', 't'],
      { ...deps, home, fetchImpl: fetchReturning(200), env: {} },
    )
    expect(code).toBe(2)
    expect(cap.err.join('\n')).toContain('absolute URL')
  })

  it('takes the token from NEAT_LOGIN_TOKEN when no flag is given', async () => {
    const home = await makeHome()
    const { deps } = capture()
    const code = await runLoginCommand(
      ['--endpoint', 'https://h.run.app'],
      { ...deps, home, fetchImpl: fetchReturning(200), env: { NEAT_LOGIN_TOKEN: 'envtok' } },
    )
    expect(code).toBe(0)
    expect((await getActiveProfile(home))?.authToken).toBe('envtok')
  })

  it('prompts interactively for endpoint and token, reading the token off-echo', async () => {
    const home = await makeHome()
    const { deps } = capture()
    const code = await runLoginCommand([], {
      ...deps,
      home,
      env: {},
      fetchImpl: fetchReturning(200),
      readLine: async () => 'https://prompted.run.app',
      readSecret: async () => 'prompted-token',
    })
    expect(code).toBe(0)
    expect(await getActiveProfile(home)).toMatchObject({
      endpoint: 'https://prompted.run.app',
      authToken: 'prompted-token',
    })
  })

  it('emits JSON with --json', async () => {
    const home = await makeHome()
    const { deps, cap } = capture()
    await runLoginCommand(
      ['--endpoint', 'https://h.run.app', '--token', 't', '--json'],
      { ...deps, home, fetchImpl: fetchReturning(200), env: {} },
    )
    expect(JSON.parse(cap.out.join('\n'))).toEqual({
      status: 'logged-in',
      profile: 'hosted',
      endpoint: 'https://h.run.app',
    })
  })
})

describe('runLogoutCommand', () => {
  it('clears the active pointer, keeping the profile', async () => {
    const home = await makeHome()
    await upsertProfile({ name: 'hosted', endpoint: 'https://h.run.app', authToken: 't' }, { home })
    const { deps, cap } = capture()
    const code = await runLogoutCommand([], { ...deps, home })
    expect(code).toBe(0)
    expect(cap.out.join('\n')).toContain('Logged out')
    expect(await getActiveProfile(home)).toBeUndefined()
    // The profile itself is kept.
    expect(await resolveProfile('hosted', home)).toBeDefined()
  })

  it('says so when not logged in', async () => {
    const home = await makeHome()
    const { deps, cap } = capture()
    const code = await runLogoutCommand([], { ...deps, home })
    expect(code).toBe(0)
    expect(cap.out.join('\n')).toContain('Not logged in')
  })

  it('--name removes a profile outright', async () => {
    const home = await makeHome()
    await upsertProfile({ name: 'hosted', endpoint: 'https://h.run.app', authToken: 't' }, { home })
    const { deps } = capture()
    const code = await runLogoutCommand(['--name', 'hosted'], { ...deps, home })
    expect(code).toBe(0)
    expect(await resolveProfile('hosted', home)).toBeUndefined()
  })

  it('--name on an unknown profile is exit 1', async () => {
    const home = await makeHome()
    const { deps, cap } = capture()
    const code = await runLogoutCommand(['--name', 'ghost'], { ...deps, home })
    expect(code).toBe(1)
    expect(cap.err.join('\n')).toContain('no profile named')
  })
})

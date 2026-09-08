import { describe, it, expect, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  PROFILES_CONFIG_VERSION,
  profilesConfigPath,
  readProfilesConfig,
  resolveProfile,
  getActiveProfile,
  upsertProfile,
  removeProfile,
  setActiveProfile,
} from '../src/profiles.js'

// docs/contracts/client-profiles.md §4 — `~/.neat/profiles.json` is the per-user
// client address book of remote NEATs, `{ name, endpoint, authToken? }` per
// entry. This module owns the file: it never coordinates daemons and holds the
// bearer at rest under 0600.

const tmpDirs: string[] = []

async function makeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-profiles-'))
  const real = await fs.realpath(dir)
  tmpDirs.push(real)
  return real
}

async function writeRaw(home: string, contents: string, mode = 0o600): Promise<string> {
  const file = profilesConfigPath(home)
  await fs.writeFile(file, contents)
  await fs.chmod(file, mode)
  return file
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

describe('readProfilesConfig', () => {
  it('a missing file is the un-configured case — empty list, never an error', async () => {
    const home = await makeHome()
    expect(await readProfilesConfig(home)).toEqual({
      version: PROFILES_CONFIG_VERSION,
      profiles: [],
    })
  })

  it('reads and validates a well-formed file', async () => {
    const home = await makeHome()
    await writeRaw(
      home,
      JSON.stringify({
        version: 1,
        active: 'hosted',
        profiles: [
          { name: 'hosted', endpoint: 'https://neat-acme.run.app', authToken: 'daemon-tok' },
          { name: 'local', endpoint: 'http://localhost:8080' },
        ],
      }),
    )
    const config = await readProfilesConfig(home)
    expect(config.active).toBe('hosted')
    expect(config.profiles).toHaveLength(2)
    expect(config.profiles[0]).toEqual({
      name: 'hosted',
      endpoint: 'https://neat-acme.run.app',
      authToken: 'daemon-tok',
    })
    // No authToken key at all when absent, not authToken: undefined.
    expect('authToken' in config.profiles[1]!).toBe(false)
  })

  it('throws a clear error on malformed JSON', async () => {
    const home = await makeHome()
    await writeRaw(home, '{ not json')
    await expect(readProfilesConfig(home)).rejects.toThrow(/not valid JSON/)
  })

  it('rejects a non-http(s) endpoint', async () => {
    const home = await makeHome()
    await writeRaw(
      home,
      JSON.stringify({ version: 1, profiles: [{ name: 'x', endpoint: 'ftp://nope' }] }),
    )
    await expect(readProfilesConfig(home)).rejects.toThrow(/http\(s\) URL/)
  })

  it('rejects a bare-host endpoint that is not a URL', async () => {
    const home = await makeHome()
    await writeRaw(
      home,
      JSON.stringify({ version: 1, profiles: [{ name: 'x', endpoint: 'neat-acme.run.app' }] }),
    )
    await expect(readProfilesConfig(home)).rejects.toThrow(/absolute URL/)
  })

  it('rejects duplicate profile names', async () => {
    const home = await makeHome()
    await writeRaw(
      home,
      JSON.stringify({
        version: 1,
        profiles: [
          { name: 'dup', endpoint: 'http://localhost:8080' },
          { name: 'dup', endpoint: 'http://localhost:8081' },
        ],
      }),
    )
    await expect(readProfilesConfig(home)).rejects.toThrow(/duplicate profile name/)
  })

  it('treats a dangling active pointer as unset rather than erroring', async () => {
    const home = await makeHome()
    await writeRaw(
      home,
      JSON.stringify({
        version: 1,
        active: 'ghost',
        profiles: [{ name: 'local', endpoint: 'http://localhost:8080' }],
      }),
    )
    const config = await readProfilesConfig(home)
    expect(config.active).toBeUndefined()
  })

  it('warns but still reads a file looser than 0600', async () => {
    if (process.platform === 'win32') return
    const home = await makeHome()
    await writeRaw(
      home,
      JSON.stringify({ version: 1, profiles: [{ name: 'local', endpoint: 'http://localhost:8080' }] }),
      0o644,
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = await readProfilesConfig(home)
    expect(config.profiles).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('looser than the 0600'))
  })
})

describe('resolveProfile / getActiveProfile', () => {
  it('resolveProfile returns the named profile or undefined', async () => {
    const home = await makeHome()
    await upsertProfile({ name: 'hosted', endpoint: 'https://h.run.app', authToken: 't' }, { home })
    expect(await resolveProfile('hosted', home)).toMatchObject({ name: 'hosted' })
    expect(await resolveProfile('missing', home)).toBeUndefined()
  })

  it('getActiveProfile returns the active profile, undefined when none set', async () => {
    const home = await makeHome()
    expect(await getActiveProfile(home)).toBeUndefined()
    await upsertProfile({ name: 'hosted', endpoint: 'https://h.run.app', authToken: 't' }, { home })
    expect(await getActiveProfile(home)).toMatchObject({ name: 'hosted' })
  })
})

describe('upsertProfile', () => {
  it('the first profile written becomes active', async () => {
    const home = await makeHome()
    await upsertProfile({ name: 'hosted', endpoint: 'https://h.run.app', authToken: 't' }, { home })
    const config = await readProfilesConfig(home)
    expect(config.active).toBe('hosted')
    expect(config.profiles).toHaveLength(1)
  })

  it('a later profile does not steal active unless asked', async () => {
    const home = await makeHome()
    await upsertProfile({ name: 'hosted', endpoint: 'https://h.run.app' }, { home })
    await upsertProfile({ name: 'other', endpoint: 'https://o.run.app' }, { home })
    expect((await readProfilesConfig(home)).active).toBe('hosted')
    await upsertProfile({ name: 'other', endpoint: 'https://o.run.app' }, { home, makeActive: true })
    expect((await readProfilesConfig(home)).active).toBe('other')
  })

  it('replaces an existing profile by name in place', async () => {
    const home = await makeHome()
    await upsertProfile({ name: 'hosted', endpoint: 'https://old.run.app', authToken: 'a' }, { home })
    await upsertProfile({ name: 'hosted', endpoint: 'https://new.run.app', authToken: 'b' }, { home })
    const config = await readProfilesConfig(home)
    expect(config.profiles).toHaveLength(1)
    expect(config.profiles[0]).toMatchObject({ endpoint: 'https://new.run.app', authToken: 'b' })
  })

  it('validates the endpoint before it reaches disk', async () => {
    const home = await makeHome()
    await expect(
      upsertProfile({ name: 'bad', endpoint: 'not-a-url' }, { home }),
    ).rejects.toThrow(/absolute URL/)
  })

  it('writes the file mode 0600', async () => {
    if (process.platform === 'win32') return
    const home = await makeHome()
    await upsertProfile({ name: 'hosted', endpoint: 'https://h.run.app', authToken: 't' }, { home })
    const stat = await fs.stat(profilesConfigPath(home))
    expect(stat.mode & 0o777).toBe(0o600)
  })
})

describe('removeProfile / setActiveProfile', () => {
  it('removeProfile drops the entry and clears active when it was the active one', async () => {
    const home = await makeHome()
    await upsertProfile({ name: 'hosted', endpoint: 'https://h.run.app', authToken: 't' }, { home })
    expect(await removeProfile('hosted', home)).toBe(true)
    const config = await readProfilesConfig(home)
    expect(config.profiles).toHaveLength(0)
    expect(config.active).toBeUndefined()
  })

  it('removeProfile returns false when nothing matched', async () => {
    const home = await makeHome()
    expect(await removeProfile('ghost', home)).toBe(false)
  })

  it('setActiveProfile points at an existing profile, throws otherwise', async () => {
    const home = await makeHome()
    await upsertProfile({ name: 'a', endpoint: 'https://a.run.app' }, { home })
    await upsertProfile({ name: 'b', endpoint: 'https://b.run.app' }, { home })
    await setActiveProfile('b', home)
    expect((await readProfilesConfig(home)).active).toBe('b')
    await expect(setActiveProfile('ghost', home)).rejects.toThrow(/no profile named/)
  })
})

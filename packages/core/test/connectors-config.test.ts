import { describe, it, expect, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  CONNECTORS_CONFIG_VERSION,
  EnvRefUnsetError,
  connectorMatchesProject,
  connectorsConfigPath,
  readConnectorsConfig,
  resolveCredential,
  type ConnectorEntry,
} from '../src/connectors-config.js'

// docs/contracts/connector-config.md §1 (read/0600), §2 (env-ref resolution),
// §6 (project match). The reader owns `~/.neat/connectors.json`; a secret
// resolves only in memory and the file itself holds a pointer by default.

const tmpDirs: string[] = []

async function makeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-connectors-cfg-'))
  const real = await fs.realpath(dir)
  tmpDirs.push(real)
  return real
}

async function writeConfig(home: string, contents: string, mode = 0o600): Promise<string> {
  const file = connectorsConfigPath(home)
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

describe('readConnectorsConfig', () => {
  it('a missing file is the un-configured case — empty list, never an error', async () => {
    const home = await makeHome()
    const config = await readConnectorsConfig(home)
    expect(config).toEqual({ version: CONNECTORS_CONFIG_VERSION, connectors: [] })
  })

  it('reads and validates a well-formed file', async () => {
    const home = await makeHome()
    await writeConfig(
      home,
      JSON.stringify({
        version: 1,
        connectors: [
          {
            id: 'supabase-prod',
            provider: 'supabase',
            project: 'brief',
            credential: '$SUPABASE_KEY',
            options: { apiProjectRef: 'abcdefghijklmnopqrst', nodeRef: 'x.supabase.co', serviceName: 'api' },
          },
        ],
      }),
    )
    const config = await readConnectorsConfig(home)
    expect(config.connectors).toHaveLength(1)
    const entry = config.connectors[0]
    expect(entry.id).toBe('supabase-prod')
    expect(entry.provider).toBe('supabase')
    expect(entry.project).toBe('brief')
    expect(entry.credential).toBe('$SUPABASE_KEY')
    expect(entry.options).toMatchObject({ serviceName: 'api' })
  })

  it('accepts a multi-field credential object', async () => {
    const home = await makeHome()
    await writeConfig(
      home,
      JSON.stringify({
        connectors: [
          {
            id: 'fb',
            provider: 'firebase',
            credential: { projectId: '$FB_PROJECT', accessToken: '$FB_TOKEN' },
          },
        ],
      }),
    )
    const config = await readConnectorsConfig(home)
    expect(config.connectors[0].credential).toEqual({
      projectId: '$FB_PROJECT',
      accessToken: '$FB_TOKEN',
    })
  })

  it('a file with no version reads as the current version', async () => {
    const home = await makeHome()
    await writeConfig(home, JSON.stringify({ connectors: [] }))
    const config = await readConnectorsConfig(home)
    expect(config.version).toBe(CONNECTORS_CONFIG_VERSION)
  })

  it('malformed JSON throws a clear error, not a crash', async () => {
    const home = await makeHome()
    await writeConfig(home, '{ this is not json ')
    await expect(readConnectorsConfig(home)).rejects.toThrow(/not valid JSON/)
  })

  it('a non-object top level is rejected', async () => {
    const home = await makeHome()
    await writeConfig(home, JSON.stringify([{ id: 'x' }]))
    await expect(readConnectorsConfig(home)).rejects.toThrow(/must be a JSON object/)
  })

  it('an entry missing id is rejected with the offending index', async () => {
    const home = await makeHome()
    await writeConfig(
      home,
      JSON.stringify({ connectors: [{ provider: 'supabase', credential: '$K' }] }),
    )
    await expect(readConnectorsConfig(home)).rejects.toThrow(/connectors\[0\]\.id/)
  })

  it('an empty credential is rejected', async () => {
    const home = await makeHome()
    await writeConfig(
      home,
      JSON.stringify({ connectors: [{ id: 'x', provider: 'supabase', credential: '' }] }),
    )
    await expect(readConnectorsConfig(home)).rejects.toThrow(/credential must be a non-empty string/)
  })

  it.runIf(process.platform !== 'win32')(
    'warns when the file is looser than 0600 but still reads it',
    async () => {
      const home = await makeHome()
      await writeConfig(home, JSON.stringify({ connectors: [] }), 0o644)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const config = await readConnectorsConfig(home)
      expect(config.connectors).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toMatch(/looser than the 0600/)
    },
  )

  it.runIf(process.platform !== 'win32')('does not warn on a correct 0600 file', async () => {
    const home = await makeHome()
    await writeConfig(home, JSON.stringify({ connectors: [] }), 0o600)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await readConnectorsConfig(home)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('resolveCredential', () => {
  it('resolves a single env-ref against the environment', () => {
    const resolved = resolveCredential('$SUPABASE_KEY', { SUPABASE_KEY: 'sk_live_abc' })
    expect(resolved).toEqual({ kind: 'single', value: 'sk_live_abc' })
  })

  it('surfaces an unset env-ref by name — not a silent empty value', () => {
    expect(() => resolveCredential('$SUPABASE_KEY', {})).toThrow(EnvRefUnsetError)
    try {
      resolveCredential('$SUPABASE_KEY', {})
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnvRefUnsetError)
      expect((err as Error).message).toBe('$SUPABASE_KEY is unset')
      expect((err as EnvRefUnsetError).varName).toBe('SUPABASE_KEY')
    }
  })

  it('treats an env var set to empty string as unset', () => {
    expect(() => resolveCredential('$SUPABASE_KEY', { SUPABASE_KEY: '' })).toThrow(
      /\$SUPABASE_KEY is unset/,
    )
  })

  it('passes a plaintext credential through unchanged (explicit opt-in)', () => {
    const resolved = resolveCredential('sk_live_plaintext', {})
    expect(resolved).toEqual({ kind: 'single', value: 'sk_live_plaintext' })
  })

  it('resolves each field of a multi-field credential', () => {
    const resolved = resolveCredential(
      { projectId: '$FB_PROJECT', accessToken: '$FB_TOKEN' },
      { FB_PROJECT: 'my-app', FB_TOKEN: 'ya29.token' },
    )
    expect(resolved).toEqual({
      kind: 'fields',
      fields: { projectId: 'my-app', accessToken: 'ya29.token' },
    })
  })

  it('names the specific unset field in a multi-field credential', () => {
    expect(() =>
      resolveCredential(
        { projectId: '$FB_PROJECT', accessToken: '$FB_TOKEN' },
        { FB_PROJECT: 'my-app' },
      ),
    ).toThrow(/\$FB_TOKEN is unset/)
  })

  it('mixes a plaintext field with an env-ref field', () => {
    const resolved = resolveCredential(
      { projectId: 'my-app', accessToken: '$FB_TOKEN' },
      { FB_TOKEN: 'ya29.token' },
    )
    expect(resolved).toEqual({
      kind: 'fields',
      fields: { projectId: 'my-app', accessToken: 'ya29.token' },
    })
  })
})

describe('connectorMatchesProject', () => {
  const base: ConnectorEntry = { id: 'x', provider: 'supabase', credential: '$K' }

  it('an entry with no project binds to whatever project is bootstrapping', () => {
    expect(connectorMatchesProject(base, 'brief')).toBe(true)
    expect(connectorMatchesProject(base, 'newdryve')).toBe(true)
  })

  it('an entry naming a project matches only that one', () => {
    const entry = { ...base, project: 'brief' }
    expect(connectorMatchesProject(entry, 'brief')).toBe(true)
    expect(connectorMatchesProject(entry, 'newdryve')).toBe(false)
  })
})

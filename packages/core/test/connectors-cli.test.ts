import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { runConnectorCommand, type PromptFn } from '../src/connectors-cli.js'
import {
  validateConnector,
  ConnectorConfigError,
} from '../src/connectors/registry.js'
import {
  EnvRefUnsetError,
  readConnectorsConfig,
  connectorsConfigPath,
  type ConnectorEntry,
} from '../src/connectors-config.js'

// docs/contracts/connector-config.md §3 (the neat connector command family),
// §4 (validate-on-add default; "$VAR is unset" ≠ validation failure), §2
// (env-ref default, plaintext opt-in, redaction). These drive the exported
// `runConnectorCommand` against an isolated temp NEAT_HOME — no real ~/.neat,
// no live provider account. The provider auth round-trip is either an injected
// fake (CLI-level tests) or a stubbed global fetch (validateConnector tests).

let home: string
let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-connector-cli-')))
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(home, { recursive: true, force: true }).catch(() => {})
})

function logged(): string {
  return logSpy.mock.calls.map((c) => c.map((x) => String(x)).join(' ')).join('\n')
}
function errored(): string {
  return errSpy.mock.calls.map((c) => c.map((x) => String(x)).join(' ')).join('\n')
}
async function readEntries(): Promise<ConnectorEntry[]> {
  return (await readConnectorsConfig(home)).connectors
}
// A validate that always accepts — the injected stand-in for a real round-trip.
const validateOk = async (): Promise<void> => {}
// A prompt that answers from a queue, in ask order.
function queuedPrompt(answers: string[]): PromptFn {
  let i = 0
  return async () => answers[i++] ?? ''
}

describe('neat connector add', () => {
  it('stores an env-ref credential as a pointer, never a resolved secret', async () => {
    // The env var is set, but the file must still hold the pointer, not the value.
    process.env.CLI_TEST_CF = 'cf_secret_value'
    try {
      const code = await runConnectorCommand(
        ['add', 'cloudflare', '--account-id', 'a1', '--workers', '{}', '--credential', '$CLI_TEST_CF'],
        { home, validate: validateOk },
      )
      expect(code).toBe(0)
      const entries = await readEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0].credential).toBe('$CLI_TEST_CF')
      // The resolved secret never appears on disk or in the confirmation.
      const raw = await fs.readFile(connectorsConfigPath(home), 'utf8')
      expect(raw).not.toContain('cf_secret_value')
      expect(logged()).not.toContain('cf_secret_value')
    } finally {
      delete process.env.CLI_TEST_CF
    }
  })

  it('stores a plaintext credential as a literal (explicit opt-in)', async () => {
    const code = await runConnectorCommand(
      ['add', 'railway', '--environment-id', 'e', '--service-id', 's', '--service-name-by-id', '{"s":"api"}', '--token', 'railway_literal'],
      { home, validate: validateOk },
    )
    expect(code).toBe(0)
    const entries = await readEntries()
    expect(entries[0].credential).toBe('railway_literal')
    // But it's never printed back — the confirmation redacts it to ****.
    expect(logged()).toContain('****')
    expect(logged()).not.toContain('railway_literal')
  })

  it('auto-slugs the id from the provider, disambiguating by project on collision', async () => {
    await runConnectorCommand(
      ['add', 'cloudflare', '--account-id', 'a1', '--workers', '{}', '--credential', '$X1', '--project', 'brief', '--skip-validate'],
      { home },
    )
    await runConnectorCommand(
      ['add', 'cloudflare', '--account-id', 'a2', '--workers', '{}', '--credential', '$X2', '--project', 'newdryve', '--skip-validate'],
      { home },
    )
    await runConnectorCommand(
      ['add', 'cloudflare', '--account-id', 'a3', '--workers', '{}', '--credential', '$X3', '--skip-validate'],
      { home },
    )
    const ids = (await readEntries()).map((e) => e.id)
    expect(ids).toEqual(['cloudflare', 'cloudflare-newdryve', 'cloudflare-2'])
  })

  it('honors an explicit --id', async () => {
    await runConnectorCommand(
      ['add', 'cloudflare', '--id', 'cf-primary', '--account-id', 'a', '--workers', '{}', '--credential', '$X', '--skip-validate'],
      { home },
    )
    expect((await readEntries())[0].id).toBe('cf-primary')
  })

  it('an unset env-ref is a distinct failure, not a validation failure, and writes nothing', async () => {
    // No --skip-validate → validate runs. The var is unset, so the real
    // validateConnector throws EnvRefUnsetError before any network call.
    delete process.env.CLI_TEST_UNSET
    const code = await runConnectorCommand(
      ['add', 'cloudflare', '--account-id', 'a', '--workers', '{}', '--credential', '$CLI_TEST_UNSET'],
      { home }, // real validate, no inject
    )
    expect(code).toBe(1)
    expect(errored()).toContain('$CLI_TEST_UNSET is unset')
    // The message is about an unset variable, not a rejected credential.
    expect(errored()).not.toMatch(/rejected/i)
    // Nothing was written.
    expect(await readEntries()).toEqual([])
  })

  it('a provider rejecting the credential is a validation failure that writes nothing', async () => {
    const rejecting = async (): Promise<void> => {
      throw new Error('telemetry query failed (401 Unauthorized)')
    }
    const code = await runConnectorCommand(
      ['add', 'cloudflare', '--account-id', 'a', '--workers', '{}', '--credential', '$SET_TOKEN'],
      { home, validate: rejecting },
    )
    expect(code).toBe(1)
    expect(errored()).toMatch(/rejected the credential/)
    expect(errored()).toContain('401')
    expect(await readEntries()).toEqual([])
  })

  it('--skip-validate bypasses the round-trip and writes even with an unset env-ref', async () => {
    delete process.env.CLI_TEST_UNSET2
    const validate = vi.fn(validateOk)
    const code = await runConnectorCommand(
      ['add', 'cloudflare', '--account-id', 'a', '--workers', '{}', '--credential', '$CLI_TEST_UNSET2', '--skip-validate'],
      { home, validate },
    )
    expect(code).toBe(0)
    expect(validate).not.toHaveBeenCalled()
    expect(await readEntries()).toHaveLength(1)
    expect(logged()).toMatch(/validation skipped/)
  })

  it('writes the file at mode 0600', async () => {
    await runConnectorCommand(
      ['add', 'cloudflare', '--account-id', 'a', '--workers', '{}', '--credential', '$X', '--skip-validate'],
      { home },
    )
    if (process.platform === 'win32') return
    const stat = await fs.stat(connectorsConfigPath(home))
    expect((stat.mode & 0o777).toString(8)).toBe('600')
  })

  it('leaves no temp file behind after an atomic write', async () => {
    await runConnectorCommand(
      ['add', 'cloudflare', '--account-id', 'a', '--workers', '{}', '--credential', '$X', '--skip-validate'],
      { home },
    )
    const files = await fs.readdir(home)
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('gathers missing fields through interactive prompts', async () => {
    // `add cloudflare` with no flags → prompts for project, credential, then
    // each required option in order.
    const prompt = queuedPrompt(['brief', '$CF_TOKEN', 'acct-9', '{}'])
    const code = await runConnectorCommand(['add', 'cloudflare'], { home, prompt, validate: validateOk })
    expect(code).toBe(0)
    const entry = (await readEntries())[0]
    expect(entry.provider).toBe('cloudflare')
    expect(entry.project).toBe('brief')
    expect(entry.credential).toBe('$CF_TOKEN')
    expect(entry.options).toMatchObject({ accountId: 'acct-9', workers: {} })
  })

  it('errors (misuse) when a required field is missing and no prompt is available', async () => {
    const code = await runConnectorCommand(
      ['add', 'cloudflare', '--credential', '$X', '--skip-validate'], // accountId + workers missing, no prompt
      { home },
    )
    expect(code).toBe(2)
    expect(errored()).toMatch(/missing required option/)
    expect(await readEntries()).toEqual([])
  })

  it('rejects an unknown provider as misuse', async () => {
    const code = await runConnectorCommand(['add', 'notaprovider', '--credential', '$X'], { home })
    expect(code).toBe(2)
    expect(errored()).toMatch(/unknown provider/)
  })

  it('gathers a multi-field firebase credential as an object of pointers', async () => {
    const code = await runConnectorCommand(
      ['add', 'firebase', '--credential-project-id', '$FB_PROJECT', '--credential-access-token', '$FB_TOKEN', '--skip-validate'],
      { home },
    )
    expect(code).toBe(0)
    expect((await readEntries())[0].credential).toEqual({
      projectId: '$FB_PROJECT',
      accessToken: '$FB_TOKEN',
    })
  })
})

describe('neat connector list', () => {
  beforeEach(async () => {
    await runConnectorCommand(
      ['add', 'cloudflare', '--account-id', 'a', '--workers', '{}', '--credential', '$CF_LIST', '--project', 'brief', '--skip-validate'],
      { home },
    )
    await runConnectorCommand(
      ['add', 'railway', '--environment-id', 'e', '--service-id', 's', '--service-name-by-id', '{"s":"api"}', '--token', 'railway_plain_secret', '--skip-validate'],
      { home },
    )
    logSpy.mockClear()
  })

  it('shows each entry with its credential redacted — never a resolved secret', async () => {
    process.env.CF_LIST = 'cf_resolved_value'
    try {
      const code = await runConnectorCommand(['list'], { home })
      expect(code).toBe(0)
      const out = logged()
      expect(out).toContain('$CF_LIST') // the pointer is safe to show
      expect(out).toContain('****') // the plaintext literal is masked
      expect(out).not.toContain('cf_resolved_value') // never the resolved value
      expect(out).not.toContain('railway_plain_secret') // never the literal
    } finally {
      delete process.env.CF_LIST
    }
  })

  it('reports env-ref resolution status per entry', async () => {
    delete process.env.CF_LIST
    await runConnectorCommand(['list'], { home })
    expect(logged()).toMatch(/env unset/)
  })

  it('--json stays redacted', async () => {
    process.env.CF_LIST = 'cf_resolved_value'
    try {
      await runConnectorCommand(['list', '--json'], { home })
      const out = logged()
      const rows = JSON.parse(out)
      expect(rows).toHaveLength(2)
      expect(out).not.toContain('cf_resolved_value')
      expect(out).not.toContain('railway_plain_secret')
    } finally {
      delete process.env.CF_LIST
    }
  })

  it('filters by --project', async () => {
    await runConnectorCommand(['list', '--project', 'brief'], { home })
    const out = logged()
    expect(out).toContain('cloudflare')
    expect(out).not.toContain('railway')
  })
})

describe('neat connector remove', () => {
  beforeEach(async () => {
    await runConnectorCommand(
      ['add', 'cloudflare', '--id', 'cf-1', '--account-id', 'a', '--workers', '{}', '--credential', '$X', '--skip-validate'],
      { home },
    )
    logSpy.mockClear()
  })

  it('removes by id', async () => {
    const code = await runConnectorCommand(['remove', 'cf-1'], { home })
    expect(code).toBe(0)
    expect(logged()).toContain('removed connector "cf-1"')
    expect(await readEntries()).toEqual([])
  })

  it('reports a clear error for an unknown id and keeps the file intact', async () => {
    const code = await runConnectorCommand(['remove', 'ghost'], { home })
    expect(code).toBe(1)
    expect(errored()).toContain('no connector with id "ghost"')
    expect(await readEntries()).toHaveLength(1)
  })

  it('is misuse without an id', async () => {
    const code = await runConnectorCommand(['remove'], { home })
    expect(code).toBe(2)
    expect(errored()).toMatch(/missing <id>/)
  })
})

describe('neat connector test', () => {
  beforeEach(async () => {
    await runConnectorCommand(
      ['add', 'cloudflare', '--id', 'cf-1', '--account-id', 'a', '--workers', '{}', '--credential', '$CF_TEST', '--skip-validate'],
      { home },
    )
    logSpy.mockClear()
    errSpy.mockClear()
  })

  it('reports ok when the provider accepts the credential', async () => {
    const code = await runConnectorCommand(['test', 'cf-1'], { home, validate: validateOk })
    expect(code).toBe(0)
    expect(logged()).toMatch(/^ok: "cf-1"/)
  })

  it('reports an unset env-ref distinctly from a rejection', async () => {
    const unset = async (): Promise<void> => {
      throw new EnvRefUnsetError('$CF_TEST', 'CF_TEST')
    }
    const code = await runConnectorCommand(['test', 'cf-1'], { home, validate: unset })
    expect(code).toBe(1)
    expect(errored()).toContain('$CF_TEST is unset')
    expect(errored()).not.toMatch(/rejected/i)
  })

  it('reports a rejected credential as a validation failure', async () => {
    const rejecting = async (): Promise<void> => {
      throw new Error('telemetry query failed (403 Forbidden)')
    }
    const code = await runConnectorCommand(['test', 'cf-1'], { home, validate: rejecting })
    expect(code).toBe(1)
    expect(errored()).toMatch(/rejected the credential/)
    expect(errored()).toContain('403')
  })

  it('errors when the id is unknown', async () => {
    const code = await runConnectorCommand(['test', 'nope'], { home })
    expect(code).toBe(1)
    expect(errored()).toContain('no connector with id "nope"')
  })
})

// The validate round-trip itself (registry.ts), exercised through a stubbed
// global fetch so the connector's own poll()/auth path runs end to end without
// a live Cloudflare account. junctionFetch reads globalThis.fetch at call time.
describe('validateConnector round-trip (contract §4)', () => {
  const cfEntry: ConnectorEntry = {
    id: 'cf',
    provider: 'cloudflare',
    credential: '$CF_VALIDATE',
    options: { accountId: 'acct', workers: {} },
  }

  function fakeResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Unauthorized',
      json: async () => body,
    } as unknown as Response
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves when the provider accepts the credential (200)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(200, { success: true, result: { events: { events: [] } } })),
    )
    await expect(
      validateConnector(cfEntry, { env: { CF_VALIDATE: 'good_token' } }),
    ).resolves.toBeUndefined()
  })

  it('throws the provider error when the credential is rejected (401)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(401, { success: false, errors: [{ message: 'bad token' }] })))
    await expect(
      validateConnector(cfEntry, { env: { CF_VALIDATE: 'wrong_token' } }),
    ).rejects.toThrow(/telemetry query failed \(401/)
  })

  it('throws EnvRefUnsetError (distinct) when the env-ref is unset — before any fetch', async () => {
    const fetchSpy = vi.fn(async () => fakeResponse(200, {}))
    vi.stubGlobal('fetch', fetchSpy)
    await expect(validateConnector(cfEntry, { env: {} })).rejects.toBeInstanceOf(EnvRefUnsetError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws ConnectorConfigError for a misconfigured entry (missing option)', async () => {
    const bad: ConnectorEntry = { id: 'x', provider: 'cloudflare', credential: '$CF_VALIDATE', options: {} }
    await expect(
      validateConnector(bad, { env: { CF_VALIDATE: 'tok' } }),
    ).rejects.toBeInstanceOf(ConnectorConfigError)
  })
})

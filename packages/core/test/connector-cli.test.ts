import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  parseConnectorArgs,
  runConnectorCommand,
  type ConnectorCliDeps,
} from '../src/connector-cli.js'
import { connectorsConfigPath, readConnectorsConfig } from '../src/connectors-config.js'

// docs/contracts/connector-config.md §2 (env-ref default / plaintext opt-in),
// §3 (the verb family), §4 (validate-on-add; unset-env ≠ rejection). The write
// side: env-ref stored as a pointer, atomic 0600 writes, a redacted `list`, and
// the three distinct validation outcomes — all exercised against a temp home
// and a stubbed provider, never a live account.

const tmpDirs: string[] = []

async function makeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-connector-cli-'))
  const real = await fs.realpath(dir)
  tmpDirs.push(real)
  return path.join(real, 'neat')
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

// A fake `fetch` standing in for a provider's auth path (contract §4 round-trip
// against a stub). `calls` records every URL so a test can assert validation
// was or wasn't attempted.
function stubFetch(status: number): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url))
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : status === 401 ? 'Unauthorized' : 'Error',
      json: async () => ({}),
    } as Response
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

interface Captured {
  out: string[]
  err: string[]
  code: number
}

async function run(args: string[], deps: Partial<ConnectorCliDeps>): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const code = await runConnectorCommand(args, {
    interactive: false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...deps,
  })
  return { out, err, code }
}

const SUPABASE_OPTS = [
  '--api-project-ref',
  'abcdefghijklmnopqrst',
  '--node-ref',
  'x.supabase.co',
  '--service-name',
  'api',
]

describe('parseConnectorArgs', () => {
  it('splits subcommand, positionals, known flags, and generic provider fields', () => {
    const r = parseConnectorArgs([
      'add',
      'supabase',
      '--project',
      'brief',
      '--token',
      '$SUPABASE_KEY',
      '--account-id',
      'acct-123',
      '--skip-validate',
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.subcommand).toBe('add')
    expect(r.value.positional).toEqual(['supabase'])
    expect(r.value.project).toBe('brief')
    expect(r.value.credential).toBe('$SUPABASE_KEY')
    expect(r.value.fields.accountId).toBe('acct-123')
    expect(r.value.skipValidate).toBe(true)
  })

  it('kebab flags become camelCase fields and JSON values parse', () => {
    const r = parseConnectorArgs(['add', 'cloudflare', '--workers', '{"w":{"service":"api"}}'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.fields.workers).toEqual({ w: { service: 'api' } })
  })

  it('supports --flag=value form', () => {
    const r = parseConnectorArgs(['add', 'supabase', '--project=brief'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.project).toBe('brief')
  })

  it('a value-flag with no value is an error', () => {
    const r = parseConnectorArgs(['add', 'supabase', '--project'])
    expect(r.ok).toBe(false)
  })
})

describe('connector add', () => {
  it('stores an env-ref credential as a pointer, never resolved (contract §2)', async () => {
    const home = await makeHome()
    const { code } = await run(
      ['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'],
      { home, env: { SUPABASE_KEY: 'sk_live_secret' } },
    )
    expect(code).toBe(0)
    const config = await readConnectorsConfig(home)
    expect(config.connectors).toHaveLength(1)
    expect(config.connectors[0].credential).toBe('$SUPABASE_KEY')
    // The resolved secret never lands on disk.
    const raw = await fs.readFile(connectorsConfigPath(home), 'utf8')
    expect(raw).not.toContain('sk_live_secret')
  })

  it('accepts the Supabase-specific --management-token flag as the primary credential', async () => {
    const home = await makeHome()
    const { code } = await run(
      ['add', 'supabase', '--management-token', '$SUPABASE_MGMT_TOKEN', ...SUPABASE_OPTS, '--skip-validate'],
      { home, env: { SUPABASE_MGMT_TOKEN: 'not-a-real-management-token' } },
    )
    expect(code).toBe(0)
    const config = await readConnectorsConfig(home)
    expect(config.connectors[0].credential).toBe('$SUPABASE_MGMT_TOKEN')
    expect(config.connectors[0].options).not.toHaveProperty('managementToken')
    const raw = await fs.readFile(connectorsConfigPath(home), 'utf8')
    expect(raw).not.toContain('not-a-real-management-token')
  })

  it('auto-slugs the id from provider, disambiguating a repeat by project', async () => {
    const home = await makeHome()
    const env = { SUPABASE_KEY: 'x' }
    await run(['add', 'supabase', '--project', 'brief', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { home, env })
    await run(['add', 'supabase', '--project', 'newdryve', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { home, env })
    await run(['add', 'supabase', '--project', 'brief', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { home, env })
    const config = await readConnectorsConfig(home)
    expect(config.connectors.map((c) => c.id)).toEqual(['supabase', 'supabase-newdryve', 'supabase-brief'])
  })

  it('honors an explicit --id', async () => {
    const home = await makeHome()
    const { code } = await run(
      ['add', 'supabase', '--id', 'my-sb', '--credential', '$K', ...SUPABASE_OPTS, '--skip-validate'],
      { home, env: { K: 'x' } },
    )
    expect(code).toBe(0)
    const config = await readConnectorsConfig(home)
    expect(config.connectors[0].id).toBe('my-sb')
  })

  it('writes the file mode 0600 (contract §1)', async () => {
    const home = await makeHome()
    await run(['add', 'supabase', '--credential', '$K', ...SUPABASE_OPTS, '--skip-validate'], { home, env: { K: 'x' } })
    const stat = await fs.stat(connectorsConfigPath(home))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('validate-on-add: an unset env-ref is distinct from a rejection and writes nothing (contract §4)', async () => {
    const home = await makeHome()
    const stub = stubFetch(200)
    const { code, err } = await run(
      ['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS],
      { home, env: {}, fetchImpl: stub.fetch },
    )
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('$SUPABASE_KEY is unset')
    // A resolution failure never reaches the provider…
    expect(stub.calls).toHaveLength(0)
    // …and nothing was written.
    const config = await readConnectorsConfig(home)
    expect(config.connectors).toHaveLength(0)
  })

  it('validate-on-add: the provider rejecting the credential writes nothing', async () => {
    const home = await makeHome()
    const stub = stubFetch(401)
    const { code, err } = await run(
      ['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS],
      { home, env: { SUPABASE_KEY: 'wrong' }, fetchImpl: stub.fetch },
    )
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/rejected the credential/)
    expect(stub.calls.length).toBeGreaterThan(0)
    const config = await readConnectorsConfig(home)
    expect(config.connectors).toHaveLength(0)
  })

  it('validate-on-add: a good credential authenticates and the entry is written', async () => {
    const home = await makeHome()
    const stub = stubFetch(200)
    const { code, out } = await run(
      ['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS],
      { home, env: { SUPABASE_KEY: 'right' }, fetchImpl: stub.fetch },
    )
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/validated against the provider/)
    expect(stub.calls.length).toBeGreaterThan(0)
    const config = await readConnectorsConfig(home)
    expect(config.connectors).toHaveLength(1)
  })

  it('--skip-validate bypasses the round-trip entirely', async () => {
    const home = await makeHome()
    const stub = stubFetch(401)
    const { code } = await run(
      ['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'],
      { home, env: {}, fetchImpl: stub.fetch },
    )
    expect(code).toBe(0)
    expect(stub.calls).toHaveLength(0)
    const config = await readConnectorsConfig(home)
    expect(config.connectors).toHaveLength(1)
  })

  it('a plaintext credential is the explicit opt-in — stored, but warned about', async () => {
    const home = await makeHome()
    const { code, err } = await run(
      ['add', 'supabase', '--credential', 'sk_literal_secret', ...SUPABASE_OPTS, '--skip-validate'],
      { home, env: {} },
    )
    expect(code).toBe(0)
    expect(err.join('\n')).toMatch(/storing a literal secret at rest/)
    const config = await readConnectorsConfig(home)
    expect(config.connectors[0].credential).toBe('sk_literal_secret')
  })

  it('--plaintext silences the at-rest warning', async () => {
    const home = await makeHome()
    const { err } = await run(
      ['add', 'supabase', '--credential', 'sk_literal', ...SUPABASE_OPTS, '--skip-validate', '--plaintext'],
      { home, env: {} },
    )
    expect(err.join('\n')).not.toMatch(/storing a literal secret/)
  })

  it('builds a multi-field credential (firebase) from per-field flags', async () => {
    const home = await makeHome()
    const { code } = await run(
      [
        'add',
        'firebase',
        '--project-id',
        '$FB_PROJECT',
        '--access-token',
        '$FB_TOKEN',
        '--functions',
        '{"myFn":"api"}',
        '--skip-validate',
      ],
      { home, env: { FB_PROJECT: 'app', FB_TOKEN: 'tok' } },
    )
    expect(code).toBe(0)
    const config = await readConnectorsConfig(home)
    expect(config.connectors[0].credential).toEqual({ projectId: '$FB_PROJECT', accessToken: '$FB_TOKEN' })
    expect(config.connectors[0].options).toEqual({ functions: { myFn: 'api' } })
  })

  it('rejects an unknown provider before writing', async () => {
    const home = await makeHome()
    const { code, err } = await run(['add', 'notaprovider', '--skip-validate'], { home, env: {} })
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/unknown provider/)
    await expect(readConnectorsConfig(home)).resolves.toEqual(
      expect.objectContaining({ connectors: [] }),
    )
  })

  it('errors on a missing required option rather than storing a dead entry', async () => {
    const home = await makeHome()
    // nodeRef omitted.
    const { code, err } = await run(
      ['add', 'supabase', '--credential', '$K', '--api-project-ref', 'abcdefghijklmnopqrst', '--service-name', 'api', '--skip-validate'],
      { home, env: { K: 'x' } },
    )
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/missing required option/)
  })

  it('prompts for missing fields when interactive', async () => {
    const home = await makeHome()
    const answers = ['brief', '$SUPABASE_KEY', 'abcdefghijklmnopqrst', 'x.supabase.co', 'api']
    let i = 0
    const { code } = await run(['add', 'supabase', '--skip-validate'], {
      home,
      env: { SUPABASE_KEY: 'x' },
      interactive: true,
      prompt: async () => answers[i++] ?? '',
    })
    expect(code).toBe(0)
    const config = await readConnectorsConfig(home)
    expect(config.connectors[0].project).toBe('brief')
    expect(config.connectors[0].credential).toBe('$SUPABASE_KEY')
  })
})

describe('connector list', () => {
  it('redacts credentials — the resolved secret is never printed', async () => {
    const home = await makeHome()
    const env = { SUPABASE_KEY: 'sk_live_TOPSECRET' }
    await run(['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { home, env })
    const { code, out } = await run(['list'], { home, env })
    expect(code).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('$SUPABASE_KEY (set)')
    expect(text).not.toContain('sk_live_TOPSECRET')
  })

  it('shows env-ref set/unset status and masks plaintext', async () => {
    const home = await makeHome()
    await run(['add', 'supabase', '--id', 'ref', '--credential', '$MISSING', ...SUPABASE_OPTS, '--skip-validate'], { home, env: {} })
    await run(['add', 'supabase', '--id', 'lit', '--credential', 'literal_secret', ...SUPABASE_OPTS, '--skip-validate', '--plaintext'], { home, env: {} })
    const { out } = await run(['list'], { home, env: {} })
    const text = out.join('\n')
    expect(text).toContain('$MISSING (unset)')
    expect(text).toContain('**** (plaintext)')
    expect(text).not.toContain('literal_secret')
  })

  it('filters by --project', async () => {
    const home = await makeHome()
    const env = { K: 'x' }
    await run(['add', 'supabase', '--project', 'brief', '--credential', '$K', ...SUPABASE_OPTS, '--skip-validate'], { home, env })
    await run(['add', 'railway', '--project', 'newdryve', '--credential', '$K', '--environment-id', 'e', '--service-id', 's', '--service-name-by-id', '{"s":"api"}', '--skip-validate'], { home, env })
    const { out } = await run(['list', '--project', 'brief'], { home, env })
    const text = out.join('\n')
    expect(text).toContain('supabase')
    expect(text).not.toContain('railway')
  })

  it('reports an empty config plainly', async () => {
    const home = await makeHome()
    const { code, out } = await run(['list'], { home, env: {} })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/no connectors configured/)
  })
})

describe('connector remove', () => {
  it('removes by id', async () => {
    const home = await makeHome()
    await run(['add', 'supabase', '--id', 'gone', '--credential', '$K', ...SUPABASE_OPTS, '--skip-validate'], { home, env: { K: 'x' } })
    const { code, out } = await run(['remove', 'gone'], { home, env: {} })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/removed connector "gone"/)
    const config = await readConnectorsConfig(home)
    expect(config.connectors).toHaveLength(0)
  })

  it('a missing id is a clear error, exit 1', async () => {
    const home = await makeHome()
    const { code, err } = await run(['remove', 'nope'], { home, env: {} })
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/no connector with id "nope"/)
  })

  it('missing <id> argument is misuse, exit 2', async () => {
    const home = await makeHome()
    const { code } = await run(['remove'], { home, env: {} })
    expect(code).toBe(2)
  })
})

describe('connector test', () => {
  it('ok when the provider authenticates', async () => {
    const home = await makeHome()
    const env = { SUPABASE_KEY: 'right' }
    await run(['add', 'supabase', '--id', 'sb', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { home, env })
    const stub = stubFetch(200)
    const { code, out } = await run(['test', 'sb'], { home, env, fetchImpl: stub.fetch })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/^ok:/m)
  })

  it('unset when the env-ref variable is not set — distinct from rejection', async () => {
    const home = await makeHome()
    await run(['add', 'supabase', '--id', 'sb', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { home, env: { SUPABASE_KEY: 'x' } })
    const stub = stubFetch(200)
    const { code, err } = await run(['test', 'sb'], { home, env: {}, fetchImpl: stub.fetch })
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/^unset:/m)
    expect(err.join('\n')).toContain('$SUPABASE_KEY is unset')
    expect(stub.calls).toHaveLength(0)
  })

  it('rejected when the provider turns the credential down', async () => {
    const home = await makeHome()
    const env = { SUPABASE_KEY: 'wrong' }
    await run(['add', 'supabase', '--id', 'sb', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { home, env })
    const stub = stubFetch(403)
    const { code, err } = await run(['test', 'sb'], { home, env, fetchImpl: stub.fetch })
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/^rejected:/m)
  })

  it('no such id is a clear error', async () => {
    const home = await makeHome()
    const { code, err } = await run(['test', 'ghost'], { home, env: {} })
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/no connector with id "ghost"/)
  })
})

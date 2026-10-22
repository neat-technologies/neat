import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  parseConnectorArgs,
  runConnectorCommand,
  type ConnectorCliDeps,
} from '../src/connector-cli.js'
import {
  connectorsConfigPath,
  projectConnectorsPath,
  readProjectConnectors,
  type ConnectorEntry,
} from '../src/connectors-config.js'
import { ensureProjectIdentity, bindingFilePath } from '../src/project-identity.js'

// docs/contracts/connector-config.md (ADR-273): connectors are scoped to the
// project's own <repo>/.neat/connectors.json, references only. The CLI resolves
// the project at (or above) its cwd — never a machine-wide file — so a connector
// added in one checkout is invisible to another. The machine-level
// ~/.neat/connectors.json is read once to migrate (list surfaces it as
// "unassigned"; `assign` moves one in) and left in place. A hosted-bound project
// routes to the control plane, not a local file. All exercised against temp
// projects and a stubbed provider, never a live account.

const tmpDirs: string[] = []

// A fresh project (a temp repo with .neat/project.json) plus an isolated,
// empty machine-level home so legacy reads never touch the real ~/.neat.
async function makeProject(
  name = 'proj',
  opts: { binding?: 'local' | 'hosted'; org?: string } = {},
): Promise<{ root: string; home: string }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-connector-cli-')))
  tmpDirs.push(dir)
  const root = path.join(dir, 'repo')
  const home = path.join(dir, 'home')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(home, { recursive: true })
  await ensureProjectIdentity(root, { name })
  if (opts.binding === 'hosted') {
    await fs.writeFile(
      bindingFilePath(root),
      `${JSON.stringify({ schemaVersion: 1, binding: 'hosted', org: opts.org ?? 'acme' }, null, 2)}\n`,
    )
  }
  return { root, home }
}

// Seed the machine-level (legacy) connectors.json with raw entries — the
// pre-273 shape, which `list`/`assign` migrate from.
async function seedLegacy(home: string, entries: ConnectorEntry[]): Promise<void> {
  await fs.writeFile(connectorsConfigPath(home), `${JSON.stringify({ version: 1, connectors: entries }, null, 2)}\n`, {
    mode: 0o600,
  })
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
      '/some/checkout',
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
    expect(r.value.project).toBe('/some/checkout')
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
    const r = parseConnectorArgs(['add', 'supabase', '--project=/x'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.project).toBe('/x')
  })

  it('a value-flag with no value is an error', () => {
    const r = parseConnectorArgs(['add', 'supabase', '--project'])
    expect(r.ok).toBe(false)
  })
})

describe('project resolution', () => {
  it('a directory that is not a NEAT project is a clear error (exit 2), no write', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-connector-cli-bare-')))
    tmpDirs.push(dir)
    const { code, err } = await run(['list'], { cwd: dir, home: dir, env: {} })
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/not a NEAT project/)
    expect(err.join('\n')).toMatch(/neat init/)
  })
})

describe('connector add', () => {
  it('stores an env-ref credential as a pointer, never resolved (contract §2)', async () => {
    const { root, home } = await makeProject()
    const { code, out } = await run(
      ['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'],
      { cwd: root, home, env: { SUPABASE_KEY: 'sk_live_secret' } },
    )
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('for this project')
    const config = await readProjectConnectors(root)
    expect(config.connectors).toHaveLength(1)
    expect(config.connectors[0].credential).toBe('$SUPABASE_KEY')
    // The resolved secret never lands on disk, and the file lives in the project.
    const raw = await fs.readFile(projectConnectorsPath(root), 'utf8')
    expect(raw).not.toContain('sk_live_secret')
  })

  it('accepts the Supabase-specific --management-token flag as the primary credential', async () => {
    const { root, home } = await makeProject()
    const { code } = await run(
      ['add', 'supabase', '--management-token', '$SUPABASE_MGMT_TOKEN', ...SUPABASE_OPTS, '--skip-validate'],
      { cwd: root, home, env: { SUPABASE_MGMT_TOKEN: 'not-a-real-management-token' } },
    )
    expect(code).toBe(0)
    const config = await readProjectConnectors(root)
    expect(config.connectors[0].credential).toBe('$SUPABASE_MGMT_TOKEN')
    expect(config.connectors[0].options).not.toHaveProperty('managementToken')
  })

  it('auto-slugs the id, disambiguating a repeat within the project with a counter', async () => {
    const { root, home } = await makeProject()
    const env = { SUPABASE_KEY: 'x' }
    await run(['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { cwd: root, home, env })
    await run(['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { cwd: root, home, env })
    const config = await readProjectConnectors(root)
    expect(config.connectors.map((c) => c.id)).toEqual(['supabase', 'supabase-2'])
  })

  it('drops any legacy project field — the file is the scope now', async () => {
    const { root, home } = await makeProject()
    await run(['add', 'supabase', '--project', root, '--credential', '$K', ...SUPABASE_OPTS, '--skip-validate'], {
      cwd: root,
      home,
      env: { K: 'x' },
    })
    const config = await readProjectConnectors(root)
    expect(config.connectors[0]).not.toHaveProperty('project')
  })

  it('writes the file mode 0600 (contract §1)', async () => {
    const { root, home } = await makeProject()
    await run(['add', 'supabase', '--credential', '$K', ...SUPABASE_OPTS, '--skip-validate'], { cwd: root, home, env: { K: 'x' } })
    const stat = await fs.stat(projectConnectorsPath(root))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('rejects a plaintext credential — a project file is refs-only (ADR-273)', async () => {
    const { root, home } = await makeProject()
    const { code, err } = await run(
      ['add', 'supabase', '--credential', 'sk_literal_secret', ...SUPABASE_OPTS, '--skip-validate'],
      { cwd: root, home, env: {} },
    )
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/must be a reference/)
    const config = await readProjectConnectors(root)
    expect(config.connectors).toHaveLength(0)
  })

  it('validate-on-add: an unset env-ref is distinct from a rejection and writes nothing (contract §4)', async () => {
    const { root, home } = await makeProject()
    const stub = stubFetch(200)
    const { code, err } = await run(['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS], {
      cwd: root,
      home,
      env: {},
      fetchImpl: stub.fetch,
    })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('$SUPABASE_KEY is unset')
    expect(stub.calls).toHaveLength(0)
    expect((await readProjectConnectors(root)).connectors).toHaveLength(0)
  })

  it('validate-on-add: the provider rejecting the credential writes nothing', async () => {
    const { root, home } = await makeProject()
    const stub = stubFetch(401)
    const { code, err } = await run(['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS], {
      cwd: root,
      home,
      env: { SUPABASE_KEY: 'wrong' },
      fetchImpl: stub.fetch,
    })
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/rejected the credential/)
    expect(stub.calls.length).toBeGreaterThan(0)
    expect((await readProjectConnectors(root)).connectors).toHaveLength(0)
  })

  it('validate-on-add: a good credential authenticates and the entry is written', async () => {
    const { root, home } = await makeProject()
    const stub = stubFetch(200)
    const { code, out } = await run(['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS], {
      cwd: root,
      home,
      env: { SUPABASE_KEY: 'right' },
      fetchImpl: stub.fetch,
    })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/validated against the provider/)
    expect(stub.calls.length).toBeGreaterThan(0)
    expect((await readProjectConnectors(root)).connectors).toHaveLength(1)
  })

  it('--skip-validate bypasses the round-trip entirely', async () => {
    const { root, home } = await makeProject()
    const stub = stubFetch(401)
    const { code } = await run(
      ['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'],
      { cwd: root, home, env: {}, fetchImpl: stub.fetch },
    )
    expect(code).toBe(0)
    expect(stub.calls).toHaveLength(0)
    expect((await readProjectConnectors(root)).connectors).toHaveLength(1)
  })

  it('builds a multi-field credential (firebase) from per-field flags', async () => {
    const { root, home } = await makeProject()
    const { code } = await run(
      ['add', 'firebase', '--project-id', '$FB_PROJECT', '--access-token', '$FB_TOKEN', '--functions', '{"myFn":"api"}', '--skip-validate'],
      { cwd: root, home, env: { FB_PROJECT: 'app', FB_TOKEN: 'tok' } },
    )
    expect(code).toBe(0)
    const config = await readProjectConnectors(root)
    expect(config.connectors[0].credential).toEqual({ projectId: '$FB_PROJECT', accessToken: '$FB_TOKEN' })
    expect(config.connectors[0].options).toEqual({ functions: { myFn: 'api' } })
  })

  it('rejects an unknown provider before writing', async () => {
    const { root, home } = await makeProject()
    const { code, err } = await run(['add', 'notaprovider', '--skip-validate'], { cwd: root, home, env: {} })
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/unknown provider/)
    expect((await readProjectConnectors(root)).connectors).toHaveLength(0)
  })

  it('errors on a missing required option rather than storing a dead entry', async () => {
    const { root, home } = await makeProject()
    // nodeRef omitted.
    const { code, err } = await run(
      ['add', 'supabase', '--credential', '$K', '--api-project-ref', 'abcdefghijklmnopqrst', '--service-name', 'api', '--skip-validate'],
      { cwd: root, home, env: { K: 'x' } },
    )
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/missing required option/)
  })
})

describe('project isolation (acceptance)', () => {
  it('a connector added in project A does not apply to project B (#1515)', async () => {
    const a = await makeProject('alpha')
    const b = await makeProject('beta')
    const added = await run(['add', 'supabase', '--credential', '$K', ...SUPABASE_OPTS, '--skip-validate'], {
      cwd: a.root,
      home: a.home,
      env: { K: 'x' },
    })
    expect(added.code).toBe(0)
    expect((await readProjectConnectors(a.root)).connectors).toHaveLength(1)
    // B, resolved from its own cwd, sees nothing.
    expect((await readProjectConnectors(b.root)).connectors).toHaveLength(0)
    const listed = await run(['list'], { cwd: b.root, home: b.home, env: {} })
    expect(listed.code).toBe(0)
    expect(listed.out.join('\n')).toMatch(/no connectors configured for this project/)
  })

  it('--project <path> targets a different checkout than the cwd', async () => {
    const a = await makeProject('alpha')
    const b = await makeProject('beta')
    const { code } = await run(
      ['add', 'supabase', '--project', a.root, '--credential', '$K', ...SUPABASE_OPTS, '--skip-validate'],
      { cwd: b.root, home: b.home, env: { K: 'x' } },
    )
    expect(code).toBe(0)
    expect((await readProjectConnectors(a.root)).connectors).toHaveLength(1)
    expect((await readProjectConnectors(b.root)).connectors).toHaveLength(0)
  })
})

describe('connector list', () => {
  it('redacts credentials — the resolved secret is never printed', async () => {
    const { root, home } = await makeProject()
    const env = { SUPABASE_KEY: 'sk_live_TOPSECRET' }
    await run(['add', 'supabase', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { cwd: root, home, env })
    const { code, out } = await run(['list'], { cwd: root, home, env })
    expect(code).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('$SUPABASE_KEY (set)')
    expect(text).not.toContain('sk_live_TOPSECRET')
  })

  it('reports an empty project plainly', async () => {
    const { root, home } = await makeProject()
    const { code, out } = await run(['list'], { cwd: root, home, env: {} })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/no connectors configured for this project/)
  })

  it('surfaces legacy machine-level entries as unassigned, with an assign hint', async () => {
    const { root, home } = await makeProject()
    await seedLegacy(home, [
      { id: 'legacy-sb', provider: 'supabase', credential: '$LEG_KEY', project: 'oldname' } as ConnectorEntry,
    ])
    const { out } = await run(['list'], { cwd: root, home, env: {} })
    const text = out.join('\n')
    expect(text).toMatch(/unassigned \(legacy /)
    expect(text).toContain('legacy-sb')
    expect(text).toMatch(/assign/)
  })
})

describe('connector remove', () => {
  it('removes by id', async () => {
    const { root, home } = await makeProject()
    await run(['add', 'supabase', '--id', 'gone', '--credential', '$K', ...SUPABASE_OPTS, '--skip-validate'], { cwd: root, home, env: { K: 'x' } })
    const { code, out } = await run(['remove', 'gone'], { cwd: root, home, env: {} })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/removed connector "gone"/)
    expect((await readProjectConnectors(root)).connectors).toHaveLength(0)
  })

  it('a missing id is a clear error, exit 1', async () => {
    const { root, home } = await makeProject()
    const { code, err } = await run(['remove', 'nope'], { cwd: root, home, env: {} })
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/no connector with id "nope"/)
  })

  it('missing <id> argument is misuse, exit 2', async () => {
    const { root, home } = await makeProject()
    const { code } = await run(['remove'], { cwd: root, home, env: {} })
    expect(code).toBe(2)
  })
})

describe('connector test', () => {
  it('ok when the provider authenticates', async () => {
    const { root, home } = await makeProject()
    const env = { SUPABASE_KEY: 'right' }
    await run(['add', 'supabase', '--id', 'sb', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { cwd: root, home, env })
    const stub = stubFetch(200)
    const { code, out } = await run(['test', 'sb'], { cwd: root, home, env, fetchImpl: stub.fetch })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/^ok:/m)
  })

  it('unset when the env-ref variable is not set — distinct from rejection', async () => {
    const { root, home } = await makeProject()
    await run(['add', 'supabase', '--id', 'sb', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { cwd: root, home, env: { SUPABASE_KEY: 'x' } })
    const stub = stubFetch(200)
    const { code, err } = await run(['test', 'sb'], { cwd: root, home, env: {}, fetchImpl: stub.fetch })
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/^unset:/m)
    expect(err.join('\n')).toContain('$SUPABASE_KEY is unset')
    expect(stub.calls).toHaveLength(0)
  })

  it('rejected when the provider turns the credential down', async () => {
    const { root, home } = await makeProject()
    const env = { SUPABASE_KEY: 'wrong' }
    await run(['add', 'supabase', '--id', 'sb', '--credential', '$SUPABASE_KEY', ...SUPABASE_OPTS, '--skip-validate'], { cwd: root, home, env })
    const stub = stubFetch(403)
    const { code, err } = await run(['test', 'sb'], { cwd: root, home, env, fetchImpl: stub.fetch })
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/^rejected:/m)
  })

  it('no such id is a clear error', async () => {
    const { root, home } = await makeProject()
    const { code, err } = await run(['test', 'ghost'], { cwd: root, home, env: {} })
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/no connector with id "ghost"/)
  })
})

describe('connector assign (migration)', () => {
  it('moves a legacy machine-level entry into the project, leaving the machine file in place', async () => {
    const { root, home } = await makeProject()
    await seedLegacy(home, [
      { id: 'legacy-sb', provider: 'supabase', credential: '$LEG_KEY', project: 'oldname', options: { serviceName: 'api' } } as ConnectorEntry,
    ])
    const { code, out } = await run(['assign', 'legacy-sb'], { cwd: root, home, env: {} })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/assigned connector "legacy-sb"/)
    const config = await readProjectConnectors(root)
    expect(config.connectors.map((c) => c.id)).toEqual(['legacy-sb'])
    // The project field is dropped — the file is the scope.
    expect(config.connectors[0]).not.toHaveProperty('project')
    // The machine-level file is untouched (read-once-to-migrate).
    const legacyRaw = await fs.readFile(connectorsConfigPath(home), 'utf8')
    expect(legacyRaw).toContain('legacy-sb')
  })

  it('refuses to assign a plaintext legacy entry into a refs-only project file', async () => {
    const { root, home } = await makeProject()
    await seedLegacy(home, [{ id: 'legacy-plain', provider: 'supabase', credential: 'raw_secret' } as ConnectorEntry])
    const { code, err } = await run(['assign', 'legacy-plain'], { cwd: root, home, env: {} })
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/plaintext secret/)
    expect((await readProjectConnectors(root)).connectors).toHaveLength(0)
  })

  it('an unknown id is a clear error, exit 1', async () => {
    const { root, home } = await makeProject()
    const { code, err } = await run(['assign', 'ghost'], { cwd: root, home, env: {} })
    expect(code).toBe(1)
    expect(err.join('\n')).toMatch(/no unassigned connector with id "ghost"/)
  })
})

describe('hosted binding', () => {
  it('add on a hosted project errors toward the control plane, writes no local file', async () => {
    const { root, home } = await makeProject('hosted-proj', { binding: 'hosted', org: 'acme' })
    const { code, err } = await run(
      ['add', 'supabase', '--credential', '$K', ...SUPABASE_OPTS, '--skip-validate'],
      { cwd: root, home, env: { K: 'x' } },
    )
    expect(code).toBe(2)
    expect(err.join('\n')).toMatch(/managed in the control plane/)
    expect((await readProjectConnectors(root)).connectors).toHaveLength(0)
  })

  it('list on a hosted project says so rather than reading a local file', async () => {
    const { root, home } = await makeProject('hosted-proj', { binding: 'hosted', org: 'acme' })
    const { code, out } = await run(['list'], { cwd: root, home, env: {} })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/managed in the control plane/)
  })
})

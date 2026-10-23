import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { ensureProjectIdentity } from '../src/project-identity.js'
import { readProjectConnectors, resolveCredential } from '../src/connectors-config.js'
import { runConnectorCommand } from '../src/connector-cli.js'
import { runLoginCommand } from '../src/login-cli.js'
import { KeychainError, parseKeychainRef, readKeychainRef, systemKeychain, useKeychainBackend, type KeychainBackend } from '../src/keychain.js'

// Newdryve #10 / WO-0.8 — a secret handed to NEAT never has to sit in argv, the
// project file, or an agent's transcript. `--token-stdin` reads it from a pipe;
// `connector add` keeps it in the OS keychain and writes only the
// `keychain:neat/<provider>/<projectId>` reference, which the daemon resolves.
// Before, a keychain reference was accepted and then passed through unresolved,
// so the reference string itself was sent to the provider as the token.

const SUPABASE_OPTS = ['--api-project-ref', 'abcdefghijklmnopqrst', '--node-ref', 'x.supabase.co', '--service-name', 'api']

function memoryKeychain(): KeychainBackend & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    read: (s, a) => store.get(`${s}/${a}`),
    write: (s, a, v) => {
      store.set(`${s}/${a}`, v)
    },
  }
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function project(): Promise<{ root: string; projectId: string }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-token-stdin-')))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  const { identity } = await ensureProjectIdentity(dir, { name: 'repo' })
  return { root: dir, projectId: identity.projectId }
}

describe('keychain references', () => {
  it('parse as service/account and resolve to the stored secret, never to the reference', () => {
    const kc = memoryKeychain()
    cleanups.push(useKeychainBackend(kc))
    expect(parseKeychainRef('keychain:neat/supabase/prj_X')).toEqual({ service: 'neat', account: 'supabase/prj_X' })
    expect(parseKeychainRef('keychain:neat')).toBeUndefined()
    kc.write('neat', 'supabase/prj_X', 's3cret')
    expect(resolveCredential('keychain:neat/supabase/prj_X')).toEqual({ kind: 'single', value: 's3cret' })
    expect(() => readKeychainRef('keychain:neat/supabase/prj_missing')).toThrow(KeychainError)
    expect(() => readKeychainRef('keychain:neat/supabase/prj_missing')).toThrow(/is not in the keychain/)
  })

  it.skipIf(process.platform !== 'darwin')('round-trip through a real macOS keychain file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-kc-'))
    const file = path.join(dir, 'test.keychain-db')
    execFileSync('security', ['create-keychain', '-p', 'pw', file])
    execFileSync('security', ['unlock-keychain', '-p', 'pw', file])
    cleanups.push(async () => {
      execFileSync('security', ['delete-keychain', file])
      await fs.rm(dir, { recursive: true, force: true })
    })
    const env = { NEAT_KEYCHAIN: file }
    systemKeychain(env).write('neat', 'railway/prj_T', 'a "quoted" $ecret\\')
    expect(readKeychainRef('keychain:neat/railway/prj_T', env)).toBe('a "quoted" $ecret\\')
  })
})

describe('neat connector add --token-stdin', () => {
  it('validates with the piped secret, stores it in the keychain, writes only the reference', async () => {
    const kc = memoryKeychain()
    cleanups.push(useKeychainBackend(kc))
    const { root, projectId } = await project()
    const seen: string[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(JSON.stringify(init?.headers ?? {}))
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    const out: string[] = []
    const code = await runConnectorCommand(['add', 'supabase', '--token-stdin', ...SUPABASE_OPTS], {
      cwd: root,
      env: {},
      interactive: false,
      fetchImpl,
      readTokenStdin: async () => 'sbp_piped_secret\n',
      out: (l) => out.push(l),
      err: () => {},
    })
    expect(code).toBe(0)
    expect(seen.some((h) => h.includes('sbp_piped_secret'))).toBe(true)
    expect(kc.store.get(`neat/supabase/${projectId}`)).toBe('sbp_piped_secret')
    const [entry] = (await readProjectConnectors(root)).connectors
    expect(entry!.credential).toBe(`keychain:neat/supabase/${projectId}`)
    expect(await fs.readFile(path.join(root, '.neat/connectors.json'), 'utf8')).not.toContain('sbp_piped_secret')
    expect(out).toContain(`stored the token in your keychain as keychain:neat/supabase/${projectId}.`)
  })

  it('a rejected secret is stored nowhere', async () => {
    const kc = memoryKeychain()
    cleanups.push(useKeychainBackend(kc))
    const { root } = await project()
    const fetchImpl = (async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) }) as Response) as unknown as typeof fetch
    const code = await runConnectorCommand(['add', 'supabase', '--token-stdin', ...SUPABASE_OPTS], {
      cwd: root,
      env: {},
      interactive: false,
      fetchImpl,
      readTokenStdin: async () => 'wrong',
      out: () => {},
      err: () => {},
    })
    expect(code).toBe(1)
    expect(kc.store.size).toBe(0)
    expect((await readProjectConnectors(root)).connectors).toEqual([])
  })

  it('refuses --token with --token-stdin, and an empty pipe', async () => {
    cleanups.push(useKeychainBackend(memoryKeychain()))
    const { root } = await project()
    const err: string[] = []
    const run = (argv: string[], secret: string) =>
      runConnectorCommand(argv, { cwd: root, env: {}, interactive: false, readTokenStdin: async () => secret, out: () => {}, err: (l) => err.push(l) })
    expect(await run(['add', 'supabase', '--token-stdin', '--token', '$X', ...SUPABASE_OPTS], 's')).toBe(2)
    expect(err.at(-1)).toMatch(/not both/)
    expect(await run(['add', 'supabase', '--token-stdin', ...SUPABASE_OPTS], '  ')).toBe(2)
    expect(err.at(-1)).toMatch(/read nothing/)
  })
})

describe('neat login --token-stdin', () => {
  it('takes the token from stdin, never from argv', async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-login-stdin-')))
    cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
    const auth: string[] = []
    const errs: string[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      auth.push(String((init?.headers as Record<string, string>)?.authorization ?? ''))
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const code = await runLoginCommand(['--endpoint', 'https://tenant.example', '--token-stdin'], {
      env: {},
      home,
      fetchImpl,
      readTokenStdin: async () => 'piped-daemon-token\n',
      out: () => {},
      err: (l) => errs.push(l),
    })
    expect(errs).toEqual([])
    expect(code).toBe(0)
    expect(auth[0]).toBe('Bearer piped-daemon-token')
    const profiles = JSON.parse(await fs.readFile(path.join(home, 'profiles.json'), 'utf8'))
    expect(profiles.profiles[0]).toMatchObject({ endpoint: 'https://tenant.example', authToken: 'piped-daemon-token' })
  })
})

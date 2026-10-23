import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promoteProject } from '../src/project-promote.js'
import { runProjectCommand } from '../src/project-cli.js'

const OUR_ID = 'prj_01JB6K3Z8Q9W2N4R5T7V8X0Y1A'
const CP_ID = 'prj_cp0123456789abcdef01'

const roots: string[] = []
async function makeProject(opts: {
  binding?: { binding: 'local' | 'hosted'; org?: string }
  connectors?: Array<{ id: string; provider: string; credential: unknown; options?: unknown }>
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'neat-promote-'))
  roots.push(root)
  const neat = path.join(root, '.neat')
  await mkdir(neat, { recursive: true })
  await writeFile(
    path.join(neat, 'project.json'),
    JSON.stringify({ schemaVersion: 1, projectId: OUR_ID, name: 'newdryve' }),
  )
  if (opts.binding) {
    await writeFile(path.join(neat, 'binding.json'), JSON.stringify({ schemaVersion: 1, ...opts.binding }))
  }
  if (opts.connectors) {
    await writeFile(
      path.join(neat, 'connectors.json'),
      JSON.stringify({ version: 1, connectors: opts.connectors }),
    )
  }
  return root
}

async function bindingOf(root: string): Promise<{ binding?: string; org?: string } | null> {
  try {
    return JSON.parse(await readFile(path.join(root, '.neat', 'binding.json'), 'utf8'))
  } catch {
    return null
  }
}

// A fetch that records calls and returns scripted responses, so the whole flow
// runs against a local stub — never api.neat.is.
function stubFetch(script: (url: string) => { status: number; body?: unknown }): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; body: string }>
} {
  const calls: Array<{ url: string; body: string }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' })
    const { status, body } = script(url)
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe('promoteProject (WO-1.1)', () => {
  it('registers with our ULID, re-keys connectors by the CP id, then flips the binding', async () => {
    const root = await makeProject({
      binding: { binding: 'local' },
      connectors: [{ id: 'supa-main', provider: 'supabase', credential: '$SUPABASE_KEY' }],
    })
    const { fetchImpl, calls } = stubFetch((url) =>
      url.endsWith('/me/projects/register')
        ? { status: 201, body: { id: CP_ID } }
        : url.includes('/connections')
          ? { status: 201, body: {} }
          : { status: 404 },
    )

    const outcome = await promoteProject(root, 'org_acme', {
      cpUrl: 'http://cp.local',
      apiKey: 'neat_pat_x',
      fetchImpl,
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.cpProjectId).toBe(CP_ID)
    const reg = calls.find((c) => c.url.endsWith('/me/projects/register'))!
    expect(JSON.parse(reg.body)).toEqual({ neatProjectId: OUR_ID, name: 'newdryve' })
    const conn = calls.find((c) => c.url.includes('/connections'))!
    expect(conn.url).toBe(`http://cp.local/me/projects/${CP_ID}/connections`)
    expect(await bindingOf(root)).toMatchObject({ binding: 'hosted', org: 'org_acme' })
  })

  it('sends the connector credential REF, never a resolved secret value', async () => {
    const root = await makeProject({
      binding: { binding: 'local' },
      connectors: [{ id: 'supa-main', provider: 'supabase', credential: '$SUPABASE_KEY' }],
    })
    const prev = process.env.SUPABASE_KEY
    process.env.SUPABASE_KEY = 'super-secret-value'
    try {
      const { fetchImpl, calls } = stubFetch((url) =>
        url.endsWith('/register') ? { status: 201, body: { id: CP_ID } } : { status: 201, body: {} },
      )
      await promoteProject(root, 'org_acme', { cpUrl: 'http://cp.local', apiKey: 'k', fetchImpl })
      const sent = calls.map((c) => c.body).join('\n')
      expect(sent).toContain('$SUPABASE_KEY')
      expect(sent).not.toContain('super-secret-value')
    } finally {
      if (prev === undefined) delete process.env.SUPABASE_KEY
      else process.env.SUPABASE_KEY = prev
    }
  })

  it('leaves the binding local when register fails (rollback)', async () => {
    const root = await makeProject({ binding: { binding: 'local' } })
    const { fetchImpl } = stubFetch(() => ({ status: 500 }))
    const outcome = await promoteProject(root, 'org_acme', { cpUrl: 'http://cp.local', apiKey: 'k', fetchImpl })
    expect(outcome.ok).toBe(false)
    expect(await bindingOf(root)).toMatchObject({ binding: 'local' })
  })

  it('leaves the binding local when a connector re-key fails (rollback)', async () => {
    const root = await makeProject({
      binding: { binding: 'local' },
      connectors: [{ id: 'supa-main', provider: 'supabase', credential: '$SUPABASE_KEY' }],
    })
    const { fetchImpl } = stubFetch((url) =>
      url.endsWith('/register') ? { status: 201, body: { id: CP_ID } } : { status: 500 },
    )
    const outcome = await promoteProject(root, 'org_acme', { cpUrl: 'http://cp.local', apiKey: 'k', fetchImpl })
    expect(outcome.ok).toBe(false)
    expect(await bindingOf(root)).toMatchObject({ binding: 'local' })
  })

  it('proceeds when register returns 200 (idempotent retry of an earlier promote)', async () => {
    const root = await makeProject({ binding: { binding: 'local' } })
    const { fetchImpl } = stubFetch((url) =>
      url.endsWith('/register') ? { status: 200, body: { id: CP_ID } } : { status: 201 },
    )
    const outcome = await promoteProject(root, 'org_acme', { cpUrl: 'http://cp.local', apiKey: 'k', fetchImpl })
    expect(outcome.ok).toBe(true)
    expect(await bindingOf(root)).toMatchObject({ binding: 'hosted', org: 'org_acme' })
  })
})

describe('neat project promote (CLI)', () => {
  it('is a no-op on an already-hosted project, making no control-plane calls', async () => {
    const root = await makeProject({ binding: { binding: 'hosted', org: 'org_acme' } })
    const { fetchImpl, calls } = stubFetch(() => ({ status: 500 }))
    const lines: string[] = []
    const code = await runProjectCommand(['promote', '--org', 'org_acme'], {
      cwd: root,
      env: { NEAT_API_KEY: 'k' },
      fetchImpl,
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    })
    expect(code).toBe(0)
    expect(calls).toHaveLength(0)
    expect(lines.join('\n')).toContain('already hosted@org_acme')
  })

  it('errors without a login (no NEAT_API_KEY) and leaves the binding local', async () => {
    const root = await makeProject({ binding: { binding: 'local' } })
    const lines: string[] = []
    const code = await runProjectCommand(['promote', '--org', 'org_acme'], {
      cwd: root,
      env: {},
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    })
    expect(code).toBe(2)
    expect(lines.join('\n')).toMatch(/not logged in|neat login/)
    expect(await bindingOf(root)).toMatchObject({ binding: 'local' })
  })

  it('requires --org', async () => {
    const root = await makeProject({ binding: { binding: 'local' } })
    const lines: string[] = []
    const code = await runProjectCommand(['promote'], {
      cwd: root,
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    })
    expect(code).toBe(2)
    expect(lines.join('\n')).toContain('--org <org> is required')
  })
})

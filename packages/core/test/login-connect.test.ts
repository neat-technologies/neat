import { describe, it, expect } from 'vitest'
import {
  parseGitHubRemote,
  listBoundRepos,
  waitForFirstProject,
  bindUrl,
  onboardingUrl,
  runPostLoginConnect,
  projectNameForRepo,
  type BoundRepo,
  type RepoRef,
} from '../src/login-connect.js'

// docs/contracts/cli-surface.md §neat login — what happens after the profile is
// written. Logging in connects an account; this step is what tells the user where
// the repo they are standing in stands, and offers the two routes into the graph
// (#1234). Every seam is injected, so nothing here shells out or hits a network.

const WEB = 'https://gui.example'
const CP = 'https://cp.example'
const PROJECT = { id: 'prj_1', name: 'acme' }
const DAEMON = 'https://neat-acme.run.app'

function capture(): { out: string[]; sink: (l: string) => void } {
  const out: string[] = []
  return { out, sink: (l) => out.push(l) }
}

function reposFetch(rows: BoundRepo[] | { status: number }): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes('/repos')) {
      if (Array.isArray(rows)) {
        return { ok: true, status: 200, json: async () => rows } as unknown as Response
      }
      return { ok: false, status: rows.status, json: async () => ({}) } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  }) as unknown as typeof fetch
}

const repo = (owner: string, name: string): ((cwd: string) => Promise<RepoRef | null>) => async () => ({ owner, name })
const noRepo = async (): Promise<RepoRef | null> => null

describe('parseGitHubRemote', () => {
  it('reads owner/name from https, ssh and ssh:// forms, with or without .git', () => {
    expect(parseGitHubRemote('https://github.com/acme/app.git')).toEqual({ owner: 'acme', name: 'app' })
    expect(parseGitHubRemote('https://github.com/acme/app')).toEqual({ owner: 'acme', name: 'app' })
    expect(parseGitHubRemote('git@github.com:acme/app.git')).toEqual({ owner: 'acme', name: 'app' })
    expect(parseGitHubRemote('ssh://git@github.com/acme/app')).toEqual({ owner: 'acme', name: 'app' })
    expect(parseGitHubRemote('https://x-access-token:tok@github.com/acme/app.git')).toEqual({
      owner: 'acme',
      name: 'app',
    })
  })

  it('returns null for anything that is not a GitHub repo — the bind route only exists there', () => {
    expect(parseGitHubRemote('https://gitlab.com/acme/app.git')).toBeNull()
    expect(parseGitHubRemote('git@bitbucket.org:acme/app.git')).toBeNull()
    expect(parseGitHubRemote('/srv/local/repo')).toBeNull()
    expect(parseGitHubRemote('')).toBeNull()
  })
})

describe('urls', () => {
  it('builds the console deep links', () => {
    expect(bindUrl(WEB, 'prj_1')).toBe('https://gui.example/config/repos?project=prj_1')
    expect(onboardingUrl(WEB)).toBe('https://gui.example/onboarding')
  })
})

describe('listBoundRepos', () => {
  it('returns the rows the control plane serves', async () => {
    const rows = [{ owner: 'acme', name: 'app', syncStatus: 'synced' }]
    expect(await listBoundRepos(reposFetch(rows), CP, 'jwt', 'prj_1')).toEqual(rows)
  })

  it('returns null rather than throwing when the GitHub App is not configured (501)', async () => {
    expect(await listBoundRepos(reposFetch({ status: 501 }), CP, 'jwt', 'prj_1')).toBeNull()
  })

  it('returns null when the control plane is unreachable', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await listBoundRepos(boom, CP, 'jwt', 'prj_1')).toBeNull()
  })
})

describe('waitForFirstProject', () => {
  const meFetch = (sequence: Array<Array<{ id: string; name: string; status: string }>>): typeof fetch => {
    let i = 0
    return (async () => {
      const projects = sequence[Math.min(i++, sequence.length - 1)]!
      return { ok: true, status: 200, json: async () => ({ projects }) } as unknown as Response
    }) as unknown as typeof fetch
  }

  it('returns the project once one comes up running', async () => {
    const f = meFetch([[], [{ id: 'p', name: 'acme', status: 'provisioning' }], [{ id: 'p', name: 'acme', status: 'running' }]])
    let t = 0
    const res = await waitForFirstProject(f, CP, 'jwt', {
      sleep: async () => {
        t += 3000
      },
      now: () => t,
      pollMs: 1,
    })
    expect(res).toEqual({ kind: 'project', project: { id: 'p', name: 'acme', status: 'running' } })
  })

  it('stops cleanly when interrupted — Ctrl-C is an exit, not a crash', async () => {
    const ac = new AbortController()
    ac.abort()
    const res = await waitForFirstProject(meFetch([[]]), CP, 'jwt', {
      sleep: async () => {},
      now: () => 0,
      signal: ac.signal,
    })
    expect(res).toEqual({ kind: 'aborted' })
  })

  it('gives up at the budget instead of waiting forever', async () => {
    let t = 0
    const res = await waitForFirstProject(meFetch([[]]), CP, 'jwt', {
      sleep: async () => {
        t += 60_000
      },
      now: () => t,
      budgetMs: 120_000,
      pollMs: 1,
    })
    expect(res).toEqual({ kind: 'timeout' })
  })
})

describe('runPostLoginConnect', () => {
  const base = { cpUrl: CP, webUrl: WEB, accessToken: 'jwt', project: PROJECT }

  it('says so when this repo is already bound, and does not offer to bind it again', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      deps: {
        out: sink,
        fetchImpl: reposFetch([{ owner: 'acme', name: 'app', syncStatus: 'synced' }]),
        detectRepo: repo('acme', 'app'),
      },
    })
    const printed = out.join('\n')
    expect(printed).toContain('acme/app is bound to acme')
    expect(printed).toContain('(synced)')
    expect(printed).not.toContain('Bind this repo')
  })

  it('asks where an unbound repo should go, with no default and no recommendation', async () => {
    // #1272: which project a repo joins was being decided silently in favour of
    // the one the login connected to. Both destinations are offered plainly.
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      me: { github: { installed: true } },
      deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: repo('acme', 'app') },
    })
    const printed = out.join('\n')
    expect(printed).toContain("acme/app isn't in acme")
    expect(printed).toContain('Where should this repo go?')
    expect(printed).toContain('1) A project of its own, called app')
    expect(printed).toContain('2) acme — the project this login connected to')
    expect(printed).toContain('3) Neither')
    // No thumb on the scale for either destination.
    expect(printed.toLowerCase()).not.toContain('recommend')
  })

  it('words the bind option as an install when the GitHub App is absent', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      me: { github: { installed: false } },
      deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: repo('acme', 'app'), readLine: async () => '2' },
    })
    expect(out.join('\n')).toContain('Bind it (install the GitHub App first)')
  })

  it('does not assert an install state the control plane did not report', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      me: {},
      deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: repo('acme', 'app'), readLine: async () => '2' },
    })
    const printed = out.join('\n')
    expect(printed).toContain('Bind it through the console')
    expect(printed).not.toContain('Install the GitHub App')
  })

  it('gives the console bind link for the connected project on choice 2', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      deps: {
        out: sink,
        fetchImpl: reposFetch([]),
        detectRepo: repo('acme', 'app'),
        readLine: async () => '2',
      },
    })
    expect(out.join('\n')).toContain('https://gui.example/config/repos?project=prj_1')
  })

  it('on choice 2 with a snapshot present, gives the push command', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      deps: {
        out: sink,
        fetchImpl: reposFetch([]),
        detectRepo: repo('acme', 'app'),
        readLine: async () => '2',
        hasLocalGraph: async () => true,
      },
      endpoint: DAEMON,
      pushToken: 'dtok',
    })
    expect(out.join('\n')).toContain(`sync --to ${DAEMON} --token dtok`)
  })

  it('on choice 2 with nothing extracted yet, names the step that has to come first', async () => {
    // `sync --to` pushes an existing snapshot; sending someone at it in a repo
    // NEAT has never run on would just fail on a missing file.
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      deps: {
        out: sink,
        fetchImpl: reposFetch([]),
        detectRepo: repo('acme', 'app'),
        readLine: async () => '2',
        hasLocalGraph: async () => false,
      },
    })
    const printed = out.join('\n')
    expect(printed).toContain('Or build a graph here and push it')
    expect(printed).toMatch(/ {4}(?:npx )?neat(?:\.is)?\n/)
  })

  it('leaves both destinations behind on choice 3', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      deps: {
        out: sink,
        fetchImpl: reposFetch([]),
        detectRepo: repo('acme', 'app'),
        readLine: async () => '3',
      },
    })
    const printed = out.join('\n')
    expect(printed).toContain('config/repos?project=prj_1')
    expect(printed).toContain('Its own project')
  })

  it('offers the push route only when there is no GitHub remote to bind', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      endpoint: DAEMON,
      pushToken: 'dtok',
      deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: noRepo, hasLocalGraph: async () => true },
    })
    const printed = out.join('\n')
    expect(printed).toContain('no GitHub remote')
    expect(printed).toContain(`sync --to ${DAEMON} --token dtok`)
    expect(printed).not.toContain('Where should this repo go?')
  })

  it('still offers the routes when the control plane cannot say what is bound', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      deps: { out: sink, fetchImpl: reposFetch({ status: 501 }), detectRepo: repo('acme', 'app') },
    })
    expect(out.join('\n')).toContain("acme/app isn't in acme")
  })

  it('prints the routes without prompting when there is no reader (non-interactive)', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: repo('acme', 'app') },
    })
    const printed = out.join('\n')
    expect(printed).toContain('config/repos?project=prj_1')
    expect(printed).toContain('Its own project')
  })
})

describe('printed commands are runnable as invoked (#1271)', () => {
  // Deniz ran the door via `npx neat.is`, reached this step, and was told to run
  // `neat sync --to default`. `zsh: command not found: neat`. Every command this
  // step prints has to carry the prefix the run was actually invoked with, the
  // way the orchestrator summary already does.
  const asNpx = async (fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.npm_command
    process.env.npm_command = 'exec' // what isNpxInvocation() reads
    try {
      await fn()
    } finally {
      if (prev === undefined) delete process.env.npm_command
      else process.env.npm_command = prev
    }
  }

  // A line that tells someone to run something, in any of the shapes this step
  // uses: an indented command, or one quoted inside prose.
  const commandsIn = (lines: string[]): string[] =>
    lines.flatMap((l) => {
      const out: string[] = []
      const indented = l.match(/^\s{2,}(\S.*)$/)
      if (indented?.[1]) out.push(indented[1])
      for (const m of l.matchAll(/`([^`]+)`/g)) if (m[1]) out.push(m[1])
      return out
    })

  const assertPrefixed = (lines: string[]): void => {
    for (const c of commandsIn(lines)) {
      // Only judge things that look like a neat invocation.
      if (!/^neat\b/.test(c) && !/^npx neat\.is\b/.test(c)) continue
      expect(c, `printed a bare \`neat\` command under npx: ${c}`).toMatch(/^npx neat\.is\b/)
    }
  }

  it('prefixes every command on the no-remote branch', async () => {
    await asNpx(async () => {
      const { out, sink } = capture()
      await runPostLoginConnect({
        ...{ cpUrl: CP, webUrl: WEB, accessToken: 'jwt', project: PROJECT },
        endpoint: DAEMON,
        pushToken: 'dtok',
        deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: noRepo, hasLocalGraph: async () => true },
      })
      expect(out.join('\n')).toContain(`npx neat.is sync --to ${DAEMON} --token dtok`)
      assertPrefixed(out)
    })
  })

  it('prefixes every command on the unbound branch, all three answers', async () => {
    for (const answer of ['2', '3', undefined]) {
      await asNpx(async () => {
        const { out, sink } = capture()
        await runPostLoginConnect({
          ...{ cpUrl: CP, webUrl: WEB, accessToken: 'jwt', project: PROJECT },
          deps: {
            out: sink,
            fetchImpl: reposFetch([]),
            detectRepo: repo('acme', 'app'),
            hasLocalGraph: async () => false,
            ...(answer ? { readLine: async () => answer } : {}),
          },
        })
        assertPrefixed(out)
      })
    }
  })

  it('falls back to bare `neat` for a global install', async () => {
    const prev = process.env.npm_command
    delete process.env.npm_command
    try {
      const { out, sink } = capture()
      await runPostLoginConnect({
        ...{ cpUrl: CP, webUrl: WEB, accessToken: 'jwt', project: PROJECT },
        endpoint: DAEMON,
        pushToken: 'dtok',
        deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: noRepo, hasLocalGraph: async () => true },
      })
      expect(out.join('\n')).toContain(`sync --to ${DAEMON}`)
      expect(out.join('\n')).not.toContain('npx neat.is sync')
    } finally {
      if (prev !== undefined) process.env.npm_command = prev
    }
  })
})

describe('the no-remote branch with nothing extracted yet (#1272)', () => {
  const base = { cpUrl: CP, webUrl: WEB, accessToken: 'jwt', project: PROJECT }

  it('says the graph must be built first, and offers to build it', async () => {
    const { out, sink } = capture()
    let ranIn = ''
    await runPostLoginConnect({
      ...base,
      endpoint: DAEMON,
      pushToken: 'dtok',
      deps: {
        out: sink,
        fetchImpl: reposFetch([]),
        detectRepo: noRepo,
        hasLocalGraph: async () => false,
        cwd: '/tmp/seminary',
        readLine: async () => 'y',
        orchestrator: async (cwd) => {
          ranIn = cwd
          return 0
        },
      },
    })
    const printed = out.join('\n')
    expect(printed).toContain('has to be built first')
    expect(ranIn).toBe('/tmp/seminary')
    // Built — so the next step is the push, not "build it then push it".
    expect(printed).toContain('Now push it to acme')
    expect(printed).toContain(`sync --to ${DAEMON}`)
    // The project name is not a URL, so it must never appear as the --to value (#1302).
    expect(printed).not.toContain('sync --to acme')
  })

  it('declining leaves both commands behind, in order', async () => {
    const { out, sink } = capture()
    let ran = false
    await runPostLoginConnect({
      ...base,
      deps: {
        out: sink,
        fetchImpl: reposFetch([]),
        detectRepo: noRepo,
        hasLocalGraph: async () => false,
        readLine: async () => 'n',
        orchestrator: async () => {
          ran = true
          return 0
        },
      },
    })
    expect(ran).toBe(false)
    expect(out.join('\n')).toContain("When you're ready")
  })

  it('runs nothing when there is no reader — prints the commands instead', async () => {
    const { out, sink } = capture()
    let ran = false
    await runPostLoginConnect({
      ...base,
      deps: {
        out: sink,
        fetchImpl: reposFetch([]),
        detectRepo: noRepo,
        hasLocalGraph: async () => false,
        orchestrator: async () => {
          ran = true
          return 0
        },
      },
    })
    expect(ran).toBe(false)
    expect(out.join('\n')).toContain("When you're ready")
  })

  it('a directory that already has a snapshot keeps the one-line offer', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: noRepo, hasLocalGraph: async () => true },
    })
    const printed = out.join('\n')
    expect(printed).toContain('Push its graph to acme')
    expect(printed).not.toContain('has to be built first')
  })
})

describe('choosing where an unbound repo goes (#1272)', () => {
  const base = { cpUrl: CP, webUrl: WEB, accessToken: 'jwt', project: PROJECT }

  // A control plane that answers the repo list, the create, and the provision.
  // `provision` decides the interesting branch: 201, or the 402 subscription gate.
  function cpFetch(opts: { bound?: BoundRepo[]; provision?: number; create?: number } = {}): {
    fetchImpl: typeof fetch
    calls: string[]
  } {
    const calls: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      calls.push(`${init?.method ?? 'GET'} ${u}`)
      if (u.endsWith('/provision')) {
        const status = opts.provision ?? 201
        return {
          ok: status < 400,
          status,
          text: async () => JSON.stringify({ error: 'a subscription is required to provision (status: none)' }),
          json: async () => ({}),
        } as unknown as Response
      }
      if (u.endsWith('/me/projects')) {
        const status = opts.create ?? 201
        return {
          ok: status < 400,
          status,
          text: async () => JSON.stringify({ error: 'name already taken' }),
          json: async () => ({ id: 'prj_new', name: 'app' }),
        } as unknown as Response
      }
      if (u.includes('/repos')) {
        return { ok: true, status: 200, json: async () => opts.bound ?? [] } as unknown as Response
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
  }

  it('derives a DNS-label project name from a repo name', () => {
    expect(projectNameForRepo({ owner: 'acme', name: 'app' })).toBe('app')
    expect(projectNameForRepo({ owner: 'acme', name: 'My.App_v2' })).toBe('my-app-v2')
    expect(projectNameForRepo({ owner: 'acme', name: '---' })).toBe('repo')
    // The control plane rejects anything outside [a-z0-9-].
    for (const name of ['app', 'My.App_v2', '---', 'UPPER', 'a..b__c']) {
      expect(projectNameForRepo({ owner: 'o', name })).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('creates and provisions a project of its own on choice 1', async () => {
    const { out, sink } = capture()
    const { fetchImpl, calls } = cpFetch()
    await runPostLoginConnect({
      ...base,
      deps: { out: sink, fetchImpl, detectRepo: repo('acme', 'app'), readLine: async () => '1' },
    })
    expect(calls).toContain('POST https://cp.example/me/projects')
    expect(calls).toContain('POST https://cp.example/me/projects/prj_new/provision')
    const printed = out.join('\n')
    expect(printed).toContain('Created app and started its daemon')
    // The profile still points at the old project — say so rather than let the
    // next command read a graph they didn't mean.
    expect(printed).toContain('still pointed at acme')
    expect(printed).toContain('login --project app')
  })

  it('on a 402 says the project exists and a plan is what is missing', async () => {
    // POST /me/projects is a 201 even without a subscription; the gate is on
    // provision. Reporting that as a plain failure would have the user make a
    // second project tomorrow.
    const { out, sink } = capture()
    const { fetchImpl } = cpFetch({ provision: 402 })
    await runPostLoginConnect({
      ...base,
      deps: { out: sink, fetchImpl, detectRepo: repo('acme', 'app'), readLine: async () => '1' },
    })
    const printed = out.join('\n')
    expect(printed).toContain('Created app, but starting a daemon for it needs a plan')
    expect(printed).toContain('https://gui.example/checkout')
    expect(printed).toContain("nothing to redo")
    expect(printed).not.toContain('started its daemon')
  })

  it('says plainly when nothing was created', async () => {
    const { out, sink } = capture()
    const { fetchImpl, calls } = cpFetch({ create: 409 })
    await runPostLoginConnect({
      ...base,
      deps: { out: sink, fetchImpl, detectRepo: repo('acme', 'app'), readLine: async () => '1' },
    })
    const printed = out.join('\n')
    expect(printed).toContain("Couldn't create the project")
    expect(printed).toContain('name already taken')
    expect(printed).toContain('safe to retry')
    // No provision attempt on a project that was never made.
    expect(calls.some((c) => c.endsWith('/provision'))).toBe(false)
  })

  it('names what is already in the shared project and the collision it risks', async () => {
    const { out, sink } = capture()
    const { fetchImpl } = cpFetch({ bound: [{ owner: 'acme', name: 'web' }, { owner: 'acme', name: 'api' }] })
    await runPostLoginConnect({
      ...base,
      deps: { out: sink, fetchImpl, detectRepo: repo('acme', 'app') },
    })
    const printed = out.join('\n')
    expect(printed).toContain('2 already there: acme/web, acme/api')
    expect(printed).toContain('#1294')
    expect(printed).toContain("retire each other's files")
  })

  it('does not claim a collision in a project with nothing in it yet', async () => {
    const { out, sink } = capture()
    const { fetchImpl } = cpFetch({ bound: [] })
    await runPostLoginConnect({
      ...base,
      deps: { out: sink, fetchImpl, detectRepo: repo('acme', 'app') },
    })
    const printed = out.join('\n')
    expect(printed).toContain('Nothing else is bound there yet')
    // Still names the hazard, because adding a second repo later hits it.
    expect(printed).toContain('#1294')
  })
})

describe('every printed --to value is a URL (#1302)', () => {
  // `--to` is a base URL; a project name becomes fetch("acme/projects") and
  // fails on `Failed to parse URL`. Guard every branch at once rather than
  // per-message.
  const base = { cpUrl: CP, webUrl: WEB, accessToken: 'jwt', project: PROJECT }

  const assertToIsUrl = (lines: string[]): void => {
    for (const m of lines.join('\n').matchAll(/--to (\S+)/g)) {
      const value = m[1] as string
      expect(() => new URL(value), `--to ${value} is not a URL`).not.toThrow()
    }
  }

  it('holds on every branch, with and without an endpoint', async () => {
    for (const endpoint of [DAEMON, undefined]) {
      for (const answer of ['1', '2', '3', undefined]) {
        for (const hasGraph of [true, false]) {
          const { out, sink } = capture()
          await runPostLoginConnect({
            ...base,
            ...(endpoint ? { endpoint, pushToken: 'dtok' } : {}),
            deps: {
              out: sink,
              fetchImpl: reposFetch([]),
              detectRepo: repo('acme', 'app'),
              hasLocalGraph: async () => hasGraph,
              ...(answer ? { readLine: async () => answer } : {}),
            },
          })
          assertToIsUrl(out)
        }
      }
    }
  })

  it('holds on the no-remote branch too', async () => {
    for (const endpoint of [DAEMON, undefined]) {
      for (const hasGraph of [true, false]) {
        const { out, sink } = capture()
        await runPostLoginConnect({
          ...base,
          ...(endpoint ? { endpoint, pushToken: 'dtok' } : {}),
          deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: noRepo, hasLocalGraph: async () => hasGraph },
        })
        assertToIsUrl(out)
      }
    }
  })
})

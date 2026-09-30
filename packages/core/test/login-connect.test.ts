import { describe, it, expect } from 'vitest'
import {
  parseGitHubRemote,
  listBoundRepos,
  waitForFirstProject,
  bindUrl,
  onboardingUrl,
  runPostLoginConnect,
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

  it('offers both routes when the repo is not bound', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      me: { github: { installed: true } },
      deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: repo('acme', 'app') },
    })
    const printed = out.join('\n')
    expect(printed).toContain("acme/app isn't part of acme yet")
    expect(printed).toContain('1) Bind this repo')
    expect(printed).toContain('2) Push the graph on this machine now')
    expect(printed).toContain('3) Neither')
  })

  it('words the bind option as an install when the GitHub App is absent', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      me: { github: { installed: false } },
      deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: repo('acme', 'app') },
    })
    expect(out.join('\n')).toContain('1) Install the GitHub App and bind this repo')
  })

  it('does not assert an install state the control plane did not report', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      me: {},
      deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: repo('acme', 'app') },
    })
    const printed = out.join('\n')
    expect(printed).toContain('1) Bind this repo through the console')
    expect(printed).not.toContain('Install the GitHub App')
  })

  it('opens the console bind link on choice 1', async () => {
    const { out, sink } = capture()
    const opened: string[] = []
    await runPostLoginConnect({
      ...base,
      deps: {
        out: sink,
        fetchImpl: reposFetch([]),
        detectRepo: repo('acme', 'app'),
        readLine: async () => '1',
        openBrowser: (u) => {
          opened.push(u)
          return true
        },
      },
    })
    expect(opened).toEqual(['https://gui.example/config/repos?project=prj_1'])
    expect(out.join('\n')).toContain('Opened https://gui.example/config/repos?project=prj_1')
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
    })
    expect(out.join('\n')).toContain('sync --to acme')
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
    expect(printed).toContain('There is no local graph to push yet')
    expect(printed).toMatch(/\n {2}(?:npx )?neat(?:\.is)?\n {2}(?:npx )?neat(?:\.is)? sync --to acme/)
  })

  it('leaves both routes behind on choice 3', async () => {
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
    expect(printed).toContain('sync --to acme')
  })

  it('offers the push route only when there is no GitHub remote to bind', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: noRepo },
    })
    const printed = out.join('\n')
    expect(printed).toContain('no GitHub remote')
    expect(printed).toContain('sync --to acme')
    expect(printed).not.toContain('1) Bind this repo')
  })

  it('still offers the routes when the control plane cannot say what is bound', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      deps: { out: sink, fetchImpl: reposFetch({ status: 501 }), detectRepo: repo('acme', 'app') },
    })
    expect(out.join('\n')).toContain("acme/app isn't part of acme yet")
  })

  it('prints the routes without prompting when there is no reader (non-interactive)', async () => {
    const { out, sink } = capture()
    await runPostLoginConnect({
      ...base,
      deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: repo('acme', 'app') },
    })
    const printed = out.join('\n')
    expect(printed).toContain('config/repos?project=prj_1')
    expect(printed).toContain('sync --to acme')
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
        deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: noRepo, hasLocalGraph: async () => true },
      })
      expect(out.join('\n')).toContain('npx neat.is sync --to acme')
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
        deps: { out: sink, fetchImpl: reposFetch([]), detectRepo: noRepo, hasLocalGraph: async () => true },
      })
      expect(out.join('\n')).toContain('sync --to acme')
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
    expect(printed).toContain('sync --to acme')
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
    expect(printed).toContain('Push its graph instead')
    expect(printed).not.toContain('has to be built first')
  })
})

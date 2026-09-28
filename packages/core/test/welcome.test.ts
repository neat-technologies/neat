import { describe, it, expect } from 'vitest'
import { runWelcome, shouldShowWelcome, AGENT_SETUP_PROMPT } from '../src/welcome.js'

// packages/core/src/welcome.ts — the first-run "front door". `runWelcome` shows
// a two-option menu (log in / self-hosted) and hands off to the flow chosen;
// `shouldShowWelcome` gates whether a bare `neat` opens it at all. Both take
// injected deps so no real TTY, login round-trip, or orchestration is needed.

// A line reader driven by a fixed queue — returns each answer in turn, then
// undefined (EOF) once exhausted, matching the default reader's non-TTY return.
function reader(answers: string[]): (prompt: string) => Promise<string | undefined> {
  const queue = [...answers]
  return async () => (queue.length > 0 ? queue.shift()! : undefined)
}

interface Harness {
  out: string[]
  loginArgs: string[][]
  orchestratorCwds: string[]
  deps: {
    out: (l: string) => void
    login: (argv: string[]) => Promise<number>
    orchestrator: (cwd: string) => Promise<number>
    cwd: string
  }
}

function harness(opts: { loginCode?: number; orchestratorCode?: number } = {}): Harness {
  const out: string[] = []
  const loginArgs: string[][] = []
  const orchestratorCwds: string[] = []
  return {
    out,
    loginArgs,
    orchestratorCwds,
    deps: {
      out: (l) => out.push(l),
      login: async (argv) => {
        loginArgs.push(argv)
        return opts.loginCode ?? 0
      },
      orchestrator: async (cwd) => {
        orchestratorCwds.push(cwd)
        return opts.orchestratorCode ?? 0
      },
      cwd: '/work/repo',
    },
  }
}

describe('runWelcome', () => {
  it('option 1 → runs the hosted login (browser method), not the orchestrator', async () => {
    const h = harness({ loginCode: 0 })
    const code = await runWelcome({ ...h.deps, readLine: reader(['1']) })
    expect(code).toBe(0)
    expect(h.loginArgs).toEqual([['--browser']])
    expect(h.orchestratorCwds).toEqual([])
  })

  it('option 1 → surfaces the login exit code', async () => {
    const h = harness({ loginCode: 3 })
    const code = await runWelcome({ ...h.deps, readLine: reader(['1']) })
    expect(code).toBe(3)
  })

  it('option 2 → prints the agent-setup prompt, then runs the orchestrator on cwd', async () => {
    const h = harness()
    // '2' picks self-hosted; '' (Enter) accepts the default "yes, print it".
    const code = await runWelcome({ ...h.deps, readLine: reader(['2', '']) })
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain(AGENT_SETUP_PROMPT)
    expect(h.orchestratorCwds).toEqual(['/work/repo'])
    expect(h.loginArgs).toEqual([])
  })

  it('option 2 with "n" → skips the prompt but still runs the orchestrator', async () => {
    const h = harness()
    const code = await runWelcome({ ...h.deps, readLine: reader(['2', 'n']) })
    expect(code).toBe(0)
    expect(h.out.join('\n')).not.toContain(AGENT_SETUP_PROMPT)
    expect(h.orchestratorCwds).toEqual(['/work/repo'])
  })

  it('empty choice defaults to self-hosted', async () => {
    const h = harness()
    const code = await runWelcome({ ...h.deps, readLine: reader(['', '']) })
    expect(code).toBe(0)
    expect(h.orchestratorCwds).toEqual(['/work/repo'])
    expect(h.loginArgs).toEqual([])
  })

  it('re-prompts on an unrecognised choice, then honours the next one', async () => {
    const h = harness()
    const code = await runWelcome({ ...h.deps, readLine: reader(['9', '1']) })
    expect(code).toBe(0)
    expect(h.loginArgs).toEqual([['--browser']])
    expect(h.out.join('\n')).toContain("isn't 1 or 2")
  })

  it('no terminal input (EOF) falls through to the self-hosted orchestrator', async () => {
    const h = harness()
    const code = await runWelcome({ ...h.deps, readLine: reader([]) })
    expect(code).toBe(0)
    expect(h.orchestratorCwds).toEqual(['/work/repo'])
    expect(h.loginArgs).toEqual([])
  })

  it('prints the NEAT wordmark and version header', async () => {
    const h = harness()
    await runWelcome({ ...h.deps, readLine: reader(['1']) })
    const printed = h.out.join('\n')
    expect(printed).toContain('neat.is  ·  v')
    // A row of the block-letter wordmark.
    expect(printed).toContain('███')
  })
})

describe('shouldShowWelcome — gated on the project, not the machine', () => {
  const fresh = { readRegistry: async () => ({ projects: [] }), hasSnapshot: async () => false }

  it('non-TTY → false, and the registry is never read', async () => {
    let read = false
    const show = await shouldShowWelcome({
      stdinIsTTY: false,
      stdoutIsTTY: true,
      cwd: '/repo/new',
      readRegistry: async () => {
        read = true
        return { projects: [] }
      },
      hasSnapshot: async () => false,
    })
    expect(show).toBe(false)
    expect(read).toBe(false)
  })

  it('stdout not a TTY → false', async () => {
    expect(
      await shouldShowWelcome({ stdinIsTTY: true, stdoutIsTTY: false, cwd: '/repo/new', ...fresh }),
    ).toBe(false)
  })

  it('a directory that is not a project yet → true, even with other projects registered', async () => {
    // The regression this replaces: one `neat login` anywhere used to close the
    // door for every future project on the machine. Registered projects elsewhere
    // say nothing about this directory.
    const show = await shouldShowWelcome({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      cwd: '/repo/new',
      readRegistry: async () => ({ projects: [{ path: '/repo/other' }, { path: '/work/api' }] }),
      hasSnapshot: async () => false,
    })
    expect(show).toBe(true)
  })

  it('a registered directory → false (straight to the orchestrator)', async () => {
    const show = await shouldShowWelcome({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      cwd: '/repo/api',
      readRegistry: async () => ({ projects: [{ path: '/repo/api' }] }),
      hasSnapshot: async () => false,
    })
    expect(show).toBe(false)
  })

  it('matches a registered path that is spelled differently', async () => {
    // Registration stores a resolved absolute path; the gate resolves both sides so
    // a trailing slash or a `.` segment still counts as the same project.
    const show = await shouldShowWelcome({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      cwd: '/repo/api/./',
      readRegistry: async () => ({ projects: [{ path: '/repo/api' }] }),
      hasSnapshot: async () => false,
    })
    expect(show).toBe(false)
  })

  it('an unregistered directory that has been extracted before → false', async () => {
    const show = await shouldShowWelcome({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      cwd: '/repo/scanned',
      readRegistry: async () => ({ projects: [] }),
      hasSnapshot: async () => true,
    })
    expect(show).toBe(false)
  })

  it('a registry read error is treated as not-a-first-run (never throws)', async () => {
    const show = await shouldShowWelcome({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      cwd: '/repo/new',
      readRegistry: async () => {
        throw new Error('malformed projects.json')
      },
      hasSnapshot: async () => false,
    })
    expect(show).toBe(false)
  })
})

describe('runWelcome — the navigable menu', () => {
  // A scripted key sequence stands in for the terminal; the real reader decodes
  // escape sequences into these same tokens.
  function keys(seq: string[]): () => Promise<string | undefined> {
    let i = 0
    return async () => seq[i++] as string | undefined
  }

  it('renders both options with the first highlighted', async () => {
    const lines: string[] = []
    await runWelcome({
      out: (l) => lines.push(l),
      readKey: keys(['enter']) as never,
      moveCursorUp: () => {},
      login: async () => 0,
      orchestrator: async () => 0,
    })
    expect(lines).toContain('  ❯ 1) Log me into Hosted Neat')
    expect(lines).toContain("    2) I'd like to self-host or use it locally (copy a prompt)")
  })

  it('down then Enter chooses the local path, not the login', async () => {
    let loggedIn = false
    let ranOn: string | undefined
    await runWelcome({
      out: () => {},
      readKey: keys(['down', 'enter']) as never,
      moveCursorUp: () => {},
      readLine: async () => 'n',
      login: async () => {
        loggedIn = true
        return 0
      },
      orchestrator: async (cwd) => {
        ranOn = cwd
        return 0
      },
      cwd: '/repo/new',
    })
    expect(loggedIn).toBe(false)
    expect(ranOn).toBe('/repo/new')
  })

  it('Enter on the first row runs the hosted login with --browser', async () => {
    let argv: string[] | undefined
    await runWelcome({
      out: () => {},
      readKey: keys(['enter']) as never,
      moveCursorUp: () => {},
      login: async (a) => {
        argv = a
        return 0
      },
      orchestrator: async () => 0,
    })
    expect(argv).toEqual(['--browser'])
  })

  it('j and k move the highlight too', async () => {
    let loggedIn = false
    await runWelcome({
      out: () => {},
      // down to row 2, back up to row 1, then choose → the login
      readKey: keys(['down', 'up', 'enter']) as never,
      moveCursorUp: () => {},
      login: async () => {
        loggedIn = true
        return 0
      },
      orchestrator: async () => 0,
    })
    expect(loggedIn).toBe(true)
  })

  it('the digits still jump straight to a choice', async () => {
    let argv: string[] | undefined
    await runWelcome({
      out: () => {},
      readKey: keys(['select-1']) as never,
      moveCursorUp: () => {},
      login: async (a) => {
        argv = a
        return 0
      },
      orchestrator: async () => 0,
    })
    expect(argv).toEqual(['--browser'])
  })

  it('an unbound key is ignored rather than choosing something', async () => {
    let argv: string[] | undefined
    await runWelcome({
      out: () => {},
      readKey: keys(['ignore', 'select-1']) as never,
      moveCursorUp: () => {},
      login: async (a) => {
        argv = a
        return 0
      },
      orchestrator: async () => 0,
    })
    expect(argv).toEqual(['--browser'])
  })

  it('cancelling lands on the local path, exactly as EOF already does', async () => {
    let ranOn: string | undefined
    await runWelcome({
      out: () => {},
      readKey: keys(['cancel']) as never,
      moveCursorUp: () => {},
      readLine: async () => 'n',
      orchestrator: async (cwd) => {
        ranOn = cwd
        return 0
      },
      cwd: '/repo/new',
    })
    expect(ranOn).toBe('/repo/new')
  })

  it('with no key reader it falls back to the numbered prompt', async () => {
    // No `readKey` injected and no TTY under vitest, so the raw reader is
    // unavailable and the pre-existing numbered prompt runs instead.
    const prompts: string[] = []
    let argv: string[] | undefined
    await runWelcome({
      out: () => {},
      readLine: async (p) => {
        prompts.push(p)
        return '1'
      },
      login: async (a) => {
        argv = a
        return 0
      },
      orchestrator: async () => 0,
    })
    expect(prompts[0]).toContain('Choose 1 or 2')
    expect(argv).toEqual(['--browser'])
  })
})

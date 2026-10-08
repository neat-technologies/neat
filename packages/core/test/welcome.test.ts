import { describe, it, expect } from 'vitest'
import {
  runWelcome,
  shouldShowWelcome,
  renderAgentSetupPrompt,
  PromptCancelled,
} from '../src/welcome.js'

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

  it('option 2 → builds first, then prints the agent directive with the real project and port', async () => {
    const h = harness()
    const code = await runWelcome({
      ...h.deps,
      readLine: reader(['2', '', '']),
      readDaemon: async () => ({ projectPath: '/work/repo', restPort: 8083 }),
    })
    expect(code).toBe(0)
    expect(h.out.join('\n')).toContain(renderAgentSetupPrompt('repo', 8083))
    expect(h.out.findIndex((line) => line.includes('Building your local graph'))).toBeLessThan(
      h.out.findIndex((line) => line.includes('copy the directive')),
    )
    expect(h.orchestratorCwds).toEqual(['/work/repo'])
    expect(h.loginArgs).toEqual([])
  })

  it('option 2 with "n" → skips the prompt but still runs the orchestrator', async () => {
    const h = harness()
    const code = await runWelcome({ ...h.deps, readLine: reader(['2', '', 'n']) })
    expect(code).toBe(0)
    expect(h.out.join('\n')).not.toContain('NEAT is set up for project')
    expect(h.orchestratorCwds).toEqual(['/work/repo'])
  })

  it('does not offer a ready-to-use directive when the build failed', async () => {
    const h = harness({ orchestratorCode: 1 })
    const asked: string[] = []
    const code = await runWelcome({
      ...h.deps,
      readLine: async (prompt) => {
        asked.push(prompt)
        return prompt.includes('Choose') ? '2' : ''
      },
    })
    expect(code).toBe(1)
    expect(asked.some((prompt) => prompt.includes('copy-paste setup prompt'))).toBe(false)
    expect(h.out.join('\n')).not.toContain('NEAT is set up for project')
  })

  it('does not offer a ready-to-use directive after a dry run', async () => {
    const h = harness()
    const asked: string[] = []
    await runWelcome({
      ...h.deps,
      dryRun: true,
      instrumentFlagGiven: true,
      readLine: async (prompt) => {
        asked.push(prompt)
        return '2'
      },
    })
    expect(asked.some((prompt) => prompt.includes('copy-paste setup prompt'))).toBe(false)
    expect(h.out.join('\n')).not.toContain('NEAT is set up for project')
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

  it('EOF lands on the local path — nobody can answer, so the bare-`neat` path runs', async () => {
    let ranOn: string | undefined
    await runWelcome({
      out: () => {},
      readKey: keys([undefined as unknown as string]) as never,
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

describe('runWelcome — Ctrl-C leaves quietly (#1232)', () => {
  // The shape node's readline/promises rejects with when Ctrl-C lands on a
  // pending question(). Reproduced here rather than imported so the test states
  // exactly what it is defending against.
  function abortError(): Error {
    const e = new Error('Aborted with Ctrl+C')
    e.name = 'AbortError'
    ;(e as unknown as { code: string }).code = 'ABORT_ERR'
    return e
  }

  it('an interrupt at the [Y/n] prompt exits 130 instead of throwing', async () => {
    let ran = false
    const code = await runWelcome({
      out: () => {},
      readKey: (async () => 'select-2') as never,
      moveCursorUp: () => {},
      readLine: async () => {
        throw abortError()
      },
      orchestrator: async () => {
        ran = true
        return 0
      },
    })
    expect(code).toBe(130)
    // The point of the fix: it does not go on to run the thing that was refused.
    expect(ran).toBe(false)
  })

  it('an interrupt at the menu exits 130 rather than starting the extraction', async () => {
    let ran = false
    const code = await runWelcome({
      out: () => {},
      readKey: (async () => 'cancel') as never,
      moveCursorUp: () => {},
      readLine: async () => 'n',
      orchestrator: async () => {
        ran = true
        return 0
      },
    })
    expect(code).toBe(130)
    expect(ran).toBe(false)
  })

  it('a reader may signal a cancel with PromptCancelled directly', async () => {
    const code = await runWelcome({
      out: () => {},
      readLine: async () => {
        throw new PromptCancelled()
      },
      orchestrator: async () => 0,
    })
    expect(code).toBe(130)
  })

  it('EOF still falls through to the local path — not a cancel', async () => {
    let ranOn: string | undefined
    const code = await runWelcome({
      out: () => {},
      readKey: (async () => undefined) as never,
      moveCursorUp: () => {},
      readLine: async () => undefined,
      orchestrator: async (cwd) => {
        ranOn = cwd
        return 0
      },
      cwd: '/repo/new',
    })
    expect(code).toBe(0)
    expect(ranOn).toBe('/repo/new')
  })

  it('an unrelated error is not swallowed as a cancel', async () => {
    await expect(
      runWelcome({
        out: () => {},
        readKey: (async () => 'select-1') as never,
        moveCursorUp: () => {},
        login: async () => {
          throw new Error('login blew up')
        },
      }),
    ).rejects.toThrow('login blew up')
  })
})

describe('runWelcome — naming a project whose basename is taken (#1239)', () => {
  function reg(projects: { name: string; path: string }[]) {
    return async () => ({ projects })
  }
  function reader(answers: string[], asked: string[] = []) {
    let i = 0
    return async (prompt: string): Promise<string | undefined> => {
      asked.push(prompt)
      // The agent-prompt offer is answered "n"; everything after is the name question.
      return prompt.includes('copy-paste') ? 'n' : answers[i++]
    }
  }
  // These stay about naming: `instrumentFlagGiven` silences the instrument question
  // so a reader's answers line up with the name prompt. The two together are covered
  // by the both-prompts test at the end.
  const local = (deps: Parameters<typeof runWelcome>[0]) =>
    runWelcome({
      out: () => {},
      readKey: (async () => 'select-2') as never,
      moveCursorUp: () => {},
      instrumentFlagGiven: true,
      ...deps,
    })

  it('says nothing when the basename is free', async () => {
    const asked: string[] = []
    let opts: unknown = 'not-called'
    await local({
      cwd: '/repo/api',
      readRegistry: reg([{ name: 'other', path: '/elsewhere' }]),
      readLine: reader([], asked),
      orchestrator: async (_c, o) => {
        opts = o
        return 0
      },
    })
    expect(asked.some((p) => p.includes('Name this one'))).toBe(false)
    expect(opts).toEqual({ headerShown: true })
  })

  it('asks when it is taken, and Enter accepts the suggestion', async () => {
    const lines: string[] = []
    const asked: string[] = []
    let opts: { project?: string } | undefined
    await runWelcome({
      out: (l) => lines.push(l),
      readKey: (async () => 'select-2') as never,
      moveCursorUp: () => {},
      instrumentFlagGiven: true,
      cwd: '/repo/api',
      readRegistry: reg([{ name: 'api', path: '/somewhere/else/api' }]),
      readLine: reader([''], asked),
      orchestrator: async (_c, o) => {
        opts = o
        return 0
      },
    })
    expect(lines.some((l) => l.includes('already registered (/somewhere/else/api)'))).toBe(true)
    expect(asked.some((p) => p.includes('Name this one: [api-2]'))).toBe(true)
    expect(opts).toEqual({ headerShown: true, project: 'api-2' })
  })

  it('takes a name the person types', async () => {
    let opts: { project?: string } | undefined
    await local({
      cwd: '/repo/api',
      readRegistry: reg([{ name: 'api', path: '/elsewhere/api' }]),
      readLine: reader(['billing-api']),
      orchestrator: async (_c, o) => {
        opts = o
        return 0
      },
    })
    expect(opts).toEqual({ headerShown: true, project: 'billing-api' })
  })

  it('suggests the first free suffix, not always -2', async () => {
    const asked: string[] = []
    await local({
      cwd: '/repo/api',
      readRegistry: reg([
        { name: 'api', path: '/a/api' },
        { name: 'api-2', path: '/b/api' },
        { name: 'api-3', path: '/c/api' },
      ]),
      readLine: reader([''], asked),
      orchestrator: async () => 0,
    })
    expect(asked.some((p) => p.includes('[api-4]'))).toBe(true)
  })

  it('re-asks when the typed name is taken by someone else', async () => {
    const lines: string[] = []
    let opts: { project?: string } | undefined
    await runWelcome({
      out: (l) => lines.push(l),
      readKey: (async () => 'select-2') as never,
      moveCursorUp: () => {},
      instrumentFlagGiven: true,
      cwd: '/repo/api',
      readRegistry: reg([
        { name: 'api', path: '/a/api' },
        { name: 'taken', path: '/b/taken' },
      ]),
      readLine: reader(['taken', 'free-name']),
      orchestrator: async (_c, o) => {
        opts = o
        return 0
      },
    })
    expect(lines.some((l) => l.includes('is registered too (/b/taken)'))).toBe(true)
    expect(opts).toEqual({ headerShown: true, project: 'free-name' })
  })

  it('re-asks on a name that could not be a directory', async () => {
    const lines: string[] = []
    let opts: { project?: string } | undefined
    await runWelcome({
      out: (l) => lines.push(l),
      readKey: (async () => 'select-2') as never,
      moveCursorUp: () => {},
      instrumentFlagGiven: true,
      cwd: '/repo/api',
      readRegistry: reg([{ name: 'api', path: '/a/api' }]),
      // A separator would escape neat-out/ when the name becomes <name>.json.
      readLine: reader(['../escape', 'safe-name']),
      orchestrator: async (_c, o) => {
        opts = o
        return 0
      },
    })
    expect(lines.some((l) => l.includes("won't work as a project name"))).toBe(true)
    expect(opts).toEqual({ headerShown: true, project: 'safe-name' })
  })

  it('does not ask when the registered entry is this very directory', async () => {
    const asked: string[] = []
    let opts: unknown = 'not-called'
    await local({
      cwd: '/repo/api',
      readRegistry: reg([{ name: 'api', path: '/repo/api' }]),
      readLine: reader([], asked),
      orchestrator: async (_c, o) => {
        opts = o
        return 0
      },
    })
    expect(asked.some((p) => p.includes('Name this one'))).toBe(false)
    expect(opts).toEqual({ headerShown: true })
  })

  it('leaves the run alone when the registry cannot be read', async () => {
    let opts: unknown = 'not-called'
    await local({
      cwd: '/repo/api',
      readRegistry: async () => {
        throw new Error('unreadable')
      },
      readLine: reader([]),
      orchestrator: async (_c, o) => {
        opts = o
        return 0
      },
    })
    expect(opts).toEqual({ headerShown: true })
  })
})
describe('runWelcome — asking before it edits their files (#1233)', () => {
  /** Answers each prompt in order; records what was asked. */
  function scriptedReader(answers: string[], asked: string[]) {
    let i = 0
    return async (prompt: string): Promise<string | undefined> => {
      asked.push(prompt)
      return answers[i++]
    }
  }

  it('asks before instrumenting, and Enter takes it', async () => {
    const asked: string[] = []
    const lines: string[] = []
    let opts: unknown = 'not-called'
    await runWelcome({
      out: (l) => lines.push(l),
      readKey: (async () => 'select-2') as never,
      moveCursorUp: () => {},
      readLine: scriptedReader(['', 'n'], asked),
      orchestrator: async (_cwd, o) => {
        opts = o
        return 0
      },
    })
    expect(asked.some((p) => p.includes('[Y/n]'))).toBe(true)
    expect(lines).toContain('Instrument the services for OpenTelemetry now?')
    expect(lines).toContain(
      'This edits package.json / requirements.txt / go.mod and runs the package manager.',
    )
    // Accepting carries `yes`, which suppresses the orchestrator's own instrument
    // prompt — the door just asked, and asking twice is worse than not asking.
    expect(opts).toEqual({ headerShown: true, yes: true })
  })

  it('"n" runs the orchestrator with instrumentation off', async () => {
    const asked: string[] = []
    const lines: string[] = []
    let opts: { noInstrument?: boolean } | undefined
    await runWelcome({
      out: (l) => lines.push(l),
      readKey: (async () => 'select-2') as never,
      moveCursorUp: () => {},
      readLine: scriptedReader(['n', 'n'], asked),
      orchestrator: async (_cwd, o) => {
        opts = o
        return 0
      },
    })
    expect(opts).toEqual({ headerShown: true, noInstrument: true })
    // And it says what declining costs, rather than going quiet.
    expect(lines.some((l) => l.includes('declared side only'))).toBe(true)
    expect(lines.some((l) => l.includes('npx neat.is init . --apply'))).toBe(true)
  })

  it('does not ask again when --no-instrument was already given', async () => {
    const asked: string[] = []
    let opts: unknown = 'not-called'
    await runWelcome({
      out: () => {},
      readKey: (async () => 'select-2') as never,
      moveCursorUp: () => {},
      readLine: scriptedReader(['n'], asked),
      instrumentFlagGiven: true,
      orchestrator: async (_cwd, o) => {
        opts = o
        return 0
      },
    })
    // Only the agent-prompt offer was asked.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('copy-paste setup prompt')
    // Nothing overridden — the flag the person passed still governs.
    expect(opts).toEqual({ headerShown: true })
  })

  it('an interrupt at the instrument question exits 130 and runs nothing', async () => {
    let ran = false
    const code = await runWelcome({
      out: () => {},
      readKey: (async () => 'select-2') as never,
      moveCursorUp: () => {},
      readLine: async (prompt: string) => {
        if (prompt.includes('[Y/n]') && !prompt.includes('copy-paste')) throw new PromptCancelled()
        return 'n'
      },
      orchestrator: async () => {
        ran = true
        return 0
      },
    })
    expect(code).toBe(130)
    expect(ran).toBe(false)
  })
})

describe('runWelcome — both questions, in the order they are asked', () => {
  it('asks for a name first, then about instrumenting, and carries both answers', async () => {
    const asked: string[] = []
    let opts: { project?: string; yes?: boolean; noInstrument?: boolean } | undefined
    await runWelcome({
      out: () => {},
      readKey: (async () => 'select-2') as never,
      moveCursorUp: () => {},
      cwd: '/repo/api',
      readRegistry: async () => ({ projects: [{ name: 'api', path: '/elsewhere/api' }] }),
      readLine: async (prompt: string) => {
        asked.push(prompt)
        if (prompt.includes('copy-paste')) return 'n'
        if (prompt.includes('Name this one')) return ''
        return 'n' // the instrument question
      },
      orchestrator: async (_cwd, o) => {
        opts = o
        return 0
      },
    })
    // Naming decides what the project IS, so it comes before anything is written.
    const nameAt = asked.findIndex((p) => p.includes('Name this one'))
    const instrAt = asked.findIndex((p) => p === '[Y/n]: ')
    expect(nameAt).toBeGreaterThanOrEqual(0)
    expect(instrAt).toBeGreaterThan(nameAt)
    expect(opts).toEqual({ headerShown: true, project: 'api-2', noInstrument: true })
  })
})

describe("runWelcome — the door's header is the header (#1242)", () => {
  it('prints the wordmark once and tells the orchestrator it did', async () => {
    const lines: string[] = []
    let opts: { headerShown?: boolean } | undefined
    await runWelcome({
      out: (l) => lines.push(l),
      readKey: (async () => 'select-2') as never,
      moveCursorUp: () => {},
      readLine: async () => 'n',
      instrumentFlagGiven: true,
      orchestrator: async (_cwd, o) => {
        opts = o
        return 0
      },
    })
    expect(lines.filter((l) => l.includes('neat.is')).length).toBe(1)
    expect(opts?.headerShown).toBe(true)
  })
})

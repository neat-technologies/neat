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

describe('shouldShowWelcome', () => {
  it('non-TTY → false (orchestrator/normal path), profiles never read', async () => {
    let read = false
    const show = await shouldShowWelcome({
      stdinIsTTY: false,
      stdoutIsTTY: true,
      readProfiles: async () => {
        read = true
        return { profiles: [] }
      },
    })
    expect(show).toBe(false)
    expect(read).toBe(false)
  })

  it('stdout not a TTY → false', async () => {
    const show = await shouldShowWelcome({
      stdinIsTTY: true,
      stdoutIsTTY: false,
      readProfiles: async () => ({ profiles: [] }),
    })
    expect(show).toBe(false)
  })

  it('interactive + no profiles → true (show the menu)', async () => {
    const show = await shouldShowWelcome({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      readProfiles: async () => ({ profiles: [] }),
    })
    expect(show).toBe(true)
  })

  it('interactive + existing profiles → false (returning user)', async () => {
    const show = await shouldShowWelcome({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      readProfiles: async () => ({ profiles: [{ name: 'hosted' }] }),
    })
    expect(show).toBe(false)
  })

  it('a profiles read error is treated as not-first-run (never throws)', async () => {
    const show = await shouldShowWelcome({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      readProfiles: async () => {
        throw new Error('malformed profiles.json')
      },
    })
    expect(show).toBe(false)
  })
})

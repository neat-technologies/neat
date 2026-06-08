import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stub the orchestrator so `main()`'s bare-invocation path is observable
// without standing up a daemon or touching disk. The bare path resolves
// `process.cwd()` (always a real directory) and hands off to runOrchestrator
// — we assert the hand-off, not the orchestration.
const runOrchestrator = vi.fn(async () => ({
  exitCode: 0,
  steps: {
    discovery: { services: 1, languages: ['typescript'] },
    extraction: { nodesAdded: 0, edgesAdded: 0 },
    gitignore: 'unchanged' as const,
    apply: { instrumented: 0, alreadyInstrumented: 0, libOnly: 0, skipped: true },
    daemon: 'skipped' as const,
    browser: 'skipped' as const,
  },
}))

vi.mock('../src/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orchestrator.js')>()
  return { ...actual, runOrchestrator }
})

describe('bare `npx neat.is` invocation (issue #483)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>
  const origArgv = process.argv

  beforeEach(() => {
    runOrchestrator.mockClear()
    // process.exit must not actually exit the test runner — throw a sentinel
    // the test can catch so control flow stops where `main()` would have.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`)
    }) as never)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    exitSpy.mockRestore()
    logSpy.mockRestore()
    process.argv = origArgv
  })

  it('no command → runs the orchestrator on cwd, does not print usage', async () => {
    // argv[1] is a neutral path: the module's auto-run guard only fires for a
    // `cli.cjs`/`neat` entry, so importing cli.js here doesn't kick off a
    // stray main() of its own.
    process.argv = ['node', '/tmp/test-runner']
    const { main } = await import('../src/cli.js')
    await main()

    expect(runOrchestrator).toHaveBeenCalledTimes(1)
    const arg = runOrchestrator.mock.calls[0]![0] as { scanPath: string }
    expect(arg.scanPath).toBe(process.cwd())
    // usage() leads with the npx-prefix header line — its absence proves we
    // didn't fall into the help branch.
    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')
    expect(printed).not.toContain('Prefix commands with')
  })

  it('`-h` → prints usage, never touches the orchestrator', async () => {
    process.argv = ['node', '/tmp/test-runner', '-h']
    const { main } = await import('../src/cli.js')
    await expect(main()).rejects.toThrow('__exit__:0')

    expect(runOrchestrator).not.toHaveBeenCalled()
    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')
    expect(printed).toContain('Prefix commands with')
  })

  it('`--help` → prints usage, never touches the orchestrator', async () => {
    process.argv = ['node', '/tmp/test-runner', '--help']
    const { main } = await import('../src/cli.js')
    await expect(main()).rejects.toThrow('__exit__:0')

    expect(runOrchestrator).not.toHaveBeenCalled()
  })
})

describe('usage() command-prefix awareness (issue #483)', () => {
  const origEnv = { ...process.env }
  const origArgv = process.argv
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    process.env = { ...origEnv }
    process.argv = origArgv
  })

  function lines(): string {
    return logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n')
  }

  it('renders the `npx neat.is` prefix under the npx signal', async () => {
    delete process.env.npm_execpath
    process.env.npm_command = 'exec'
    const { usage } = await import('../src/cli.js')
    usage()
    const out = lines()
    expect(out).toContain('npx neat.is root-cause')
    expect(out).toContain('Prefix commands with `npx neat.is`')
  })

  it('renders the bare `neat` prefix for a global install', async () => {
    delete process.env.npm_command
    delete process.env.npm_execpath
    process.argv = ['/usr/local/bin/node', '/usr/local/bin/neat', '--help']
    const { usage } = await import('../src/cli.js')
    usage()
    const out = lines()
    expect(out).toContain('example: neat root-cause')
    expect(out).not.toContain('npx neat.is root-cause')
  })
})

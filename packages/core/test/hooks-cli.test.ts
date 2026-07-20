import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runHooks, runHooksCommand, HOOK_MATCHER } from '../src/hooks-cli.js'

// The affordances that make an agent reach for NEAT's graph before it
// grep-scans: a Claude Code PreToolUse search-nudge hook, and agent-agnostic
// graph-first guidance. Everything runs against a temp NEAT_HOME + a temp
// settings file, never the real ones.

const here = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(here, '../../claude-skill')
const SHIPPED_HOOK = path.join(SKILL_DIR, 'hooks/neat-search-nudge.mjs')
const SHIPPED_GUIDE = path.join(SKILL_DIR, 'GRAPH_FIRST.md')

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-hooks-cli-'))
  const real = await fs.realpath(dir)
  tmpDirs.push(real)
  return real
}

// Run runHooks with a temp home + settings file, capturing stdout/stderr.
async function withTmpEnv<T>(
  fn: (env: { home: string; settings: string }) => Promise<T>,
): Promise<T> {
  const root = await makeTmp()
  const home = path.join(root, 'neat')
  const settings = path.join(root, 'claude', 'settings.json')
  const prevHome = process.env.NEAT_HOME
  const prevSettings = process.env.NEAT_CLAUDE_SETTINGS
  const prevLog = console.log
  const prevErr = console.error
  process.env.NEAT_HOME = home
  process.env.NEAT_CLAUDE_SETTINGS = settings
  console.log = () => {}
  console.error = () => {}
  try {
    return await fn({ home, settings })
  } finally {
    console.log = prevLog
    console.error = prevErr
    if (prevHome === undefined) delete process.env.NEAT_HOME
    else process.env.NEAT_HOME = prevHome
    if (prevSettings === undefined) delete process.env.NEAT_CLAUDE_SETTINGS
    else process.env.NEAT_CLAUDE_SETTINGS = prevSettings
  }
}

// Feed a PreToolUse payload to the shipped hook script as a real child process
// and return the parsed stdout (or null when it stayed a silent no-op).
function runHookScript(
  payload: unknown,
): Promise<{ stdout: string; parsed: unknown | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile('node', [SHIPPED_HOOK], (err, stdout) => {
      if (err) return reject(err)
      const trimmed = stdout.trim()
      resolve({ stdout, parsed: trimmed ? JSON.parse(trimmed) : null })
    })
    child.stdin!.end(JSON.stringify(payload))
  })
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

describe('neat hooks — search-nudge hook (the shipped affordance)', () => {
  it('fires on a Grep tool call with a non-blocking PreToolUse nudge', async () => {
    const { parsed } = await runHookScript({
      tool_name: 'Grep',
      tool_input: { pattern: 'foo' },
    })
    expect(parsed).not.toBeNull()
    const out = parsed as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string }
    }
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    // It nudges toward the graph tools — and never denies the call.
    expect(out.hookSpecificOutput.additionalContext).toMatch(/semantic_search/)
    expect(out.hookSpecificOutput.additionalContext).toMatch(/get_divergences/)
    expect(JSON.stringify(out)).not.toMatch(/permissionDecision/)
  })

  it('fires on Glob and on a Bash grep/find, but not on other Bash', async () => {
    expect((await runHookScript({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } })).parsed).not.toBeNull()
    expect((await runHookScript({ tool_name: 'Bash', tool_input: { command: 'grep -r foo src/' } })).parsed).not.toBeNull()
    expect((await runHookScript({ tool_name: 'Bash', tool_input: { command: 'rg foo' } })).parsed).not.toBeNull()
    expect((await runHookScript({ tool_name: 'Bash', tool_input: { command: 'find . -name x' } })).parsed).not.toBeNull()
    // A Bash command that isn't a search stays a silent no-op.
    expect((await runHookScript({ tool_name: 'Bash', tool_input: { command: 'ls -la' } })).parsed).toBeNull()
    // A path that merely contains "find"/"grep" as a substring doesn't trip it.
    expect((await runHookScript({ tool_name: 'Bash', tool_input: { command: 'node ./scripts/finder.js' } })).parsed).toBeNull()
  })

  it('is a silent no-op on non-search tools (Read/Write/Edit)', async () => {
    for (const tool_name of ['Read', 'Write', 'Edit']) {
      const { stdout, parsed } = await runHookScript({ tool_name, tool_input: { file_path: '/x' } })
      expect(parsed).toBeNull()
      expect(stdout.trim()).toBe('')
    }
  })
})

describe('neat hooks --apply', () => {
  it('materialises the hook script + guidance and wires a PreToolUse entry', async () => {
    await withTmpEnv(async ({ home, settings }) => {
      const { exitCode } = await runHooks({ apply: true, printHook: false, printGuide: false, printSettings: false })
      expect(exitCode).toBe(0)

      const scriptPath = path.join(home, 'hooks', 'neat-search-nudge.mjs')
      const installed = await fs.readFile(scriptPath, 'utf8')
      const shipped = await fs.readFile(SHIPPED_HOOK, 'utf8')
      expect(installed).toBe(shipped)

      const guide = await fs.readFile(path.join(home, 'neat-graph-first.md'), 'utf8')
      expect(guide).toBe(await fs.readFile(SHIPPED_GUIDE, 'utf8'))

      const parsed = JSON.parse(await fs.readFile(settings, 'utf8'))
      const entries = parsed.hooks.PreToolUse
      expect(Array.isArray(entries)).toBe(true)
      const neat = entries.find((e: { matcher?: string }) => e.matcher === HOOK_MATCHER)
      expect(neat).toBeDefined()
      expect(neat.hooks[0].type).toBe('command')
      expect(neat.hooks[0].command).toContain('neat-search-nudge.mjs')
    })
  })

  it('leaves a user\'s existing hooks and settings untouched', async () => {
    await withTmpEnv(async ({ settings }) => {
      await fs.mkdir(path.dirname(settings), { recursive: true })
      await fs.writeFile(
        settings,
        JSON.stringify({
          hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo mine' }] }] },
          model: 'opus',
        }),
      )
      await runHooks({ apply: true, printHook: false, printGuide: false, printSettings: false })
      const parsed = JSON.parse(await fs.readFile(settings, 'utf8'))
      expect(parsed.model).toBe('opus')
      const mine = parsed.hooks.PreToolUse.find((e: { matcher?: string }) => e.matcher === 'Write')
      expect(mine.hooks[0].command).toBe('echo mine')
      // Both the user's entry and ours are present.
      expect(parsed.hooks.PreToolUse.length).toBe(2)
    })
  })

  it('is idempotent — re-applying refreshes rather than duplicating', async () => {
    await withTmpEnv(async ({ settings }) => {
      await runHooks({ apply: true, printHook: false, printGuide: false, printSettings: false })
      await runHooks({ apply: true, printHook: false, printGuide: false, printSettings: false })
      const parsed = JSON.parse(await fs.readFile(settings, 'utf8'))
      const neatEntries = parsed.hooks.PreToolUse.filter((e: { matcher?: string }) => e.matcher === HOOK_MATCHER)
      expect(neatEntries.length).toBe(1)
    })
  })
})

describe('neat hooks — print flags & argv', () => {
  it('--print-hook and --print-guide emit the shipped files verbatim', async () => {
    const out: string[] = []
    const prev = process.stdout.write.bind(process.stdout)
    ;(process.stdout.write as unknown) = (chunk: string) => {
      out.push(chunk)
      return true
    }
    try {
      await runHooks({ apply: false, printHook: true, printGuide: false, printSettings: false })
      await runHooks({ apply: false, printHook: false, printGuide: true, printSettings: false })
    } finally {
      ;(process.stdout.write as unknown) = prev
    }
    expect(out[0]).toBe(await fs.readFile(SHIPPED_HOOK, 'utf8'))
    expect(out[1]).toBe(await fs.readFile(SHIPPED_GUIDE, 'utf8'))
  })

  it('rejects an unknown flag with exit code 2', async () => {
    const prevErr = console.error
    const prevLog = console.log
    console.error = () => {}
    console.log = () => {}
    try {
      expect(await runHooksCommand(['--bogus'])).toBe(2)
    } finally {
      console.error = prevErr
      console.log = prevLog
    }
  })
})

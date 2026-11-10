import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// #1610 — NEAT_SEARCH_NUDGE_ONCE: the graph-first nudge speaks on the first text
// search of a session and stays silent after. Off by default; the gate and the
// other modes are unaffected.

const here = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.resolve(here, '../../claude-skill/hooks/neat-search-nudge.mjs')

let home: string

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-hook-once-'))
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

type HookOutput = { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } } | null

function run(payload: Record<string, unknown>, env: Record<string, string> = {}): Promise<HookOutput> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NEAT_HOME: home,
    NEAT_CLAUDE_CONFIG: path.join(home, 'claude.json'),
    // No daemon in these tests: keep incident-loud out of the way.
    NEAT_SEARCH_DEBUG_LOUD: '0',
    ...env,
  }
  for (const k of ['NEAT_SEARCH_GATE', 'NEAT_SEARCH_NUDGE_ONCE', 'NEAT_CORE_URL', 'NEAT_API_URL', 'NEAT_AUTH_TOKEN']) {
    if (!(k in env)) delete childEnv[k]
  }
  return new Promise((resolve, reject) => {
    const child = execFile('node', [HOOK], { env: childEnv }, (err, stdout) => {
      if (err) return reject(err)
      const t = stdout.trim()
      resolve(t ? (JSON.parse(t) as HookOutput) : null)
    })
    child.stdin!.end(JSON.stringify({ session_id: 's1', cwd: home, ...payload }))
  })
}

const grep = { tool_name: 'Grep', tool_input: { pattern: 'login' } }
const bashGrep = { tool_name: 'Bash', tool_input: { command: 'grep -rn login src' } }
const note = (r: HookOutput) => r?.hookSpecificOutput?.additionalContext

describe('search hook: nudge once per session (#1610)', () => {
  it('by default every text search carries the nudge', async () => {
    expect(note(await run(grep))).toBeTruthy()
    expect(note(await run(grep))).toBeTruthy()
  })

  it('NEAT_SEARCH_NUDGE_ONCE=1 nudges the first search of a session only', async () => {
    const env = { NEAT_SEARCH_NUDGE_ONCE: '1' }
    expect(note(await run(grep, env))).toBeTruthy()
    expect(await run(grep, env)).toBeNull()
    expect(await run(bashGrep, env)).toBeNull()
    expect(note(await run({ ...grep, session_id: 's2' }, env))).toBeTruthy()
  })

  it('a ~/.neat/hooks/nudge-once flag enables it and =0 forces it off', async () => {
    await fs.mkdir(path.join(home, 'hooks'), { recursive: true })
    await fs.writeFile(path.join(home, 'hooks', 'nudge-once'), '')
    expect(note(await run(grep))).toBeTruthy()
    expect(await run(grep)).toBeNull()
    expect(note(await run(grep, { NEAT_SEARCH_NUDGE_ONCE: '0' }))).toBeTruthy()
  })

  it('the gate still denies every search before the graph is consulted', async () => {
    const env = { NEAT_SEARCH_NUDGE_ONCE: '1', NEAT_SEARCH_GATE: '1' }
    for (let i = 0; i < 2; i++) {
      const r = await run(grep, env)
      expect(r?.hookSpecificOutput?.permissionDecision).toBe('deny')
    }
  })
})

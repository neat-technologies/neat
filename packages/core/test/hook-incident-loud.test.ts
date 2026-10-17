import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

// #1452 / ADR-261 — on the bench, an agent with NEAT connected ran `kubectl get
// pods` first and never called a NEAT tool. The search hook now covers ops probes
// too, and when the daemon holds a live incident it speaks first: "NEAT sees <what>
// on <service>; call investigate first". NEAT_SEARCH_DEBUG_LOUD=block denies the
// first such call of the session. No live incident → the quiet nudge, as before.

const here = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.resolve(here, '../../claude-skill/hooks/neat-search-nudge.mjs')

let home: string
let server: Server | undefined
let hits = 0
let incidents: unknown[] = []

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-hook-loud-'))
  hits = 0
  incidents = []
})
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r))
  server = undefined
  await fs.rm(home, { recursive: true, force: true })
})

async function startDaemon(): Promise<string> {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/incidents')) {
      hits++
      const since = new URL(req.url, 'http://x').searchParams.get('since')
      const events = incidents.filter((e) => !since || Date.parse((e as { timestamp: string }).timestamp) >= Date.parse(since))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ count: events.length, total: events.length, events }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function crashLoop(minutesAgo = 2): unknown {
  return {
    id: 'k8s:hotel:mongodb-geo:crash-loop',
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    service: 'mongodb-geo',
    affectedNode: 'service:mongodb-geo',
    errorType: 'K8sDeploymentFault',
    errorMessage: 'Deployment mongodb-geo is crashlooping (restarts: 6); last terminated: Error (exit 1)',
  }
}

function run(
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<{ parsed: Record<string, any> | null; ms: number }> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NEAT_HOME: home,
    NEAT_CLAUDE_CONFIG: path.join(home, 'claude.json'),
    ...env,
  }
  for (const k of ['NEAT_SEARCH_GATE', ...(env.NEAT_CORE_URL ? [] : ['NEAT_CORE_URL']), 'NEAT_API_URL', 'NEAT_AUTH_TOKEN']) {
    if (!(k in env)) delete childEnv[k]
  }
  if (!('NEAT_SEARCH_DEBUG_LOUD' in env)) delete childEnv.NEAT_SEARCH_DEBUG_LOUD
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const child = execFile('node', [HOOK], { env: childEnv }, (err, stdout) => {
      if (err) return reject(err)
      const t = stdout.trim()
      resolve({ parsed: t ? JSON.parse(t) : null, ms: Date.now() - start })
    })
    child.stdin!.end(JSON.stringify({ session_id: 's1', cwd: home, ...payload }))
  })
}

const kubectl = { tool_name: 'Bash', tool_input: { command: 'kubectl get pods -n hotel-reservation' } }

describe('search hook: ops probes and the live-incident loud mode (ADR-261)', () => {
  it('a kubectl before any NEAT call, with a live incident, leads with what NEAT sees', async () => {
    const url = await startDaemon()
    incidents = [crashLoop()]
    const { parsed } = await run(kubectl, { NEAT_CORE_URL: url })
    const note = parsed?.hookSpecificOutput?.additionalContext as string
    expect(note.split('\n')[0]).toBe(
      'NEAT sees Deployment mongodb-geo is crashlooping (restarts: 6); last terminated: Error (exit 1) on mongodb-geo; call investigate first.',
    )
    expect(note).toContain('mcp__neat__investigate')
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBeUndefined()
  })

  it('asks the daemon once per session', async () => {
    const url = await startDaemon()
    incidents = [crashLoop()]
    await run(kubectl, { NEAT_CORE_URL: url })
    await run({ tool_name: 'Grep', tool_input: { pattern: 'geo' } }, { NEAT_CORE_URL: url })
    await run(kubectl, { NEAT_CORE_URL: url })
    expect(hits).toBe(1)
  })

  it('=block denies the first such call of the session, then only speaks', async () => {
    const url = await startDaemon()
    incidents = [crashLoop()]
    const first = await run(kubectl, { NEAT_CORE_URL: url, NEAT_SEARCH_DEBUG_LOUD: 'block' })
    expect(first.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(first.parsed?.hookSpecificOutput?.permissionDecisionReason).toMatch(/^NEAT sees .* on mongodb-geo; call investigate first\./)
    const second = await run(kubectl, { NEAT_CORE_URL: url, NEAT_SEARCH_DEBUG_LOUD: 'block' })
    expect(second.parsed?.hookSpecificOutput?.permissionDecision).toBeUndefined()
    expect(second.parsed?.hookSpecificOutput?.additionalContext).toMatch(/^NEAT sees /)
  })

  it('no live incident: an ops probe gets the quiet nudge', async () => {
    const url = await startDaemon()
    incidents = [crashLoop(120)] // two hours old: not live
    const { parsed } = await run(kubectl, { NEAT_CORE_URL: url })
    const note = parsed?.hookSpecificOutput?.additionalContext as string
    expect(note).toMatch(/^NEAT is wired into this project/)
    expect(note).toContain('which kubectl cannot show you')
  })

  it('once the graph has been consulted, an ops probe is silent', async () => {
    const url = await startDaemon()
    incidents = [crashLoop()]
    await run({ tool_name: 'mcp__neat__investigate', tool_input: {} }, { NEAT_CORE_URL: url })
    expect((await run(kubectl, { NEAT_CORE_URL: url })).parsed).toBeNull()
    expect(hits).toBe(0)
  })

  it('an unreachable daemon is silence, not an error, and not slow', async () => {
    const { parsed, ms } = await run(kubectl, { NEAT_CORE_URL: 'http://127.0.0.1:9' })
    expect(parsed?.hookSpecificOutput?.additionalContext).toMatch(/^NEAT is wired into this project/)
    expect(ms).toBeLessThan(5000)
  })

  it('=0 turns the loud mode off', async () => {
    const url = await startDaemon()
    incidents = [crashLoop()]
    const { parsed } = await run(kubectl, { NEAT_CORE_URL: url, NEAT_SEARCH_DEBUG_LOUD: '0' })
    expect(parsed?.hookSpecificOutput?.additionalContext).toMatch(/^NEAT is wired into this project/)
    expect(hits).toBe(0)
  })

  it('finds the daemon from the address the installer wrote into ~/.claude.json', async () => {
    const url = await startDaemon()
    incidents = [crashLoop()]
    await fs.writeFile(
      path.join(home, 'claude.json'),
      JSON.stringify({ mcpServers: { neat: { command: 'npx', env: { NEAT_CORE_URL: url } } } }),
    )
    const { parsed } = await run(kubectl)
    expect(parsed?.hookSpecificOutput?.additionalContext).toMatch(/^NEAT sees /)
  })

  it('matches the probe on the first word only', async () => {
    const url = await startDaemon()
    incidents = [crashLoop()]
    expect((await run({ tool_name: 'Bash', tool_input: { command: 'echo kubectl is great' } }, { NEAT_CORE_URL: url })).parsed).toBeNull()
    expect((await run({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }, { NEAT_CORE_URL: url })).parsed).toBeNull()
    for (const command of ['KUBECONFIG=/k sudo kubectl get ns', 'docker ps', 'docker-compose logs', 'curl -s http://x', 'journalctl -u x', 'gcloud run services list', 'aws ecs list-tasks', 'az aks list', '/usr/local/bin/kubectl get pods']) {
      const { parsed } = await run({ session_id: command, tool_name: 'Bash', tool_input: { command } }, { NEAT_CORE_URL: url })
      expect(parsed?.hookSpecificOutput?.additionalContext, command).toMatch(/^NEAT sees /)
    }
  })
})

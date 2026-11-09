import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureProjectIdentity } from '@neat.is/core/project-identity'
import { resolveServerTarget } from '../src/base-url.js'
import { unresolvedClient } from '../src/client.js'

// ADR-273 / WO-0.2b — the MCP server resolves its target the way the CLI does
// (core project-resolve.ts): the nearest .neat/project.json above the session's
// directory, routed by its binding. The logged-in profile never moves a local
// project, and with no project the server still starts and every tool says why.

let home: string
let cwd: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neat-mcp-target-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'neat-mcp-target-cwd-'))
  mkdirSync(join(home, 'daemons'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NEAT_HOME: home, ...extra })

function record(projectId: string, name: string, path: string, rest: number): void {
  writeFileSync(
    join(home, 'daemons', `${projectId}.json`),
    JSON.stringify({ project: name, projectId, projectPath: path, pid: process.pid, status: 'running', ports: { rest, otlp: rest + 1, web: rest + 2 }, startedAt: '2026-10-22T00:00:00.000Z', neatVersion: '0.10.11' }),
  )
}

describe('resolveServerTarget (ADR-273)', () => {
  it("reaches the project's own daemon from a directory inside it, and states its target", async () => {
    const prev = process.env.NEAT_HOME
    process.env.NEAT_HOME = home
    try {
      const { identity } = await ensureProjectIdentity(cwd, { name: 'newdryve' })
      record(identity.projectId, 'newdryve', cwd, 18080)
      const sub = join(cwd, 'web')
      mkdirSync(sub)
      const t = resolveServerTarget(env(), sub)
      expect(t).toMatchObject({ url: 'http://localhost:18080', source: 'cwd' })
      expect(t.line).toBe(`project=newdryve (${identity.projectId}) · binding=local · daemon=http://localhost:18080`)
      expect(t.error).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prev
    }
  })

  it('a logged-in profile does not move a local project', async () => {
    const prev = process.env.NEAT_HOME
    process.env.NEAT_HOME = home
    try {
      const { identity } = await ensureProjectIdentity(cwd, { name: 'newdryve' })
      record(identity.projectId, 'newdryve', cwd, 18080)
      writeFileSync(join(home, 'profiles.json'), JSON.stringify({ version: 1, active: 'hosted', profiles: [{ name: 'hosted', endpoint: 'https://t.neat.is', authToken: 'x' }] }))
      expect(resolveServerTarget(env(), cwd).url).toBe('http://localhost:18080')
    } finally {
      if (prev === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prev
    }
  })

  it('no project here: unresolved, and the client answers every call with why', async () => {
    const prev = process.env.NEAT_HOME
    process.env.NEAT_HOME = home
    try {
      const t = resolveServerTarget(env(), cwd)
      expect(t.source).toBe('unresolved')
      expect(t.line).toBe('project=(none) · binding=(unresolved) · daemon=(none)')
      expect(t.error).toMatch(/no NEAT project here/)
      await expect(unresolvedClient(t.error!).get('/graph')).rejects.toThrow(/no NEAT project here/)
    } finally {
      if (prev === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prev
    }
  })

  it('a daemon-down project keeps its §6 line, not the unresolved line', async () => {
    const prev = process.env.NEAT_HOME
    process.env.NEAT_HOME = home
    try {
      const { identity } = await ensureProjectIdentity(cwd, { name: 'newdryve' })
      // No daemon record written → the daemon is down.
      const t = resolveServerTarget(env(), cwd)
      expect(t.source).toBe('unresolved')
      expect(t.error).toMatch(/daemon isn't running/)
      expect(t.line).toBe(`project=newdryve (${identity.projectId}) · binding=local · daemon=(not running)`)
    } finally {
      if (prev === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prev
    }
  })

  it('a hosted-but-not-logged-in project keeps its §6 line, not the unresolved line', async () => {
    const prev = process.env.NEAT_HOME
    process.env.NEAT_HOME = home
    try {
      const { identity } = await ensureProjectIdentity(cwd, { name: 'newdryve' })
      writeFileSync(join(cwd, '.neat', 'binding.json'), JSON.stringify({ schemaVersion: 1, binding: 'hosted', org: 'org_acme' }))
      const t = resolveServerTarget(env(), cwd)
      expect(t.source).toBe('unresolved')
      expect(t.error).toMatch(/hosted \(in org_acme\)[\s\S]*neat login/)
      expect(t.line).toBe(`project=newdryve (${identity.projectId}) · binding=hosted@org_acme · daemon=(your hosted login)`)
    } finally {
      if (prev === undefined) delete process.env.NEAT_HOME
      else process.env.NEAT_HOME = prev
    }
  })

  it('an env pin is used as given', () => {
    const t = resolveServerTarget(env({ NEAT_CORE_URL: 'http://ci:9000', NEAT_AUTH_TOKEN: 'tok' }), cwd)
    expect(t).toMatchObject({ url: 'http://ci:9000', source: 'env', authToken: 'tok' })
    expect(t.line).toMatch(/binding=pinned · daemon=http:\/\/ci:9000$/)
  })

  it('NEAT_LEGACY_ROUTING=1 keeps the pre-ADR-273 chain, with a notice', () => {
    const t = resolveServerTarget(env({ NEAT_LEGACY_ROUTING: '1' }), cwd)
    expect(t.source).toBe('default')
    expect(t.notices[0]).toMatch(/NEAT_LEGACY_ROUTING=1/)
  })
})

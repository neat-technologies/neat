import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DAEMON_URL,
  mergeForkMcpConfig,
  neatServerEntry,
} from '../src/mcp-config'

describe('neatServerEntry — the stdio shape the CLI writes', () => {
  it('defaults to `npx -y @neat.is/mcp` with no env', () => {
    expect(neatServerEntry()).toEqual({ command: 'npx', args: ['-y', '@neat.is/mcp'] })
    expect(neatServerEntry(DEFAULT_DAEMON_URL)).toEqual({
      command: 'npx',
      args: ['-y', '@neat.is/mcp'],
    })
  })

  it('pins NEAT_CORE_URL only when the daemon URL is non-default', () => {
    expect(neatServerEntry('http://127.0.0.1:9999')).toEqual({
      command: 'npx',
      args: ['-y', '@neat.is/mcp'],
      env: { NEAT_CORE_URL: 'http://127.0.0.1:9999' },
    })
  })
})

describe('mergeForkMcpConfig — MERGE-NEVER-CLOBBER', () => {
  const server = neatServerEntry()

  it('sets only the neat key and preserves other servers + top-level keys', () => {
    const existing = {
      mcpServers: {
        other: { command: 'node', args: ['other.js'] },
      },
      someTopLevel: { keep: true },
    }
    const { merged, changed } = mergeForkMcpConfig(existing, server)
    expect(changed).toBe(true)
    expect(merged.mcpServers).toEqual({
      other: { command: 'node', args: ['other.js'] },
      neat: server,
    })
    // Existing top-level keys survive untouched.
    expect(merged.someTopLevel).toEqual({ keep: true })
    // The source object is not mutated in place.
    expect(existing.mcpServers.neat).toBeUndefined()
  })

  it('adds mcpServers when the file had none', () => {
    const { merged, changed } = mergeForkMcpConfig({}, server)
    expect(changed).toBe(true)
    expect(merged.mcpServers).toEqual({ neat: server })
  })

  it('is a no-op (changed=false) when the neat entry already matches', () => {
    const first = mergeForkMcpConfig({}, server).merged
    const second = mergeForkMcpConfig(first, server)
    expect(second.changed).toBe(false)
    expect(second.merged).toEqual(first)
  })

  it('re-running is idempotent — byte-identical JSON', () => {
    const existing = { mcpServers: { other: { command: 'x' } } }
    const once = mergeForkMcpConfig(existing, server).merged
    const twice = mergeForkMcpConfig(once, server).merged
    expect(JSON.stringify(twice, null, 2)).toBe(JSON.stringify(once, null, 2))
  })

  it('refreshes the neat entry when it drifted (still never touches others)', () => {
    const stale = {
      mcpServers: {
        other: { command: 'keep' },
        neat: { command: 'npx', args: ['-y', '@neat.is/mcp-OLD'] },
      },
    }
    const { merged, changed } = mergeForkMcpConfig(stale, server)
    expect(changed).toBe(true)
    expect(merged.mcpServers!.neat).toEqual(server)
    expect(merged.mcpServers!.other).toEqual({ command: 'keep' })
  })
})

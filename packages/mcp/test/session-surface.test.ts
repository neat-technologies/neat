import { describe, expect, it } from 'vitest'
import { MCP_TOOL_NAMES } from '@neat.is/types'
import { hiddenTools, sessionLeadEnabled, TOOL_GROUPS } from '../src/session-surface.js'

// #1610 — opt-in switches for a lean, cache-stable session. Defaults are the
// full surface, so these only bite when set.

describe('lean session switches', () => {
  it('keeps every tool unless NEAT_MCP_TOOLS is exactly core', () => {
    expect(hiddenTools({}).size).toBe(0)
    expect(hiddenTools({ NEAT_MCP_TOOLS: 'all' }).size).toBe(0)
    expect(hiddenTools({ NEAT_MCP_TOOLS: '' }).size).toBe(0)
  })

  it('core leaves out the six extend tools and the four connector tools, all real manifest names', () => {
    const hidden = hiddenTools({ NEAT_MCP_TOOLS: 'core' })
    expect(hidden.size).toBe(10)
    expect([...hidden].sort()).toEqual([...TOOL_GROUPS.extend, ...TOOL_GROUPS.connectors].sort())
    for (const name of hidden) expect(MCP_TOOL_NAMES).toContain(name)
    for (const kept of ['ask', 'investigate', 'get_incident_card', 'get_root_cause']) {
      expect(hidden.has(kept as never)).toBe(false)
    }
  })

  it('the session-start lead is on by default; 0 or false turns it off', () => {
    expect(sessionLeadEnabled({})).toBe(true)
    expect(sessionLeadEnabled({ NEAT_SESSION_LEAD: '1' })).toBe(true)
    expect(sessionLeadEnabled({ NEAT_SESSION_LEAD: '0' })).toBe(false)
    expect(sessionLeadEnabled({ NEAT_SESSION_LEAD: 'false' })).toBe(false)
  })
})

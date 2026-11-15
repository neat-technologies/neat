import { describe, expect, it } from 'vitest'
import { MCP_TOOL_NAMES } from '@neat.is/types'
import { hiddenTools, sessionLeadEnabled, TOOL_FAMILIES, TOOL_GROUPS } from '../src/session-surface.js'

// #1610: opt-in switches for a lean, cache-stable session. Defaults are the
// full surface, so these only bite when set.

describe('lean session switches', () => {
  it('unset shows the default families and hides the opt-in ops family; all shows everything', () => {
    const def = hiddenTools({})
    for (const t of TOOL_FAMILIES.ops) expect(def.has(t)).toBe(true)
    expect(def.has('ask')).toBe(false)
    expect(def.has('policy_read')).toBe(false)
    expect(hiddenTools({ NEAT_MCP_TOOLS: 'all' }).size).toBe(0)
    // Empty and unknown values fall back to the default set, never an empty surface.
    expect([...hiddenTools({ NEAT_MCP_TOOLS: '' })].sort()).toEqual([...def].sort())
  })

  it('core exposes the read families and hides extend, connectors, and the opt-in ops', () => {
    const hidden = hiddenTools({ NEAT_MCP_TOOLS: 'core' })
    expect([...hidden].sort()).toEqual(
      [...TOOL_GROUPS.extend, ...TOOL_GROUPS.connectors, ...TOOL_FAMILIES.ops].sort(),
    )
    for (const name of hidden) expect(MCP_TOOL_NAMES).toContain(name)
    for (const kept of ['ask', 'investigate', 'get_incident_card', 'get_root_cause', 'policy_read']) {
      expect(hidden.has(kept as never)).toBe(false)
    }
  })

  it('the session-start lead is on by default; 0 or false turns it off', () => {
    expect(sessionLeadEnabled({})).toBe(true)
    expect(sessionLeadEnabled({ NEAT_SESSION_LEAD: '1' })).toBe(true)
    expect(sessionLeadEnabled({ NEAT_SESSION_LEAD: '0' })).toBe(false)
    expect(sessionLeadEnabled({ NEAT_SESSION_LEAD: 'false' })).toBe(false)
  })

  it('every manifest tool belongs to exactly one family', () => {
    const counts = new Map<string, number>()
    for (const tools of Object.values(TOOL_FAMILIES)) {
      for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    for (const name of MCP_TOOL_NAMES) expect(counts.get(name), `${name} is in no family`).toBe(1)
    for (const [t, n] of counts) {
      expect(MCP_TOOL_NAMES, `${t} is a family member but not in the manifest`).toContain(t)
      expect(n, `${t} is in ${n} families`).toBe(1)
    }
  })

  it('NEAT_MCP_TOOLS names the families to expose; everything else is hidden', () => {
    const sec = hiddenTools({ NEAT_MCP_TOOLS: 'security' })
    for (const t of TOOL_FAMILIES.security) expect(sec.has(t)).toBe(false)
    expect(sec.has('ask')).toBe(true)
    expect(sec.has('investigate')).toBe(true)

    const pair = hiddenTools({ NEAT_MCP_TOOLS: 'investigation, security' })
    expect(pair.has('investigate')).toBe(false)
    expect(pair.has('get_reachable_cves')).toBe(false)
    expect(pair.has('ask')).toBe(true)

    // A value that names no real family falls back to the default set.
    expect([...hiddenTools({ NEAT_MCP_TOOLS: 'nonsense' })].sort()).toEqual([...hiddenTools({})].sort())
  })
})

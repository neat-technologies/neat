// The Claude Code plugin (ADR-159) is a repackaging of surface NEAT already
// ships à la carte: the `neat skill` MCP config, the `neat hooks` search-nudge
// hook, and the skill. "Repackaging" is only honest if the bundled copies stay
// identical to the originals — so these tests fail loudly the moment the plugin
// drifts from the shipped config or hook. They are the correctness guard the
// plugin can't ship without.

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HOOK_MATCHER, HOOK_FILENAME } from '../src/hooks-cli.js'

const here = path.dirname(fileURLToPath(import.meta.url))
// packages/core/test → repo root is three up.
const REPO_ROOT = path.resolve(here, '../../..')
const PLUGIN_DIR = path.join(REPO_ROOT, 'plugin')
const SKILL_DIR = path.join(REPO_ROOT, 'packages/claude-skill')

interface McpServer {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}
interface HookCommand {
  type?: string
  command?: string
}
interface PreToolUseEntry {
  matcher?: string
  hooks?: HookCommand[]
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T
}

describe('Claude Code plugin packaging (ADR-159)', () => {
  it("plugin .mcp.json neat server equals the shipped claude_code_config.json mcpServers.neat", () => {
    const pluginMcp = readJson<{ neat: McpServer }>(path.join(PLUGIN_DIR, '.mcp.json'))
    const shipped = readJson<{ mcpServers: Record<string, McpServer> }>(
      path.join(SKILL_DIR, 'claude_code_config.json'),
    )
    // The plugin server map is unwrapped ({ neat: {...} }); the à-la-carte
    // config nests it under mcpServers. The neat entry itself must not drift —
    // both point at `npx -y @neat.is/mcp` over stdio with NEAT_CORE_URL.
    expect(pluginMcp.neat).toEqual(shipped.mcpServers.neat)
  })

  it('plugin hooks.json matcher equals HOOK_MATCHER (the neat hooks matcher)', () => {
    const hooks = readJson<{ hooks?: { PreToolUse?: PreToolUseEntry[] } }>(
      path.join(PLUGIN_DIR, 'hooks/hooks.json'),
    )
    const preToolUse = hooks.hooks?.PreToolUse ?? []
    expect(Array.isArray(preToolUse)).toBe(true)
    // The entry that runs our search-nudge script must carry the exact matcher
    // `neat hooks --apply` writes, so the plugin and the CLI nudge the same tools.
    const entry = preToolUse.find((e) =>
      (e.hooks ?? []).some(
        (h) => typeof h.command === 'string' && h.command.includes(HOOK_FILENAME),
      ),
    )
    expect(entry, 'no PreToolUse entry invokes the search-nudge hook').toBeDefined()
    expect(entry?.matcher).toBe(HOOK_MATCHER)
  })

  it('plugin hooks.json invokes the bundled hook via ${CLAUDE_PLUGIN_ROOT} with node', () => {
    const hooks = readJson<{ hooks: { PreToolUse: PreToolUseEntry[] } }>(
      path.join(PLUGIN_DIR, 'hooks/hooks.json'),
    )
    const hook = hooks.hooks.PreToolUse[0].hooks?.[0]
    expect(hook?.type).toBe('command')
    const command = hook?.command ?? ''
    expect(command).toContain('${CLAUDE_PLUGIN_ROOT}')
    expect(command).toContain(`hooks/${HOOK_FILENAME}`)
    expect(command).toMatch(/^node /)
  })

  it('bundled hook is byte-identical to the shipped neat-search-nudge.mjs', () => {
    const bundled = readFileSync(path.join(PLUGIN_DIR, 'hooks', HOOK_FILENAME))
    const shipped = readFileSync(path.join(SKILL_DIR, 'hooks', HOOK_FILENAME))
    expect(bundled.equals(shipped)).toBe(true)
  })

  it('plugin.json declares the plugin name "neat" with a semver version', () => {
    const manifest = readJson<{ name?: string; version?: string }>(
      path.join(PLUGIN_DIR, '.claude-plugin/plugin.json'),
    )
    expect(manifest.name).toBe('neat')
    // Version tracks the release train but is documented as independent of the
    // npm lockstep (ADR-159 / publish-system.md), so we only assert it's semver.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('skills/graph-first/SKILL.md has YAML frontmatter with a name', () => {
    const raw = readFileSync(path.join(PLUGIN_DIR, 'skills/graph-first/SKILL.md'), 'utf8')
    const m = raw.match(/^---\n([\s\S]*?)\n---/)
    expect(m, 'SKILL.md is missing YAML frontmatter').not.toBeNull()
    expect(m?.[1]).toMatch(/^name:\s*graph-first\s*$/m)
    expect(m?.[1]).toMatch(/^description:\s*\S/m)
  })

  it('marketplace.json lists the neat plugin sourced from ./plugin', () => {
    const market = readJson<{
      plugins?: Array<{ name?: string; source?: string; description?: string }>
    }>(path.join(REPO_ROOT, '.claude-plugin/marketplace.json'))
    const entry = (market.plugins ?? []).find((p) => p.name === 'neat')
    expect(entry, 'marketplace has no plugin named "neat"').toBeDefined()
    expect(entry?.source).toBe('./plugin')
    expect(typeof entry?.description).toBe('string')
  })
})

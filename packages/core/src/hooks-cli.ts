// `neat hooks` — install the Claude Code affordances that make an agent reach
// for NEAT's graph before it grep-scans a repo.
//
// Two things ship here, and they cover different audiences:
//
//   1. A PreToolUse search-nudge hook. When the agent calls Grep/Glob (or a
//      Bash grep|rg|find), Claude Code runs the hook, which injects a note
//      steering the agent to NEAT's MCP tools first. It is a gentle nudge —
//      the search still runs. This is a Claude-Code-specific affordance.
//
//   2. Agent-agnostic graph-first guidance (GRAPH_FIRST.md). A markdown block
//      a user pastes into CLAUDE.md / AGENTS.md / .cursorrules so an agent on
//      any harness — not just Claude Code — knows to query the graph first.
//
// Both artifacts live in @neat.is/claude-skill and are read from there at run
// time. `--apply` copies the hook script to a stable ~/.neat/hooks/ path and
// merges a PreToolUse entry into ~/.claude/settings.json without disturbing a
// user's existing hooks. It is idempotent — re-running refreshes the path and
// never double-registers.
//
// This is a config command family (like `neat connector`), not a query verb,
// so it stays off the ADR-050 locked allowlist and parses its own argv.

import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const HOOK_FILENAME = 'neat-search-nudge.mjs'
export const GUIDE_FILENAME = 'GRAPH_FIRST.md'
// The materialised guide gets a lowercased name so it sits tidily beside the
// other ~/.neat state; the package copy keeps the SCREAMING doc name.
export const GUIDE_INSTALL_NAME = 'neat-graph-first.md'
// One matcher covers both dedicated search tools and Bash; the hook self-filters
// Bash down to grep-family commands, so a broad Bash match is a cheap no-op.
export const HOOK_MATCHER = 'Grep|Glob|Bash'

// Same dual-format base-dir idiom banner.ts uses: __dirname in the CJS build,
// import.meta.url in the ESM one (tsup emits both).
function moduleDir(): string {
  return typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url))
}

// Locate a file shipped in @neat.is/claude-skill. The @neat.is/ scope directory
// mirrors the packages/ layout, so a fixed `../../claude-skill` walk lands in
// both the published install (node_modules/@neat.is/{core,claude-skill}/…) and
// the monorepo (packages/{core,claude-skill}/…). The extra candidates are
// belt-and-suspenders for unusual dist depths.
async function readSkillAsset(rel: string): Promise<string> {
  const here = moduleDir()
  const candidates = [
    path.resolve(here, '../../claude-skill', rel),
    path.resolve(here, '../../../claude-skill', rel),
    path.resolve(here, '../claude-skill', rel),
  ]
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, 'utf8')
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `neat hooks: could not find @neat.is/claude-skill/${rel} — is the package installed?`,
  )
}

// ~/.neat, overridable via NEAT_HOME for tests (matches registry.ts).
function neatHome(): string {
  const override = process.env.NEAT_HOME
  if (override && override.length > 0) return path.resolve(override)
  return path.join(os.homedir(), '.neat')
}

// Claude Code's user-level settings file — where hooks live (distinct from
// ~/.claude.json, which holds MCP servers; `neat skill` owns that one).
// Overridable via NEAT_CLAUDE_SETTINGS so tests never touch the real file.
function claudeSettingsPath(): string {
  const override = process.env.NEAT_CLAUDE_SETTINGS
  if (override && override.length > 0) return path.resolve(override)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
  return path.join(home, '.claude', 'settings.json')
}

function installedHookPath(): string {
  return path.join(neatHome(), 'hooks', HOOK_FILENAME)
}

interface PreToolUseEntry {
  matcher?: string
  hooks?: Array<{ type?: string; command?: string }>
}

// True when this settings entry is our search-nudge — keyed on the script
// filename in the command, so a user who moved the file still gets refreshed
// rather than duplicated.
function isNeatSearchEntry(entry: PreToolUseEntry): boolean {
  return (entry.hooks ?? []).some(
    (h) => typeof h.command === 'string' && h.command.includes(HOOK_FILENAME),
  )
}

function neatHookEntry(command: string): PreToolUseEntry {
  return { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command }] }
}

// The shell command Claude Code runs. Quoted so a home dir with spaces works.
function hookCommand(scriptPath: string): string {
  return `node "${scriptPath}"`
}

export interface HooksOptions {
  apply: boolean
  printHook: boolean
  printGuide: boolean
  printSettings: boolean
}

export async function runHooks(opts: HooksOptions): Promise<{ exitCode: number }> {
  if (opts.printHook) {
    process.stdout.write(await readSkillAsset(`hooks/${HOOK_FILENAME}`))
    return { exitCode: 0 }
  }

  if (opts.printGuide) {
    process.stdout.write(await readSkillAsset(GUIDE_FILENAME))
    return { exitCode: 0 }
  }

  if (opts.printSettings) {
    // Show the block a manual installer would paste, pointing at the path
    // `--apply` would materialise.
    const block = {
      hooks: { PreToolUse: [neatHookEntry(hookCommand(installedHookPath()))] },
    }
    process.stdout.write(JSON.stringify(block, null, 2) + '\n')
    return { exitCode: 0 }
  }

  if (opts.apply) {
    const hookScript = await readSkillAsset(`hooks/${HOOK_FILENAME}`)
    const guide = await readSkillAsset(GUIDE_FILENAME)

    // 1. Materialise the hook script to a stable, upgrade-surviving path.
    const scriptPath = installedHookPath()
    await fs.mkdir(path.dirname(scriptPath), { recursive: true })
    await fs.writeFile(scriptPath, hookScript, { mode: 0o755 })

    // 2. Drop the agent-agnostic guidance beside it for easy reference.
    const guidePath = path.join(neatHome(), GUIDE_INSTALL_NAME)
    await fs.writeFile(guidePath, guide, 'utf8')

    // 3. Merge the PreToolUse entry into ~/.claude/settings.json, leaving any
    //    hooks the user wired by hand in place.
    const settingsFile = claudeSettingsPath()
    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(
          `neat hooks: failed to read ${settingsFile} — ${(err as Error).message}`,
        )
        return { exitCode: 1 }
      }
    }

    const hooks = (settings.hooks ?? {}) as Record<string, unknown>
    const preToolUse = Array.isArray(hooks.PreToolUse)
      ? [...(hooks.PreToolUse as PreToolUseEntry[])]
      : []

    const command = hookCommand(scriptPath)
    const existingIdx = preToolUse.findIndex(isNeatSearchEntry)
    if (existingIdx >= 0) {
      preToolUse[existingIdx] = neatHookEntry(command)
    } else {
      preToolUse.push(neatHookEntry(command))
    }

    const merged = {
      ...settings,
      hooks: { ...hooks, PreToolUse: preToolUse },
    }
    await fs.mkdir(path.dirname(settingsFile), { recursive: true })
    await fs.writeFile(settingsFile, JSON.stringify(merged, null, 2) + '\n', 'utf8')

    console.log(`neat hooks: installed the search-nudge hook`)
    console.log(`  script:   ${scriptPath}`)
    console.log(`  settings: ${settingsFile} (PreToolUse → ${HOOK_MATCHER})`)
    console.log(`  guidance: ${guidePath}`)
    console.log('')
    console.log('restart Claude Code to load the hook. On a Grep/Glob or a Bash grep,')
    console.log('your agent will now be nudged to query NEAT first.')
    console.log('')
    console.log('The hook is Claude-Code-specific. For agents on other harnesses, paste')
    console.log(`the guidance above into your project instructions (CLAUDE.md / AGENTS.md).`)
    return { exitCode: 0 }
  }

  usage()
  return { exitCode: 0 }
}

function usage(): void {
  console.log('neat hooks — wire NEAT into your agent so it queries the graph before grepping')
  console.log('')
  console.log('  --apply          install the Claude Code search-nudge hook and write the')
  console.log('                   graph-first guidance to ~/.neat/, merging into')
  console.log('                   ~/.claude/settings.json without touching your other hooks')
  console.log('  --print-hook     print the hook script to stdout')
  console.log('  --print-guide    print the agent-agnostic graph-first guidance to stdout')
  console.log('  --print-settings print the settings.json PreToolUse block --apply would add')
  console.log('')
  console.log('The hook is a gentle, non-blocking nudge — searches still run. It is')
  console.log('Claude-Code-specific; other harnesses get the same steer from the guidance.')
}

// Parse this command family's own argv and dispatch. Mirrors runConnectorCommand
// — a config command, not a locked query verb.
export async function runHooksCommand(args: string[]): Promise<number> {
  const opts: HooksOptions = {
    apply: false,
    printHook: false,
    printGuide: false,
    printSettings: false,
  }
  for (const arg of args) {
    switch (arg) {
      case '--apply':
        opts.apply = true
        break
      case '--print-hook':
        opts.printHook = true
        break
      case '--print-guide':
        opts.printGuide = true
        break
      case '--print-settings':
        opts.printSettings = true
        break
      case '-h':
      case '--help':
        usage()
        return 0
      default:
        console.error(`neat hooks: unknown flag "${arg}"`)
        usage()
        return 2
    }
  }
  try {
    const { exitCode } = await runHooks(opts)
    return exitCode
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }
}

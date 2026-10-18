// `neat claude` — make the investigate-first directive always-on for Claude Code by
// writing a `## neat` section into the project's local CLAUDE.md (ADR-198).
//
// This mirrors `graphify claude install`: no manual trigger, no slash command —
// CLAUDE.md is loaded on every session, so the directive is in front of the
// agent from the first turn. It is the third leg of the enforcer:
//
//   1. `neat ask` gives the graph a plain-language door (lower friction than grep).
//   2. GRAPH_FIRST.md turns the guidance imperative.
//   3. `neat claude install` injects that imperative into the always-on CLAUDE.md.
//
// A config command family (like `neat hooks` / `neat codex`), not a query verb,
// so it stays off the ADR-050 locked allowlist and parses its own argv.
// Idempotent: `install` appends the `## neat` section or replaces the one
// already there, never duplicating; `uninstall` removes it. A re-run of
// `install` writes byte-identical content.

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { applyNeatHooks } from './hooks-cli.js'

export const NEAT_SECTION_HEADING = '## neat'

// `neat claude install` wires NEAT's hooks by default (ADR-260/261, chosen in-session
// 2026-10-18) — a push surface nobody has on is not shipped. Flip this one constant to
// make hook-wiring opt-in; `--no-hooks` opts out per-run either way.
const HOOKS_WIRED_BY_DEFAULT = true

// The PROJECT's Claude Code settings (./.claude/settings.json), where the hooks are
// wired so they travel with the repo like the `## neat` section — and a per-attempt
// CLAUDE_CONFIG_DIR still reads them. Overridable via NEAT_CLAUDE_PROJECT_SETTINGS.
function projectSettingsPath(): string {
  const override = process.env.NEAT_CLAUDE_PROJECT_SETTINGS
  if (override && override.length > 0) return path.resolve(override)
  return path.join(process.cwd(), '.claude', 'settings.json')
}

// The investigate-first directive. Pointed at `neat ask` — the one door that fronts
// the whole tool surface — so the agent never has to know which structured tool
// or which exact node id to reach for. Kept tight and imperative.
export const NEAT_DIRECTIVE_BODY = `Anything failing, slow, or crashing: call \`investigate\` first — give it the service, the symptom, or a node id, before kubectl, logs, Read, or Grep. It returns the composed incident in one call: the cause with its provenance, the blast radius, and the fix locus.

This project has NEAT wired in. NEAT does the investigation for you: it keeps a
live, fused semantic graph of the system — code and runtime behaviour in one model,
every fact tagged with its provenance (EXTRACTED / OBSERVED / INFERRED / STALE) and
a confidence — so you can spend your effort on the code instead of reconstructing
how the system works.

For ANY question about this system's behaviour, dependencies, failures, root cause,
or blast radius, ask NEAT FIRST — before Read, Grep, Glob, or Bash. Use the \`ask\`
MCP tool (\`mcp__neat__ask\`) when NEAT's MCP server is wired in, or the CLI:

    neat ask "why is checkout failing?"
    neat ask "what breaks if I change the orders table?"
    neat ask "what does the payments service depend on at runtime?"

\`ask\` resolves your question to graph nodes and routes it to the right traversal,
returning one compact, provenance-tagged answer — you do not need an exact node id.

When something is failing, \`investigate\` is the one call — give it the service or
the symptom and it composes the incident work order: the recorded failure with its
deploy/env context, the likely cause chain, the blast radius, and where code and
production disagree, the same card NEAT pushes when it detects a failure.
\`get_incident_card\` composes it from an exact node id; \`get_incident_history\` and
\`get_root_cause\` return the parts on their own. Use \`expand\` and \`relate\` to
confirm the cause. Before a change, \`get_blast_radius\`
and \`check_policies\` show what it reaches and the rules that govern it, and
\`get_divergences\` shows where code and production disagree.

Trust a result by its provenance and stop when the fault is localized — the failing
node and what is wrong with it. Match one query to the symptom instead of re-running
the same one or sweeping every tool; a provenance-tagged answer is the answer, not a
cue to re-confirm it by reading source.

Fall back to Read/Grep for what the graph does not model — comments, string literals,
config minutiae, or a repo with no graph yet. If NEAT errors, the daemon may be down
(\`neat list\`) — start it with \`neat up\`, then retry.`

// The full section, heading included. One trailing newline so it sits cleanly
// between other content.
export function neatSection(): string {
  return `${NEAT_SECTION_HEADING}\n\n${NEAT_DIRECTIVE_BODY}\n`
}

// CLAUDE.md at the project root (cwd). Overridable via NEAT_CLAUDE_MD so tests
// never touch a real file.
export function claudeMdPath(): string {
  const override = process.env.NEAT_CLAUDE_MD
  if (override && override.length > 0) return path.resolve(override)
  return path.join(process.cwd(), 'CLAUDE.md')
}

// Split existing CLAUDE.md content around NEAT's `## neat` section. The section
// runs from its heading to the next level-2 (`## `) heading or end of file, so
// removing/replacing it leaves every other section byte-intact. Returns the
// text before and after the section (each already newline-trimmed at the seam),
// and whether a section was present.
interface Split {
  before: string
  after: string
  found: boolean
}

function splitAroundSection(raw: string): Split {
  const lines = raw.split('\n')
  // A heading line that is exactly `## neat` (allowing trailing whitespace).
  const startIdx = lines.findIndex((l) => l.replace(/\s+$/, '') === NEAT_SECTION_HEADING)
  if (startIdx === -1) {
    // Trim the trailing newline(s) so appending the section adds exactly one
    // blank-line gap — the same seam the found case produces, so a first install
    // and a re-install land byte-identical.
    return { before: raw.replace(/\n*$/, ''), after: '', found: false }
  }
  // The section ends at the next level-2+ heading (`## ` … but not our own line)
  // or the end of the file.
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i] ?? '')) {
      endIdx = i
      break
    }
  }
  const before = lines.slice(0, startIdx).join('\n').replace(/\n*$/, '')
  const after = lines.slice(endIdx).join('\n').replace(/^\n*/, '')
  return { before, after, found: true }
}

// Compose the final file text: NEAT's section, with the user's own content (the
// part before and after the old section) preserved around it. Ends in exactly
// one trailing newline.
function compose(before: string, after: string): string {
  const parts: string[] = []
  if (before.length > 0) parts.push(before)
  parts.push(neatSection().replace(/\n+$/, ''))
  if (after.length > 0) parts.push(after)
  return parts.join('\n\n').replace(/\n*$/, '') + '\n'
}

export interface ClaudeResult {
  exitCode: number
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

// Wires the MCP server the directive names into the agent's config and returns a
// line saying where; injected by cli.ts, which owns that writer (ADR-259, #1397).
type WireMcp = () => Promise<string>

async function runInstall(wireMcp?: WireMcp, skipHooks = false): Promise<ClaudeResult> {
  const file = claudeMdPath()
  const raw = (await readIfExists(file)) ?? ''
  const { before, after, found } = splitAroundSection(raw)
  const next = compose(before, after)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, next, 'utf8')
  const verb = raw.length === 0 ? 'created' : found ? 'refreshed' : 'added'
  console.log(`neat claude: ${verb} the \`${NEAT_SECTION_HEADING}\` section in ${file}`)
  if (wireMcp) {
    try {
      console.log(`neat claude: ${await wireMcp()}`)
    } catch (err) {
      console.error(`neat claude: could not wire the MCP server — ${(err as Error).message}`)
      console.error('Run `npx neat.is skill --apply` to wire it by hand.')
      return { exitCode: 1 }
    }
  } else {
    console.log('Wire the MCP tools the directive names: `npx neat.is skill --apply`.')
  }
  // Wire the hooks so NEAT pushes a live incident at session start and speaks up on a
  // shell probe (ADR-260/261). Default-on — a push surface nobody has on is not
  // shipped; `--no-hooks` opts out. Non-fatal: the directive + MCP are installed
  // regardless, so a hook-wiring failure never fails the install.
  if (!skipHooks) {
    try {
      const { settingsFile } = await applyNeatHooks(projectSettingsPath())
      console.log(
        `neat claude: wired the search-nudge + session-incident hooks into ${settingsFile} (re-run with --no-hooks to skip)`,
      )
    } catch (err) {
      console.error(`neat claude: could not wire hooks — ${(err as Error).message}`)
    }
  } else {
    console.log('neat claude: skipped hook wiring (--no-hooks).')
  }
  console.log('Your agent will now reach for `investigate`/`neat ask` before Read/Grep/Bash.')
  console.log('Restart the session (or reload CLAUDE.md) to pick it up.')
  return { exitCode: 0 }
}

async function runUninstall(): Promise<ClaudeResult> {
  const file = claudeMdPath()
  const raw = await readIfExists(file)
  if (raw === null) {
    console.log(`neat claude: no CLAUDE.md at ${file} — nothing to remove.`)
    return { exitCode: 0 }
  }
  const { before, after, found } = splitAroundSection(raw)
  if (!found) {
    console.log(`neat claude: no \`${NEAT_SECTION_HEADING}\` section in ${file} — nothing to remove.`)
    return { exitCode: 0 }
  }
  const remaining = [before, after].filter((s) => s.length > 0).join('\n\n')
  const next = remaining.length > 0 ? remaining.replace(/\n*$/, '') + '\n' : ''
  await fs.writeFile(file, next, 'utf8')
  console.log(`neat claude: removed the \`${NEAT_SECTION_HEADING}\` section from ${file}.`)
  return { exitCode: 0 }
}

function usage(): void {
  console.log('neat claude — make the query-first directive always-on in Claude Code')
  console.log('')
  console.log('  install     write (or refresh) a `## neat` section in ./CLAUDE.md and wire')
  console.log('              NEAT\'s hooks into ./.claude/settings.json (--no-hooks to skip)')
  console.log('  uninstall   remove the `## neat` section from ./CLAUDE.md')
  console.log('  print       print the directive block to stdout (for a manual paste)')
  console.log('')
  console.log('Idempotent: re-running install replaces its own section + entries, never')
  console.log('duplicates them. Target file overridable via NEAT_CLAUDE_MD.')
}

// Parse this command family's own argv and dispatch. Mirrors runHooksCommand.
export async function runClaudeCommand(args: string[], wireMcp?: WireMcp): Promise<number> {
  const sub = args[0]
  if (sub === '-h' || sub === '--help' || sub === undefined) {
    usage()
    return sub === undefined ? 2 : 0
  }
  // --no-hooks opts out of the default hook wiring; HOOKS_WIRED_BY_DEFAULT is the
  // one-constant reversal if the default itself should change.
  const skipHooks = args.includes('--no-hooks') || !HOOKS_WIRED_BY_DEFAULT
  try {
    switch (sub) {
      case 'install':
        return (await runInstall(wireMcp, skipHooks)).exitCode
      case 'uninstall':
        return (await runUninstall()).exitCode
      case 'print':
        process.stdout.write(neatSection())
        return 0
      default:
        console.error(`neat claude: unknown subcommand "${sub}"`)
        usage()
        return 2
    }
  } catch (err) {
    console.error(`neat claude: ${(err as Error).message}`)
    return 1
  }
}

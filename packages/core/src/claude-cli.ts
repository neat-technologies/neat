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

export const NEAT_SECTION_HEADING = '## neat'

// The investigate-first directive. Pointed at `neat ask` — the one door that fronts
// the whole tool surface — so the agent never has to know which structured tool
// or which exact node id to reach for. Kept tight and imperative.
export const NEAT_DIRECTIVE_BODY = `This project has NEAT wired in. NEAT does the investigation for you: it keeps a
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

When something is failing, query the incident: \`get_incident_history\` and
\`get_root_cause\` on the service, file, or symbol return the recorded errors with
their deploy/env context and the likely cause chain. \`get_incident_card\` composes
these into one work order — one view of the incident, not a separate truth. Use
\`expand\` and \`relate\` to confirm the cause. Before a change, \`get_blast_radius\`
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

async function runInstall(wireMcp?: WireMcp): Promise<ClaudeResult> {
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
  console.log('Your agent will now reach for `neat ask` before Read/Grep/Bash. Restart the')
  console.log('session (or reload CLAUDE.md) to pick it up.')
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
  console.log('  install     write (or refresh) a `## neat` section in ./CLAUDE.md so your')
  console.log('              agent reaches for `neat ask` before Read/Grep/Bash')
  console.log('  uninstall   remove the `## neat` section from ./CLAUDE.md')
  console.log('  print       print the directive block to stdout (for a manual paste)')
  console.log('')
  console.log('Idempotent: re-running install replaces its own section, never duplicates it.')
  console.log('Target file overridable via NEAT_CLAUDE_MD.')
}

// Parse this command family's own argv and dispatch. Mirrors runHooksCommand.
export async function runClaudeCommand(args: string[], wireMcp?: WireMcp): Promise<number> {
  const sub = args[0]
  if (sub === '-h' || sub === '--help' || sub === undefined) {
    usage()
    return sub === undefined ? 2 : 0
  }
  try {
    switch (sub) {
      case 'install':
        return (await runInstall(wireMcp)).exitCode
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

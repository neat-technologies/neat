// `neat claude` — make the query-first directive always-on for Claude Code by
// writing a `## neat` section into the project's local CLAUDE.md (ADR-196).
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

// The query-first directive. Pointed at `neat ask` — the one door that fronts
// the whole tool surface — so the agent never has to know which structured tool
// or which exact node id to reach for. Kept tight and imperative.
export const NEAT_DIRECTIVE_BODY = `This project has NEAT wired in: a live, fused semantic graph of the system —
code and runtime behaviour (OpenTelemetry) in one model, every fact tagged with
its provenance (EXTRACTED / OBSERVED / INFERRED / STALE) and a confidence.

For ANY question about this system's behaviour, dependencies, failures, root
cause, or blast radius, call \`neat ask\` FIRST — before Read, Grep, Glob, or Bash:

    neat ask "why is checkout failing?"
    neat ask "what breaks if I change the orders table?"
    neat ask "what does the payments service depend on at runtime?"

\`ask\` resolves your question to graph nodes and routes it to the right traversal
— root cause, dependencies, observed runtime calls, incidents, divergences,
blast radius — and returns one compact, provenance-tagged answer. The same door
is the \`ask\` MCP tool (\`mcp__neat__ask\`) when NEAT's MCP server is wired in.

The graph is live and fused: it is faster and more accurate than scanning files,
and it can tell you what the system actually does at runtime, not only what the
source declares. Fall back to Read/Grep only when the graph does not have what
you need — comments, string literals, config minutiae. Ask the graph first,
then scan.

If \`neat ask\` errors, the daemon may not be running (\`neat list\`) — start it
with \`neat <path>\`, then re-ask.`

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

async function runInstall(): Promise<ClaudeResult> {
  const file = claudeMdPath()
  const raw = (await readIfExists(file)) ?? ''
  const { before, after, found } = splitAroundSection(raw)
  const next = compose(before, after)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, next, 'utf8')
  const verb = raw.length === 0 ? 'created' : found ? 'refreshed' : 'added'
  console.log(`neat claude: ${verb} the \`${NEAT_SECTION_HEADING}\` section in ${file}`)
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
export async function runClaudeCommand(args: string[]): Promise<number> {
  const sub = args[0]
  if (sub === '-h' || sub === '--help' || sub === undefined) {
    usage()
    return sub === undefined ? 2 : 0
  }
  try {
    switch (sub) {
      case 'install':
        return (await runInstall()).exitCode
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

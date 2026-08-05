// `neat cursor` / `neat devin` — one-command install of NEAT into the two
// VS Code-family MCP clients that still need it wired by hand.
//
// NEAT already ships a one-install Claude Code plugin (ADR-159) and the
// à-la-carte `neat skill` / `neat hooks` commands. Cursor and Devin Desktop's
// Cascade agent read the same MCP protocol but keep their config in their own
// files, so a Claude Code
// user's setup does nothing for them. These two verbs close that: each writes
// NEAT's MCP server into the client's own `mcpServers` config and drops the
// agent-agnostic graph-first guidance (GRAPH_FIRST.md, the same block `neat
// hooks` hands out) into the client's rules file.
//
// The shape mirrors the precedent exactly — plan by default, `--apply` to write,
// idempotent, additive (never clobbers a server or rule the user set by hand).
// Two verbs, one implementation: a client descriptor carries the only two things
// that differ — where the MCP config lives and what the rules file is called.
//
// Config paths were verified against the clients' own docs (Aug 2026):
//   Cursor   MCP: ~/.cursor/mcp.json (project: .cursor/mcp.json), top-level
//            `mcpServers` — https://docs.cursor.com/context/mcp
//   Devin    MCP: ~/.codeium/windsurf/mcp_config.json — Devin Desktop's Cascade
//            agent (Cognition's successor to Windsurf) kept the legacy Codeium
//            path — top-level `mcpServers` — https://docs.devin.ai/desktop/cascade/mcp
// Both are stdio servers keyed by name under `mcpServers`, same shape the MCP
// protocol standardized and the same one `neat skill` writes for Claude Code.
//
// This is a config command family (like `neat connector` / `neat hooks`), not a
// locked ADR-050 query verb, so it parses its own argv.

import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { readSkillAsset, GUIDE_FILENAME } from './hooks-cli.js'

// The MCP server entry every client gets. `npx -y @neat.is/mcp` is NEAT's
// stdio MCP server; it defaults to the local daemon at http://localhost:8080
// (override with NEAT_CORE_URL). Minimal on purpose — this is exactly the
// object the clients' docs show for an stdio server.
export const NEAT_MCP_SERVER = {
  command: 'npx',
  args: ['-y', '@neat.is/mcp'],
} as const

// Marker pair that fences NEAT's block inside the rules file, so a re-run
// replaces only our block and leaves everything the user wrote untouched.
export const GRAPH_FIRST_MARKER_OPEN = '<!-- neat:graph-first -->'
export const GRAPH_FIRST_MARKER_CLOSE = '<!-- /neat:graph-first -->'

export interface EditorClient {
  id: 'cursor' | 'devin'
  label: string
  docsUrl: string
  // Absolute path to the client's user-level MCP config JSON. Env override so
  // tests never touch the real file (mirrors NEAT_CLAUDE_CONFIG for `skill`).
  mcpConfigPath: () => string
  // The rules file NEAT's guidance lands in, at the project root.
  rulesFileName: string
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
}

export const CURSOR_CLIENT: EditorClient = {
  id: 'cursor',
  label: 'Cursor',
  docsUrl: 'https://docs.cursor.com/context/mcp',
  mcpConfigPath: () => {
    const override = process.env.NEAT_CURSOR_CONFIG
    if (override && override.length > 0) return path.resolve(override)
    return path.join(homeDir(), '.cursor', 'mcp.json')
  },
  // Cursor still reads a single `.cursorrules` at the project root (the modern
  // `.cursor/rules/*.mdc` split is one-rule-per-file with frontmatter — a worse
  // fit for a marker-fenced block). GRAPH_FIRST.md names this file directly.
  rulesFileName: '.cursorrules',
}

// Devin Desktop is Cognition's successor to Windsurf; its Cascade agent reads
// MCP servers from the unchanged legacy Codeium path (verified Aug 2026 against
// docs.devin.ai/desktop/cascade/mcp). The MCP config is the load-bearing,
// verified half. The rules file is the legacy `.windsurfrules` the Cascade agent
// inherited from Windsurf — Devin's current docs don't re-document an always-on
// rules file, so this half is best-effort: additive, marker-fenced, harmless if
// a given Cascade build ignores it.
export const DEVIN_CLIENT: EditorClient = {
  id: 'devin',
  label: 'Devin Desktop (Cascade)',
  docsUrl: 'https://docs.devin.ai/desktop/cascade/mcp',
  mcpConfigPath: () => {
    const override = process.env.NEAT_DEVIN_CONFIG
    if (override && override.length > 0) return path.resolve(override)
    return path.join(homeDir(), '.codeium', 'windsurf', 'mcp_config.json')
  },
  rulesFileName: '.windsurfrules',
}

interface McpConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

// Merge NEAT's server into the client's `mcpServers` object, preserving every
// other server and top-level key. `changed` is false when the entry already
// matches, so a re-run is a clean no-op.
function mergeMcpConfig(existing: McpConfig): { merged: McpConfig; changed: boolean } {
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>
  const already = JSON.stringify(servers.neat) === JSON.stringify(NEAT_MCP_SERVER)
  const merged: McpConfig = {
    ...existing,
    mcpServers: { ...servers, neat: NEAT_MCP_SERVER },
  }
  return { merged, changed: !already }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The fenced block, guide content verbatim between the markers.
function buildGuidanceBlock(guide: string): string {
  return `${GRAPH_FIRST_MARKER_OPEN}\n${guide.trim()}\n${GRAPH_FIRST_MARKER_CLOSE}\n`
}

// Splice NEAT's block into the rules file: replace an existing fenced block in
// place, otherwise append it after the user's content. Anything outside the
// markers is preserved exactly.
function mergeRulesFile(existing: string, block: string): string {
  const region = new RegExp(
    `${escapeRegExp(GRAPH_FIRST_MARKER_OPEN)}[\\s\\S]*?${escapeRegExp(GRAPH_FIRST_MARKER_CLOSE)}\\n?`,
  )
  if (region.test(existing)) return existing.replace(region, block)
  if (existing.trim().length === 0) return block
  return `${existing.replace(/\s+$/, '')}\n\n${block}`
}

export interface EditorInstallOptions {
  apply: boolean
  // Where the rules file lands. Defaults to the caller's cwd in the CLI; tests
  // pass a temp directory.
  projectDir: string
}

export async function runEditorInstall(
  client: EditorClient,
  opts: EditorInstallOptions,
): Promise<{ exitCode: number }> {
  const mcpPath = client.mcpConfigPath()
  const rulesPath = path.join(opts.projectDir, client.rulesFileName)

  // ── Phase 1: read + validate everything before writing anything ──────────
  // A malformed existing MCP config is a hard stop with nothing written — no
  // partial state, and the operator is told exactly which file to fix.
  let existingMcp: McpConfig = {}
  try {
    existingMcp = JSON.parse(await fs.readFile(mcpPath, 'utf8')) as McpConfig
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      existingMcp = {}
    } else if (err instanceof SyntaxError) {
      console.error(
        `neat ${client.id}: ${mcpPath} is not valid JSON — ${e.message}. ` +
          `Fix it (or move it aside) and re-run; nothing was written.`,
      )
      return { exitCode: 1 }
    } else {
      console.error(`neat ${client.id}: failed to read ${mcpPath} — ${e.message}`)
      return { exitCode: 1 }
    }
  }

  let existingRules = ''
  try {
    existingRules = await fs.readFile(rulesPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`neat ${client.id}: failed to read ${rulesPath} — ${(err as Error).message}`)
      return { exitCode: 1 }
    }
  }

  const guide = await readSkillAsset(GUIDE_FILENAME)
  const block = buildGuidanceBlock(guide)
  const { merged, changed: mcpChanged } = mergeMcpConfig(existingMcp)
  const mcpJson = JSON.stringify(merged, null, 2) + '\n'
  const newRules = mergeRulesFile(existingRules, block)
  const rulesChanged = newRules !== existingRules

  // ── Plan mode (default): show what would change, write nothing ───────────
  if (!opts.apply) {
    console.log(`neat ${client.id} — wire NEAT into ${client.label} (plan; nothing written)`)
    console.log('')
    console.log(`MCP server → ${mcpPath}`)
    console.log(
      mcpChanged
        ? '  would add mcpServers.neat:'
        : '  mcpServers.neat already present and current — no change:',
    )
    console.log(indent(JSON.stringify({ neat: NEAT_MCP_SERVER }, null, 2)))
    console.log('')
    console.log(`Graph-first guidance → ${rulesPath}`)
    console.log(
      rulesChanged
        ? existingRules.includes(GRAPH_FIRST_MARKER_OPEN)
          ? '  would refresh the neat:graph-first block:'
          : '  would add the neat:graph-first block:'
        : '  neat:graph-first block already present and current — no change.',
    )
    if (rulesChanged) console.log(indent(block.trimEnd()))
    console.log('')
    console.log(`Re-run with --apply to write both files. Existing servers and rules are kept.`)
    return { exitCode: 0 }
  }

  // ── Apply mode: write both files ─────────────────────────────────────────
  await fs.mkdir(path.dirname(mcpPath), { recursive: true })
  await fs.writeFile(mcpPath, mcpJson, 'utf8')
  await fs.mkdir(path.dirname(rulesPath), { recursive: true })
  await fs.writeFile(rulesPath, newRules, 'utf8')

  console.log(`neat ${client.id}: wired NEAT into ${client.label}`)
  console.log(`  MCP server: ${mcpPath} (mcpServers.neat → npx -y @neat.is/mcp)`)
  console.log(`  guidance:   ${rulesPath} (neat:graph-first block)`)
  console.log('')
  console.log(`restart ${client.label} to pick up the MCP server. Point it at a non-default`)
  console.log(`daemon by setting NEAT_CORE_URL in the neat server's env in that config.`)
  return { exitCode: 0 }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `    ${line}` : line))
    .join('\n')
}

function usage(client: EditorClient): void {
  console.log(`neat ${client.id} — install NEAT's MCP server + graph-first guidance into ${client.label}`)
  console.log('')
  console.log('  --apply   write the MCP config and the rules file (default: plan only)')
  console.log('')
  console.log('Writes NEAT\'s stdio MCP server (npx -y @neat.is/mcp) into')
  console.log(`  ${client.mcpConfigPath()}`)
  console.log(`and the graph-first guidance block into ./${client.rulesFileName}, both`)
  console.log('additively — existing servers and rules are preserved, a re-run is a no-op.')
  console.log('')
  console.log(`See ${client.docsUrl} for ${client.label}'s MCP config format.`)
}

// Parse this command family's own argv and dispatch. Mirrors runHooksCommand.
export async function runEditorCommand(
  clientId: 'cursor' | 'devin',
  args: string[],
  projectDir: string = process.cwd(),
): Promise<number> {
  const client = clientId === 'cursor' ? CURSOR_CLIENT : DEVIN_CLIENT
  let apply = false
  for (const arg of args) {
    switch (arg) {
      case '--apply':
        apply = true
        break
      case '-h':
      case '--help':
        usage(client)
        return 0
      default:
        console.error(`neat ${client.id}: unknown flag "${arg}"`)
        usage(client)
        return 2
    }
  }
  try {
    const { exitCode } = await runEditorInstall(client, { apply, projectDir })
    return exitCode
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }
}

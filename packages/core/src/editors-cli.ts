// `neat cursor` / `neat devin` / `neat gemini` / `neat qwen` / `neat amazonq` /
// `neat roocode` / `neat zed` / `neat opencode` / `neat crush` — one-command
// install of NEAT's stdio MCP server into the agent clients that each read a
// standard MCP config but keep it in their own file, so a Claude Code user's
// setup does nothing for them.
//
// NEAT already ships a one-install Claude Code plugin (ADR-159), the à-la-carte
// `neat skill` / `neat hooks` commands, `neat codex`, and a VS Code / Open VSX
// extension (ADR-171). These verbs extend the same shape to the rest of the
// stdio-MCP client family (ADR-172, ADR-176): each writes NEAT's MCP server into
// the client's own config, merge-never-clobber, and — where the client has a
// single always-on rules file we can verify — drops the agent-agnostic
// graph-first guidance (GRAPH_FIRST.md, the same block `neat hooks` hands out)
// into it.
//
// The shape mirrors the precedent exactly — plan by default, `--apply` to write,
// idempotent, additive (never clobbers a server or rule the user set by hand).
// One implementation, one descriptor per client carrying the few things that
// differ: where the MCP config lives, the key the server is keyed under, the
// file format, the server object itself (most clients take the flat
// `{ command, args }`; OpenCode and Crush carry their own shape), and
// (optionally) the rules file NEAT's guidance lands in.
//
// Config surfaces were verified against the clients' own docs (Aug 2026):
//   Cursor    ~/.cursor/mcp.json, top-level `mcpServers` — docs.cursor.com/context/mcp
//   Devin     ~/.codeium/windsurf/mcp_config.json (Cascade kept the legacy
//             Codeium path), `mcpServers` — docs.devin.ai/desktop/cascade/mcp
//   Gemini    ~/.gemini/settings.json, `mcpServers` — github.com/google-gemini/gemini-cli
//   Qwen      ~/.qwen/settings.json, `mcpServers` (gemini-cli fork) —
//             qwenlm.github.io/qwen-code-docs
//   Amazon Q  ~/.aws/amazonq/mcp.json, `mcpServers` — docs.aws.amazon.com/amazonq
//   Roo Code  <project>/.roo/mcp.json, `mcpServers`, project-scoped and meant to
//             be committed — roocodeinc.github.io/Roo-Code
//   Zed       ~/.config/zed/settings.json (Windows %APPDATA%\Zed\settings.json),
//             `context_servers`, JSONC — zed.dev/docs/ai/mcp
//   OpenCode  ~/.config/opencode/opencode.json (XDG-aware), `mcp` —
//             opencode.ai/docs/mcp-servers
//   Crush     ~/.config/crush/crush.json (XDG-aware), `mcp` —
//             charmbracelet-crush.mintlify.app/configuration/mcp
// The first seven take NEAT's stdio server as the flat `{ command, args }` keyed
// by name (Zed's schema is the flat `command`-string form, verified against
// crates/settings_content). OpenCode and Crush share the `mcp` key but each
// carries its own server-object shape, so the descriptor sets `serverEntry`.
//
// This is a config command family (like `neat connector` / `neat hooks`), not a
// locked ADR-050 query verb, so it parses its own argv.

import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import * as jsonc from 'jsonc-parser'
import { readSkillAsset, GUIDE_FILENAME } from './hooks-cli.js'

// The MCP server entry every client gets. `npx -y @neat.is/mcp` is NEAT's
// stdio MCP server; it defaults to the local daemon at http://localhost:8080
// (override with NEAT_CORE_URL). Minimal on purpose — this is exactly the
// object the clients' docs show for an stdio server, Zed's flat form included.
export const NEAT_MCP_SERVER = {
  command: 'npx',
  args: ['-y', '@neat.is/mcp'],
} as const

// OpenCode's server-object shape differs from the flat form above: the command
// is an ARRAY, the server declares `type: "local"`, and it carries `enabled`
// (verified against opencode.ai/docs/mcp-servers, Aug 2026).
export const NEAT_OPENCODE_SERVER = {
  type: 'local',
  command: ['npx', '-y', '@neat.is/mcp'],
  enabled: true,
} as const

// Crush wants an explicit `type: "stdio"` alongside the string command + args
// (verified against charmbracelet-crush.mintlify.app/configuration/mcp, Aug 2026).
export const NEAT_CRUSH_SERVER = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@neat.is/mcp'],
} as const

// Marker pair that fences NEAT's block inside the rules file, so a re-run
// replaces only our block and leaves everything the user wrote untouched.
export const GRAPH_FIRST_MARKER_OPEN = '<!-- neat:graph-first -->'
export const GRAPH_FIRST_MARKER_CLOSE = '<!-- /neat:graph-first -->'

export type EditorClientId =
  | 'cursor'
  | 'devin'
  | 'gemini'
  | 'qwen'
  | 'amazonq'
  | 'roocode'
  | 'zed'
  | 'opencode'
  | 'crush'

export interface EditorClient {
  id: EditorClientId
  label: string
  docsUrl: string
  // Absolute path to the client's MCP config file. Env override so tests never
  // touch the real file (mirrors NEAT_CLAUDE_CONFIG for `skill`).
  mcpConfigPath: () => string
  // The object the server is keyed under. `mcpServers` for every client except
  // Zed, which uses `context_servers`.
  mcpContainerKey: string
  // The config file's format. `json` — parse and rewrite. `jsonc` (Zed) — edit
  // in place so the comments a fresh settings.json ships with survive.
  format: 'json' | 'jsonc'
  // The object written under `<mcpContainerKey>.neat`. Omitted for the clients
  // that take the flat `{ command, args }` shape (they inherit NEAT_MCP_SERVER);
  // OpenCode and Crush set their own shape here.
  serverEntry?: Readonly<Record<string, unknown>>
  // The single always-on rules/context file NEAT's guidance lands in, at the
  // project root. Omitted for clients whose rules surface is a directory rather
  // than one verifiable file (Amazon Q, Roo Code) — those verbs are
  // MCP-config-only.
  rulesFileName?: string
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
}

// The base directory OpenCode and Crush resolve their global config under:
// $XDG_CONFIG_HOME when set, else ~/.config — both honour the XDG spec (verified
// against their docs, Aug 2026).
function xdgConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && xdg.length > 0 ? path.resolve(xdg) : path.join(homeDir(), '.config')
}

// Read an env override, resolved to an absolute path, or undefined when unset.
function envOverride(name: string): string | undefined {
  const v = process.env[name]
  return v && v.length > 0 ? path.resolve(v) : undefined
}

export const CURSOR_CLIENT: EditorClient = {
  id: 'cursor',
  label: 'Cursor',
  docsUrl: 'https://docs.cursor.com/context/mcp',
  mcpConfigPath: () => envOverride('NEAT_CURSOR_CONFIG') ?? path.join(homeDir(), '.cursor', 'mcp.json'),
  mcpContainerKey: 'mcpServers',
  format: 'json',
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
  mcpConfigPath: () =>
    envOverride('NEAT_DEVIN_CONFIG') ?? path.join(homeDir(), '.codeium', 'windsurf', 'mcp_config.json'),
  mcpContainerKey: 'mcpServers',
  format: 'json',
  rulesFileName: '.windsurfrules',
}

// Google's Gemini CLI reads MCP servers from ~/.gemini/settings.json under
// `mcpServers`, the standard stdio shape. Its always-on context file is
// GEMINI.md at the project root (loaded every prompt), a verified single-file
// convention — so guidance lands there.
export const GEMINI_CLIENT: EditorClient = {
  id: 'gemini',
  label: 'Gemini CLI',
  docsUrl: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md',
  mcpConfigPath: () => envOverride('NEAT_GEMINI_CONFIG') ?? path.join(homeDir(), '.gemini', 'settings.json'),
  mcpContainerKey: 'mcpServers',
  format: 'json',
  rulesFileName: 'GEMINI.md',
}

// Qwen Code is a gemini-cli fork; it keeps the same settings.json + `mcpServers`
// shape at ~/.qwen/settings.json, and renames the context file to QWEN.md
// (loaded every session, verified against the Qwen Code memory docs).
export const QWEN_CLIENT: EditorClient = {
  id: 'qwen',
  label: 'Qwen Code',
  docsUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/',
  mcpConfigPath: () => envOverride('NEAT_QWEN_CONFIG') ?? path.join(homeDir(), '.qwen', 'settings.json'),
  mcpContainerKey: 'mcpServers',
  format: 'json',
  rulesFileName: 'QWEN.md',
}

// The Amazon Q Developer CLI reads MCP servers from ~/.aws/amazonq/mcp.json
// under `mcpServers` (the directory is usually absent, so apply mkdir -p's it).
// Its rules surface is a directory (.amazonq/rules/*), not a single file, so
// this verb is MCP-config-only — no guidance file.
export const AMAZONQ_CLIENT: EditorClient = {
  id: 'amazonq',
  label: 'Amazon Q Developer CLI',
  docsUrl: 'https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-mcp-configuration.html',
  mcpConfigPath: () =>
    envOverride('NEAT_AMAZONQ_CONFIG') ?? path.join(homeDir(), '.aws', 'amazonq', 'mcp.json'),
  mcpContainerKey: 'mcpServers',
  format: 'json',
}

// Roo Code's project-scoped MCP config is <project>/.roo/mcp.json under
// `mcpServers` — meant to be committed and shared with the team, which is why we
// target it rather than the OS-variant globalStorage blob its docs steer you
// away from. Its rules surface is a directory (.roo/rules/*), so MCP-config-only.
export const ROOCODE_CLIENT: EditorClient = {
  id: 'roocode',
  label: 'Roo Code',
  docsUrl: 'https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo',
  mcpConfigPath: () => envOverride('NEAT_ROOCODE_CONFIG') ?? path.join(process.cwd(), '.roo', 'mcp.json'),
  mcpContainerKey: 'mcpServers',
  format: 'json',
}

// Zed keeps MCP servers under `context_servers` in a JSONC settings.json that
// ships with `//` comments, so this one is edited in place (comments preserved)
// rather than reparsed-and-rewritten. Path is ~/.config/zed/settings.json on
// macOS/Linux and %APPDATA%\Zed\settings.json on Windows. Zed reads a `.rules`
// file at the project root (highest-priority project instruction file), so
// guidance lands there.
export const ZED_CLIENT: EditorClient = {
  id: 'zed',
  label: 'Zed',
  docsUrl: 'https://zed.dev/docs/ai/mcp',
  mcpConfigPath: () => {
    const override = envOverride('NEAT_ZED_CONFIG')
    if (override) return override
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA
      if (appData && appData.length > 0) return path.join(appData, 'Zed', 'settings.json')
    }
    return path.join(homeDir(), '.config', 'zed', 'settings.json')
  },
  mcpContainerKey: 'context_servers',
  format: 'jsonc',
  rulesFileName: '.rules',
}

// OpenCode reads MCP servers from opencode.json under the `mcp` key, but its
// server object is the array-command form: `{ type: "local", command: [...],
// enabled: true }`. Global config is ~/.config/opencode/opencode.json (XDG-aware);
// a project opencode.json is the same shape. Its always-on instructions file is
// AGENTS.md at the project root (the agent-agnostic file `neat codex` also uses),
// so guidance lands there.
export const OPENCODE_CLIENT: EditorClient = {
  id: 'opencode',
  label: 'OpenCode',
  docsUrl: 'https://opencode.ai/docs/mcp-servers/',
  mcpConfigPath: () =>
    envOverride('NEAT_OPENCODE_CONFIG') ?? path.join(xdgConfigDir(), 'opencode', 'opencode.json'),
  mcpContainerKey: 'mcp',
  format: 'json',
  serverEntry: NEAT_OPENCODE_SERVER,
  rulesFileName: 'AGENTS.md',
}

// Crush (Charmbracelet) also keys MCP servers under `mcp`, but wants an explicit
// `type: "stdio"` with a string command + args. Global config is
// ~/.config/crush/crush.json (XDG-aware); a project crush.json / .crush.json is
// the same shape. Crush reads CRUSH.md and AGENTS.md as context files; guidance
// lands in the agent-agnostic AGENTS.md.
export const CRUSH_CLIENT: EditorClient = {
  id: 'crush',
  label: 'Crush',
  docsUrl: 'https://charmbracelet-crush.mintlify.app/configuration/mcp',
  mcpConfigPath: () =>
    envOverride('NEAT_CRUSH_CONFIG') ?? path.join(xdgConfigDir(), 'crush', 'crush.json'),
  mcpContainerKey: 'mcp',
  format: 'json',
  serverEntry: NEAT_CRUSH_SERVER,
  rulesFileName: 'AGENTS.md',
}

const CLIENTS: Record<EditorClientId, EditorClient> = {
  cursor: CURSOR_CLIENT,
  devin: DEVIN_CLIENT,
  gemini: GEMINI_CLIENT,
  qwen: QWEN_CLIENT,
  amazonq: AMAZONQ_CLIENT,
  roocode: ROOCODE_CLIENT,
  zed: ZED_CLIENT,
  opencode: OPENCODE_CLIENT,
  crush: CRUSH_CLIENT,
}

interface McpConfig {
  [key: string]: unknown
}

// Merge NEAT's server into the client's container object (JSON path), preserving
// every other server and top-level key. `changed` is false when the entry
// already matches, so a re-run is a clean no-op.
function mergeJsonMcp(
  existing: McpConfig,
  containerKey: string,
  serverEntry: unknown,
): { merged: McpConfig; changed: boolean } {
  const servers = (existing[containerKey] ?? {}) as Record<string, unknown>
  const already = isDeepStrictEqual(servers.neat, serverEntry)
  const merged: McpConfig = {
    ...existing,
    [containerKey]: { ...servers, neat: serverEntry },
  }
  return { merged, changed: !already }
}

// Merge NEAT's server into a JSONC file (Zed) without disturbing the rest.
// jsonc-parser.modify computes a minimal edit that inserts only
// `<container>.neat`; applyEdits splices it in, so every comment and every other
// setting is preserved byte-for-byte. No JSON.stringify round-trip. A missing or
// empty file starts from `{}`. `changed` is false when the entry already matches.
function mergeJsoncMcp(
  raw: string,
  containerKey: string,
  serverEntry: unknown,
): { text: string; changed: boolean } {
  const base = raw.trim().length > 0 ? raw : '{}'
  const parsed = (jsonc.parse(base) ?? {}) as Record<string, unknown>
  const servers = (parsed[containerKey] ?? {}) as Record<string, unknown>
  if (isDeepStrictEqual(servers.neat, serverEntry)) {
    return { text: raw, changed: false }
  }
  const edits = jsonc.modify(base, [containerKey, 'neat'], serverEntry, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  let text = jsonc.applyEdits(base, edits)
  if (!text.endsWith('\n')) text += '\n'
  return { text, changed: text !== raw }
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

// Read the client's MCP config and compute the merged text + whether it changed,
// validating the format. Returns null after printing an error on a hard stop
// (malformed existing config, unreadable file).
async function planMcp(
  client: EditorClient,
  mcpPath: string,
): Promise<{ text: string; changed: boolean } | null> {
  const serverEntry = client.serverEntry ?? NEAT_MCP_SERVER
  let raw = ''
  try {
    raw = await fs.readFile(mcpPath, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      raw = ''
    } else {
      console.error(`neat ${client.id}: failed to read ${mcpPath} — ${e.message}`)
      return null
    }
  }

  if (client.format === 'jsonc') {
    // A fresh Zed settings.json ships with `//` comments — those are valid JSONC,
    // not an error. Only genuine syntax damage (beyond comments and trailing
    // commas) is a hard stop, so the user's file is never rewritten blindly.
    if (raw.trim().length > 0) {
      const errors: jsonc.ParseError[] = []
      jsonc.parse(raw, errors, { allowTrailingComma: true })
      if (errors.length > 0) {
        const first = errors[0]
        console.error(
          `neat ${client.id}: ${mcpPath} is not valid JSONC — ` +
            `${jsonc.printParseErrorCode(first.error)} at offset ${first.offset}. ` +
            `Fix it (or move it aside) and re-run; nothing was written.`,
        )
        return null
      }
    }
    return mergeJsoncMcp(raw, client.mcpContainerKey, serverEntry)
  }

  // JSON path.
  let existing: McpConfig = {}
  if (raw.trim().length > 0) {
    try {
      existing = JSON.parse(raw) as McpConfig
    } catch (err) {
      console.error(
        `neat ${client.id}: ${mcpPath} is not valid JSON — ${(err as Error).message}. ` +
          `Fix it (or move it aside) and re-run; nothing was written.`,
      )
      return null
    }
  }
  const { merged, changed } = mergeJsonMcp(existing, client.mcpContainerKey, serverEntry)
  return { text: JSON.stringify(merged, null, 2) + '\n', changed }
}

export async function runEditorInstall(
  client: EditorClient,
  opts: EditorInstallOptions,
): Promise<{ exitCode: number }> {
  const mcpPath = client.mcpConfigPath()
  const serverEntry = client.serverEntry ?? NEAT_MCP_SERVER
  const hasRules = typeof client.rulesFileName === 'string'
  const rulesPath = hasRules ? path.join(opts.projectDir, client.rulesFileName as string) : ''

  // ── Phase 1: read + validate everything before writing anything ──────────
  // A malformed existing MCP config is a hard stop with nothing written — no
  // partial state, and the operator is told exactly which file to fix.
  const mcp = await planMcp(client, mcpPath)
  if (mcp === null) return { exitCode: 1 }

  let existingRules = ''
  let newRules = ''
  let rulesChanged = false
  let block = ''
  if (hasRules) {
    try {
      existingRules = await fs.readFile(rulesPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`neat ${client.id}: failed to read ${rulesPath} — ${(err as Error).message}`)
        return { exitCode: 1 }
      }
    }
    const guide = await readSkillAsset(GUIDE_FILENAME)
    block = buildGuidanceBlock(guide)
    newRules = mergeRulesFile(existingRules, block)
    rulesChanged = newRules !== existingRules
  }

  // ── Plan mode (default): show what would change, write nothing ───────────
  if (!opts.apply) {
    console.log(`neat ${client.id} — wire NEAT into ${client.label} (plan; nothing written)`)
    console.log('')
    console.log(`MCP server → ${mcpPath}`)
    console.log(
      mcp.changed
        ? `  would add ${client.mcpContainerKey}.neat:`
        : `  ${client.mcpContainerKey}.neat already present and current — no change:`,
    )
    console.log(indent(JSON.stringify({ neat: serverEntry }, null, 2)))
    if (hasRules) {
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
    }
    console.log('')
    console.log(
      hasRules
        ? `Re-run with --apply to write both files. Existing servers and rules are kept.`
        : `Re-run with --apply to write the config. Existing servers are kept.`,
    )
    return { exitCode: 0 }
  }

  // ── Apply mode: write ────────────────────────────────────────────────────
  await fs.mkdir(path.dirname(mcpPath), { recursive: true })
  await fs.writeFile(mcpPath, mcp.text, 'utf8')
  if (hasRules) {
    await fs.mkdir(path.dirname(rulesPath), { recursive: true })
    await fs.writeFile(rulesPath, newRules, 'utf8')
  }

  console.log(`neat ${client.id}: wired NEAT into ${client.label}`)
  console.log(`  MCP server: ${mcpPath} (${client.mcpContainerKey}.neat → npx -y @neat.is/mcp)`)
  if (hasRules) console.log(`  guidance:   ${rulesPath} (neat:graph-first block)`)
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
  const hasRules = typeof client.rulesFileName === 'string'
  console.log(
    hasRules
      ? `neat ${client.id} — install NEAT's MCP server + graph-first guidance into ${client.label}`
      : `neat ${client.id} — install NEAT's MCP server into ${client.label}`,
  )
  console.log('')
  console.log(
    hasRules
      ? '  --apply   write the MCP config and the rules file (default: plan only)'
      : '  --apply   write the MCP config (default: plan only)',
  )
  console.log('')
  console.log("Writes NEAT's stdio MCP server (npx -y @neat.is/mcp) into")
  console.log(`  ${client.mcpConfigPath()}`)
  if (hasRules) {
    console.log(`and the graph-first guidance block into ./${client.rulesFileName}, both`)
    console.log('additively — existing servers and rules are preserved, a re-run is a no-op.')
  } else {
    console.log('additively — existing servers are preserved, a re-run is a no-op.')
  }
  console.log('')
  console.log(`See ${client.docsUrl} for ${client.label}'s MCP config format.`)
}

// Parse this command family's own argv and dispatch. Mirrors runHooksCommand.
export async function runEditorCommand(
  clientId: EditorClientId,
  args: string[],
  projectDir: string = process.cwd(),
): Promise<number> {
  const client = CLIENTS[clientId]
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

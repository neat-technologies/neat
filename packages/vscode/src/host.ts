// Host detection — which editor is this extension running inside, and does it
// honour the finalized MCP provider API?
//
// VS Code 1.101 shipped `vscode.lm.registerMcpServerDefinitionProvider` as a
// stable API. Stock VS Code (and the Copilot audience) get NEAT's MCP server
// wired through it. The VS Code forks — Cursor, Windsurf/Cascade, Kiro — reuse
// the same extension host but do not honour that API, so on a fork the
// "configure" command writes the fork's own MCP config file instead, reusing
// the merge the `neat cursor` / `neat devin` CLI verbs already perform.
//
// This module is pure: it maps `vscode.env.appName` (+ `appHost`) to a host
// verdict with no `vscode` import, so it unit-tests without a real editor.

export type ForkId = 'cursor' | 'windsurf' | 'kiro' | 'unknown'

// What the fork branch needs to wire NEAT by hand: the `neat` CLI verb that
// already knows this fork (if any), and the fallback config file to merge into
// when the CLI isn't on PATH. `configHomeSegments` are joined under the user's
// home directory. `null` means we can't safely guess a path — the command shows
// the JSON to paste instead of writing to the wrong file.
export interface ForkDescriptor {
  id: ForkId
  label: string
  // The `neat <verb> --apply` command that wires this fork, or null when NEAT
  // ships no verb for it (Kiro, unknown forks).
  cliVerb: 'cursor' | 'devin' | null
  // Path to the fork's user-level MCP config, as segments under the home dir.
  configHomeSegments: string[] | null
  // Docs URL for the fork's MCP config format, surfaced in messages.
  docsUrl: string | null
}

export type HostVerdict =
  | { kind: 'vscode' }
  | { kind: 'fork'; fork: ForkDescriptor }

const CURSOR: ForkDescriptor = {
  id: 'cursor',
  label: 'Cursor',
  cliVerb: 'cursor',
  // Cursor reads user-level MCP servers from ~/.cursor/mcp.json (top-level
  // `mcpServers`) — the same file `neat cursor` writes.
  configHomeSegments: ['.cursor', 'mcp.json'],
  docsUrl: 'https://docs.cursor.com/context/mcp',
}

const WINDSURF: ForkDescriptor = {
  id: 'windsurf',
  label: 'Windsurf / Cascade',
  // Devin Desktop's Cascade agent (Cognition's successor to Windsurf) kept the
  // legacy Codeium MCP path; `neat devin` targets exactly that file.
  cliVerb: 'devin',
  configHomeSegments: ['.codeium', 'windsurf', 'mcp_config.json'],
  docsUrl: 'https://docs.devin.ai/desktop/cascade/mcp',
}

const KIRO: ForkDescriptor = {
  id: 'kiro',
  label: 'Kiro',
  // Kiro (AWS) reads user-level MCP servers from ~/.kiro/settings/mcp.json,
  // top-level `mcpServers`. NEAT ships no CLI verb for it, so the in-extension
  // merge is the only path.
  cliVerb: null,
  configHomeSegments: ['.kiro', 'settings', 'mcp.json'],
  docsUrl: 'https://kiro.dev/docs/mcp/configuration/',
}

const UNKNOWN_FORK: ForkDescriptor = {
  id: 'unknown',
  label: 'this editor',
  cliVerb: null,
  configHomeSegments: null,
  docsUrl: null,
}

// Case-insensitive substring match against the app name. VS Code proper reports
// "Visual Studio Code" (or "… - Insiders"); the forks each report their own
// brand. We key off the brand token, not an exact string, so a build suffix
// ("Cursor Nightly") still resolves.
function normalize(appName: string | undefined): string {
  return (appName ?? '').toLowerCase()
}

// Is this genuine VS Code (or an Insiders/OSS build of it) rather than a fork?
export function isVSCodeProper(appName: string | undefined): boolean {
  const n = normalize(appName)
  // The forks all rename appName away from "Visual Studio Code"; matching the
  // full brand avoids a fork that merely contains "code" (e.g. "VSCodium" does
  // report "VSCodium", not "Visual Studio Code") slipping through as stock.
  return n.includes('visual studio code')
}

export function forkDescriptorFor(appName: string | undefined): ForkDescriptor {
  const n = normalize(appName)
  if (n.includes('cursor')) return CURSOR
  if (n.includes('windsurf') || n.includes('cascade')) return WINDSURF
  if (n.includes('kiro')) return KIRO
  return UNKNOWN_FORK
}

// The single entry point. `appHost` is reserved for a future web/remote split;
// today the decision keys off `appName`, but the parameter is kept so callers
// pass the whole `vscode.env` shape and the signature doesn't churn later.
export function detectHost(
  appName: string | undefined,
  _appHost?: string | undefined,
): HostVerdict {
  if (isVSCodeProper(appName)) return { kind: 'vscode' }
  return { kind: 'fork', fork: forkDescriptorFor(appName) }
}

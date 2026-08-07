// NEAT VS Code extension — activation entry.
//
// Two features, and it stops there (see docs/decisions.md ADR-171):
//   1. Configure the `@neat.is/mcp` server for whichever editor is running —
//      natively via the finalized MCP provider API on VS Code 1.101+, and by
//      writing the fork's own MCP config file on Cursor/Windsurf/Kiro.
//   2. A status-bar item backed by one call to the local daemon's `/health`.
//
// It renders nothing of the graph — the dashboard in `packages/web` owns that
// surface. This is the only file that imports `vscode`; the logic it drives
// lives in the pure modules beside it (host / mcp-config / health), which is
// where the unit tests point.

import * as vscode from 'vscode'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'

import { detectHost, type ForkDescriptor } from './host'
import {
  DEFAULT_DAEMON_URL,
  mergeForkMcpConfig,
  neatServerEntry,
  type McpConfigFile,
  type NeatServerEntry,
} from './mcp-config'
import {
  BASE_INTERVAL_MS,
  nextInterval,
  pollHealth,
  statusText,
  type StatusState,
} from './health'

// Must match the id in `contributes.mcpServerDefinitionProviders` in package.json.
const MCP_PROVIDER_ID = 'neat.mcpServerProvider'
const CONFIGURE_COMMAND = 'neat.configureMcp'

let statusBarItem: vscode.StatusBarItem | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
// Set once we register the native provider, so the configure command knows
// whether "configured" means "VS Code owns it" or "write the fork's file".
let nativeProviderRegistered = false

export function activate(context: vscode.ExtensionContext): void {
  const host = detectHost(vscode.env.appName, vscode.env.appHost)

  // ── Feature 1a: native MCP provider (VS Code 1.101+) ─────────────────────
  // Registered at startup (activationEvents: onStartupFinished) so the server
  // is offered as soon as the editor is ready. Guarded on the API actually
  // being present — the forks don't expose it, and older VS Code (< 1.101)
  // wouldn't either, in which case we fall through to the config-file path.
  const lm = vscode.lm as unknown as {
    registerMcpServerDefinitionProvider?: (
      id: string,
      provider: unknown,
    ) => vscode.Disposable
  }
  if (host.kind === 'vscode' && typeof lm.registerMcpServerDefinitionProvider === 'function') {
    const provider = {
      provideMcpServerDefinitions(): vscode.McpStdioServerDefinition[] {
        const entry = neatServerEntry(readDaemonUrl())
        return [
          new vscode.McpStdioServerDefinition(
            'neat',
            entry.command,
            entry.args,
            entry.env ?? {},
          ),
        ]
      },
    }
    context.subscriptions.push(
      lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider),
    )
    nativeProviderRegistered = true
  }

  // ── Feature 1b: the configure command ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(CONFIGURE_COMMAND, () => runConfigure(host)),
  )

  // ── Feature 2: daemon-health status bar ──────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.command = CONFIGURE_COMMAND
  applyStatus({ kind: 'checking' })
  statusBarItem.show()
  context.subscriptions.push(statusBarItem)

  // Poll now, then on a self-scheduling timer with backoff when down.
  void schedulePoll(0)
  context.subscriptions.push({
    dispose: () => {
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = undefined
    },
  })
}

export function deactivate(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = undefined
}

function readDaemonUrl(): string {
  const cfg = vscode.workspace.getConfiguration('neat')
  const url = cfg.get<string>('daemonUrl')
  return url && url.trim().length > 0 ? url.trim() : DEFAULT_DAEMON_URL
}

function readDaemonToken(): string | undefined {
  const cfg = vscode.workspace.getConfiguration('neat')
  const token = cfg.get<string>('daemonToken')
  return token && token.trim().length > 0 ? token.trim() : undefined
}

function applyStatus(state: StatusState): void {
  if (!statusBarItem) return
  const { text, tooltip } = statusText(state)
  statusBarItem.text = text
  statusBarItem.tooltip = tooltip
}

async function schedulePoll(delayMs: number): Promise<void> {
  pollTimer = setTimeout(async () => {
    const state = await pollHealth(readDaemonUrl(), readDaemonToken())
    applyStatus(state)
    void schedulePoll(nextInterval(state, delayMs || BASE_INTERVAL_MS))
  }, delayMs)
}

// ── Configure dispatch ──────────────────────────────────────────────────────

async function runConfigure(host: ReturnType<typeof detectHost>): Promise<void> {
  if (host.kind === 'vscode') {
    if (nativeProviderRegistered) {
      await vscode.window.showInformationMessage(
        'NEAT is registered as an MCP server for this editor. Manage it under the MCP servers view (Chat: List MCP Servers).',
      )
    } else {
      // Genuine VS Code but the provider API isn't available — pre-1.101.
      await vscode.window.showWarningMessage(
        'NEAT needs VS Code 1.101 or newer to register its MCP server automatically. Update VS Code, or add `npx -y @neat.is/mcp` as an MCP server by hand.',
      )
    }
    return
  }
  await configureFork(host.fork)
}

async function configureFork(fork: ForkDescriptor): Promise<void> {
  const server = neatServerEntry(readDaemonUrl())

  // Prefer the `neat` CLI verb that already knows this fork — it also drops the
  // graph-first guidance the MCP config alone doesn't. Fall back to an
  // in-extension merge if the CLI isn't installed or the run fails.
  if (fork.cliVerb) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
    const outcome = await runNeatCli(fork.cliVerb, cwd)
    if (outcome === 'ok') {
      await vscode.window.showInformationMessage(
        `Wired NEAT's MCP server into ${fork.label} via \`neat ${fork.cliVerb} --apply\`. Restart ${fork.label} to pick it up.`,
      )
      return
    }
    // 'notfound' or 'failed' → try the config-file fallback below.
  }

  if (!fork.configHomeSegments) {
    // An unrecognised fork with no known config path. Don't guess a file —
    // hand the user the exact JSON to paste.
    await showManualJson(fork, server)
    return
  }

  const target = path.join(os.homedir(), ...fork.configHomeSegments)
  const result = await mergeForkConfigFile(target, server)
  switch (result.kind) {
    case 'written':
      await vscode.window.showInformationMessage(
        `Wired NEAT's MCP server into ${target}. Restart ${fork.label} to pick it up.`,
      )
      return
    case 'nochange':
      await vscode.window.showInformationMessage(
        `NEAT's MCP server is already configured in ${target}.`,
      )
      return
    case 'malformed':
      await vscode.window.showErrorMessage(
        `${target} is not valid JSON — nothing was written. Fix it (or move it aside) and run the command again.`,
      )
      return
    case 'error':
      await vscode.window.showErrorMessage(
        `Could not write ${target}: ${result.message}`,
      )
      return
  }
}

type NeatCliOutcome = 'ok' | 'notfound' | 'failed'

// Run `neat <verb> --apply` in the workspace. Resolves 'notfound' when `neat`
// isn't on PATH (ENOENT), 'failed' on a non-zero exit, 'ok' otherwise.
function runNeatCli(verb: 'cursor' | 'devin', cwd: string): Promise<NeatCliOutcome> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('neat', [verb, '--apply'], { cwd, shell: false })
    } catch {
      resolve('notfound')
      return
    }
    child.on('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'ENOENT' ? 'notfound' : 'failed')
    })
    child.on('close', (code) => resolve(code === 0 ? 'ok' : 'failed'))
  })
}

type MergeFileResult =
  | { kind: 'written' }
  | { kind: 'nochange' }
  | { kind: 'malformed' }
  | { kind: 'error'; message: string }

// Read the fork's MCP config (absent → empty), merge NEAT's server in without
// clobbering anything, write it back. A malformed existing file is a hard stop
// with nothing written — the same fail-honest discipline the CLI keeps.
async function mergeForkConfigFile(
  target: string,
  server: NeatServerEntry,
): Promise<MergeFileResult> {
  let existing: McpConfigFile = {}
  try {
    existing = JSON.parse(await fs.readFile(target, 'utf8')) as McpConfigFile
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      existing = {}
    } else if (err instanceof SyntaxError) {
      return { kind: 'malformed' }
    } else {
      return { kind: 'error', message: e.message }
    }
  }

  const { merged, changed } = mergeForkMcpConfig(existing, server)
  if (!changed) return { kind: 'nochange' }

  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    return { kind: 'written' }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message }
  }
}

async function showManualJson(fork: ForkDescriptor, server: NeatServerEntry): Promise<void> {
  const snippet = JSON.stringify({ mcpServers: { neat: server } }, null, 2)
  const pick = await vscode.window.showInformationMessage(
    `NEAT can't auto-detect ${fork.label}'s MCP config. Add this server to it by hand:\n\n${snippet}`,
    'Copy JSON',
  )
  if (pick === 'Copy JSON') {
    await vscode.env.clipboard.writeText(snippet)
  }
}

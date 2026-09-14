// The first-run "front door" for the `neat` CLI (published as `npx neat.is`).
//
// A bare `npx neat.is` with no command runs the local zero-to-graph
// orchestrator on the cwd. That is the right thing for a returning user, but a
// first-timer lands in the middle of an extraction with no idea whether they
// wanted the local path or their hosted account. `runWelcome` is the one-time
// menu that asks: log in to a hosted NEAT, or set up self-hosted here — then
// hands off to the flow they chose. It runs only on a true first run in an
// interactive terminal (see `shouldShowWelcome`); every other invocation keeps
// the exact behaviour it had before.
//
// Dependencies are injected (the login fn, the orchestrator fn, an output sink,
// and a line reader) the same way `login-cli.ts` injects its readers, so the
// whole flow is unit-testable without a real TTY.

import readline from 'node:readline/promises'
import { readPackageVersion } from './banner.js'
import { readProfilesConfig } from './profiles.js'

// The NEAT block-letter wordmark. Hand-written box-drawing glyphs — no external
// font, no dependency — matching the artwork the orchestrator's banner prints
// so the brand reads the same in both places.
const WORDMARK: readonly string[] = [
  '███╗   ██╗███████╗ █████╗ ████████╗',
  '████╗  ██║██╔════╝██╔══██╗╚══██╔══╝',
  '██╔██╗ ██║█████╗  ███████║   ██║   ',
  '██║╚██╗██║██╔══╝  ██╔══██║   ██║   ',
  '██║ ╚████║███████╗██║  ██║   ██║   ',
  '╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝   ╚═╝   ',
]

// A short prompt the user pastes into their own coding agent to stand up
// self-hosted NEAT. Kept accurate to the shipped commands (CLAUDE.md common
// commands): `init --apply` extracts + instruments, `watch` runs the daemon,
// `skill --apply` wires the MCP server so the agent queries the graph.
export const AGENT_SETUP_PROMPT = `Set up self-hosted NEAT for this project. NEAT keeps a live graph of the code
fused with runtime OpenTelemetry data, queryable over MCP — so you can ask it
about the system instead of grepping files.

1. Extract the code graph and instrument the services for OpenTelemetry:
     npx neat.is init . --apply
   Then install the deps it added (npm install, or your language's equivalent).
2. Start the NEAT daemon so it watches the code and ingests live traces:
     npx neat.is watch .
3. Wire NEAT's MCP server into your agent so it queries the graph first:
     npx neat.is skill --apply
   (other agents: npx neat.is codex|cursor|gemini … --apply)

Then ask NEAT instead of reading files, e.g.
     npx neat.is ask "why is checkout failing?"`

export interface WelcomeDeps {
  // Where lines are written. Defaults to stdout via console.log.
  out?: (line: string) => void
  // Read a line the user types (a menu choice, a yes/no). Undefined → no
  // terminal to read from; the default reads only when stdin is a TTY. Injected
  // for tests so no real TTY is needed.
  readLine?: (prompt: string) => Promise<string | undefined>
  // Run the hosted-login flow (menu option 1). Given the argv to pass through —
  // the welcome menu picks the browser method by default. Defaults are wired in
  // cli.ts to `runLoginCommand`.
  login?: (argv: string[]) => Promise<number>
  // Run the local zero-to-graph orchestrator on `cwd` (menu option 2b). Wired in
  // cli.ts to the same `tryOrchestrator(process.cwd(), …)` path bare `neat` uses.
  orchestrator?: (cwd: string) => Promise<number>
  // The working directory handed to the orchestrator. Defaults to process.cwd().
  cwd?: string
}

// Print the wordmark + version header through the injected sink.
function printHeader(out: (line: string) => void): void {
  for (const line of WORDMARK) out(line)
  out('')
  out(`  neat.is  ·  v${readPackageVersion()}`)
  out('')
}

/**
 * The interactive first-run menu. Returns a process exit code.
 *
 *   1) I have a NEAT account — log in   → the hosted login flow (browser method)
 *   2) Self-hosted                      → offer a copy-paste agent-setup prompt,
 *                                          then run the local orchestrator on cwd
 *
 * A reader that returns undefined (no terminal / EOF) falls through to the
 * self-hosted orchestrator — the same behaviour a bare `neat` has today — so the
 * front door never dead-ends waiting on input nobody can give.
 */
export async function runWelcome(deps: WelcomeDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  const readLine = deps.readLine ?? defaultReadLine
  const login = deps.login ?? (() => Promise.resolve(0))
  const orchestrator = deps.orchestrator ?? (() => Promise.resolve(0))
  const cwd = deps.cwd ?? process.cwd()

  printHeader(out)
  out('Welcome to NEAT. Let\'s get you a graph of this system.')
  out('')
  out('  1) I have a NEAT account — log in')
  out('  2) Self-hosted — set up NEAT on this machine')
  out('')

  for (;;) {
    const choice = (await readLine('Choose 1 or 2 (default 2): '))?.trim()

    // No answer (EOF / not a terminal) → the self-hosted path, matching the
    // behaviour bare `neat` already has.
    if (choice === undefined) return runSelfHosted(out, readLine, orchestrator, cwd)

    if (choice === '1') {
      // Default method is the browser loopback login (login-cli.ts §--browser).
      return login(['--browser'])
    }
    if (choice === '2' || choice === '') {
      return runSelfHosted(out, readLine, orchestrator, cwd)
    }

    out(`"${choice}" isn't 1 or 2 — try again, or press Enter for self-hosted.`)
  }
}

// Menu option 2: offer the agent-setup prompt, then run the local orchestrator.
async function runSelfHosted(
  out: (line: string) => void,
  readLine: (prompt: string) => Promise<string | undefined>,
  orchestrator: (cwd: string) => Promise<number>,
  cwd: string,
): Promise<number> {
  const wantsPrompt = (await readLine('Print a copy-paste setup prompt for your coding agent? [Y/n]: '))
    ?.trim()
    .toLowerCase()
  // Default (empty / Enter) is yes; only an explicit "n"/"no" skips it.
  if (wantsPrompt !== 'n' && wantsPrompt !== 'no') {
    out('')
    out('─── copy the prompt below into your coding agent ───')
    out('')
    out(AGENT_SETUP_PROMPT)
    out('')
    out('────────────────────────────────────────────────────')
    out('')
  }
  out('Building your local graph now…')
  out('')
  return orchestrator(cwd)
}

export interface WelcomeGateDeps {
  // Whether stdin / stdout are terminals. Default: the real process streams.
  // Injected in tests so gating never needs a real TTY.
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  // Reads the client profile store. Default: the real `~/.neat/profiles.json`
  // reader. A machine that has never connected to a hosted NEAT and never run
  // the orchestrator has an empty (or missing) profile list.
  readProfiles?: () => Promise<{ profiles: unknown[] }>
}

/**
 * Whether a bare, no-command `neat` should open the first-run menu rather than
 * run the orchestrator directly. True only when:
 *   - the session is interactive (both stdin and stdout are TTYs), AND
 *   - this looks like a true first run — no existing `~/.neat` profiles config,
 *     or an empty one.
 *
 * Conservative by design: anything uncertain (a malformed profiles file, a read
 * error) returns false so the caller keeps the exact current behaviour. It never
 * throws.
 */
export async function shouldShowWelcome(deps: WelcomeGateDeps = {}): Promise<boolean> {
  const stdinTTY = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY)
  const stdoutTTY = deps.stdoutIsTTY ?? Boolean(process.stdout.isTTY)
  // Non-interactive (piped, CI, redirected) → never a menu; the orchestrator
  // path handles scripted use exactly as before.
  if (!stdinTTY || !stdoutTTY) return false

  const readProfiles = deps.readProfiles ?? (() => readProfilesConfig())
  try {
    const { profiles } = await readProfiles()
    // A returning user who has already logged in or run NEAT has profiles →
    // not a first run, keep current behaviour.
    return profiles.length === 0
  } catch {
    // Uncertain → fall back to current behaviour rather than guess.
    return false
  }
}

// Prompt for a line, echoed, from the terminal — the same shape login-cli.ts
// uses. Returns undefined when stdin is not a TTY so a scripted run falls
// through rather than hanging on a prompt nobody can answer.
async function defaultReadLine(prompt: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
  }
}

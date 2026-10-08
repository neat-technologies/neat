// The first-run "front door" for the `neat` CLI (published as `npx neat.is`).
//
// A bare `npx neat.is` with no command runs the local zero-to-graph
// orchestrator on the cwd. That is the right thing for a returning user, but a
// first-timer lands in the middle of an extraction with no idea whether they
// wanted the local path or their hosted account. `runWelcome` prints the wordmark
// and asks: log into hosted NEAT, or set it up locally — then hands off to the
// flow they chose.
//
// It opens when this DIRECTORY is not yet a NEAT project, in an interactive
// terminal (see `shouldShowWelcome`) — not once per machine. Every other
// invocation keeps the exact behaviour it had before.
//
// Dependencies are injected (the login fn, the orchestrator fn, an output sink, a
// line reader, a key reader, and the cursor move the menu repaints with) the same
// way `login-cli.ts` injects its readers, so the whole flow — arrow menu included
// — is unit-testable without a real TTY.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { readPackageVersion } from './banner.js'
import { AGENT_DIRECTIVE } from './agent-directive.generated.js'
import { findDaemonByProject, readRegistry as readRegistryFile } from './registry.js'

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

/** The local door's prompt is rendered after the orchestrator, using its actual project and daemon. */
export function renderAgentSetupPrompt(project: string, restPort?: number): string {
  const endpoint =
    restPort === undefined
      ? 'The daemon endpoint is unavailable; run `npx neat.is up` to start it.'
      : `The local daemon is serving it at http://127.0.0.1:${restPort}.`
  return `NEAT is set up for project "${project}". ${endpoint}

NEAT models this software system as one graph: code, data, infrastructure,
runtime traffic, incidents, and supported provider telemetry fused where evidence
permits. Use it to see what exists, what actually ran, where a failure began, and
what a change could affect. Missing observations do not prove a path never runs.

1. Wire NEAT's MCP server into this agent session:
     npx neat.is skill --apply
   For Codex: npx neat.is codex --apply
   For Cursor or Gemini, use the corresponding cursor or gemini subcommand.
2. Verify the MCP \`ask\` tool answers:
     ask "what services are in this project and what do they talk to?"
   If the daemon is unreachable, run \`npx neat.is up\`.

${AGENT_DIRECTIVE}
As the app or tests run, traces fill the OBSERVED layer. Daemon log:
neat-out/daemon.log. Reopen this door with \`npx neat.is welcome\`.`
}

export interface WelcomeDeps {
  // Where lines are written. Defaults to stdout via console.log.
  out?: (line: string) => void
  // Read a line the user types (a menu choice, a yes/no). Undefined → no
  // terminal to read from; the default reads only when stdin is a TTY. Injected
  // for tests so no real TTY is needed.
  readLine?: (prompt: string) => Promise<string | undefined>
  // Read one normalised keypress, for the navigable menu. Undefined → the
  // default raw-mode reader is used, and when the terminal cannot do raw mode the
  // menu falls back to `readLine`'s numbered prompt. Injected for tests so the
  // arrow menu needs no TTY.
  readKey?: () => Promise<MenuKey | undefined>
  // Move the terminal cursor up `rows` lines so the menu repaints in place.
  // Defaults to an ANSI write on stdout; a no-op in tests, which assert the
  // rendered rows rather than the escape codes.
  moveCursorUp?: (rows: number) => void
  // Run the hosted-login flow (menu option 1). Given the argv to pass through —
  // the welcome menu picks the browser method by default. Defaults are wired in
  // cli.ts to `runLoginCommand`.
  login?: (argv: string[]) => Promise<number>
  // Run the local zero-to-graph orchestrator on `cwd` (menu option 2b). Wired in
  // cli.ts to the same `tryOrchestrator(process.cwd(), …)` path bare `neat` uses.
  orchestrator?: (cwd: string, opts?: OrchestratorOverrides) => Promise<number>
  /** True when `--no-instrument` or `--dry-run` was already given, so the front door
   *  doesn't ask a question the person has answered on the command line. */
  instrumentFlagGiven?: boolean
  /** A dry run does not install or start the graph, so it cannot offer a ready prompt. */
  dryRun?: boolean
  /** Reads the machine project registry through `registry.ts`, which owns that file's
   *  authority (ADR-048 §8). Used to spot a name collision before one happens. */
  readRegistry?: () => Promise<{ projects: { name: string; path: string }[] }>
  /** Resolve the daemon started by the local build, for the actual REST port. */
  readDaemon?: (project: string) => Promise<{ projectPath: string; restPort: number } | undefined>
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
 * The front door. Returns a process exit code.
 *
 *   1) Log me into Hosted Neat      → the hosted login flow (browser method)
 *   2) Self-host or use it locally  → run the local orchestrator on cwd, then
 *                                     offer a copy-paste graph directive
 *
 * Navigable with the arrow keys when the terminal can hand us raw keys, and the
 * numbered prompt when it cannot.
 *
 * A reader that returns undefined (no terminal / EOF) falls through to the
 * self-hosted orchestrator — the same behaviour a bare `neat` has today — so the
 * front door never dead-ends waiting on input nobody can give.
 */
export async function runWelcome(deps: WelcomeDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line))
  try {
    return await runFrontDoor(deps, out)
  } catch (err) {
    // Ctrl-C in the front door is a person saying "not this". Leave the way a
    // terminal program should — a fresh line and the conventional 128+SIGINT
    // code — rather than a stack trace from inside node's readline.
    if (isPromptCancelled(err)) {
      out('')
      return 130
    }
    throw err
  }
}

/** Thrown by a reader when the person interrupted the prompt rather than answered it. */
export class PromptCancelled extends Error {
  constructor() {
    super('prompt cancelled')
    this.name = 'PromptCancelled'
  }
}

// `readline/promises` rejects a pending `question()` with an AbortError carrying
// `ABORT_ERR` when Ctrl-C arrives. Both that and our own sentinel count, so an
// injected reader can signal a cancel without reproducing node's error shape.
function isPromptCancelled(err: unknown): boolean {
  if (err instanceof PromptCancelled) return true
  const e = err as { code?: unknown; name?: unknown } | null
  return e?.code === 'ABORT_ERR' || e?.name === 'AbortError'
}

async function runFrontDoor(deps: WelcomeDeps, out: (line: string) => void): Promise<number> {
  const readLine = deps.readLine ?? defaultReadLine
  const login = deps.login ?? (() => Promise.resolve(0))
  const orchestrator = deps.orchestrator ?? (() => Promise.resolve(0))
  const cwd = deps.cwd ?? process.cwd()
  const flagGiven = deps.instrumentFlagGiven ?? false
  const readRegistry = deps.readRegistry ?? (() => readRegistryFile())
  const readDaemon =
    deps.readDaemon ??
    (async (project: string) => {
      const daemon = await findDaemonByProject(project)
      return daemon?.live
        ? { projectPath: daemon.record.projectPath, restPort: daemon.record.ports.rest }
        : undefined
    })

  printHeader(out)
  out("Welcome to NEAT. Let's get you a graph of this system.")
  out('')

  // A navigable menu when the terminal can give us keys one at a time; the
  // numbered prompt otherwise. Both end in the same two flows.
  const keyReader =
    deps.readKey !== undefined ? { read: deps.readKey, done: () => {} } : createKeyReader()
  const picked =
    keyReader !== null
      ? await selectOption(out, keyReader, deps.moveCursorUp ?? defaultMoveCursorUp)
      : await selectByNumber(out, readLine)

  // No answer (EOF, no terminal, cancelled) → the self-hosted path, matching the
  // behaviour bare `neat` already has.
  if (picked === undefined)
    return runSelfHosted(
      out,
      readLine,
      orchestrator,
      cwd,
      readRegistry,
      readDaemon,
      flagGiven,
      deps.dryRun === true,
    )
  // Default method is the browser loopback login (login-cli.ts §--browser).
  if (picked === 0) return login(['--browser'])
  return runSelfHosted(
    out,
    readLine,
    orchestrator,
    cwd,
    readRegistry,
    readDaemon,
    flagGiven,
    deps.dryRun === true,
  )
}

/** The two doors, in order. Index 0 is hosted, index 1 is local. */
export const MENU_OPTIONS: readonly string[] = [
  'Log me into Hosted Neat',
  "I'd like to self-host or use it locally (copy a prompt)",
]

/** A keypress, normalised so the menu never parses escape sequences itself. */
export type MenuKey = 'up' | 'down' | 'enter' | 'select-1' | 'select-2' | 'cancel' | 'ignore'

interface KeyReader {
  read: () => Promise<MenuKey | undefined>
  done: () => void
}

// Render the rows once, then redraw in place on every move. Returns the chosen
// index, or undefined when the reader gives us nothing (EOF) or the user cancels.
async function selectOption(
  out: (line: string) => void,
  reader: KeyReader,
  moveCursorUp: (rows: number) => void,
): Promise<number | undefined> {
  let cursor = 0
  const render = (): void => {
    for (const [i, label] of MENU_OPTIONS.entries()) {
      out(i === cursor ? `  ❯ ${i + 1}) ${label}` : `    ${i + 1}) ${label}`)
    }
  }
  try {
    render()
    out('')
    out('  ↑/↓ to move · Enter to choose · 1 or 2 to jump')
    for (;;) {
      const key = await reader.read()
      // EOF is "nobody can answer" and falls through to the local path, as a bare
      // `neat` already does. Ctrl-C and Escape are a deliberate "not this", so they
      // leave instead of quietly starting the extraction the person just refused.
      if (key === undefined) return undefined
      if (key === 'cancel') throw new PromptCancelled()
      if (key === 'enter') return cursor
      if (key === 'select-1') return 0
      if (key === 'select-2') return 1
      if (key === 'up') cursor = (cursor + MENU_OPTIONS.length - 1) % MENU_OPTIONS.length
      else if (key === 'down') cursor = (cursor + 1) % MENU_OPTIONS.length
      else continue // an unbound key redraws nothing
      // Step back over the rows plus the blank line and the hint, and repaint.
      moveCursorUp(MENU_OPTIONS.length + 2)
      render()
      out('')
      out('  ↑/↓ to move · Enter to choose · 1 or 2 to jump')
    }
  } finally {
    reader.done()
  }
}

// The pre-existing numbered prompt, kept verbatim in behaviour for any terminal
// that cannot hand us raw keys.
async function selectByNumber(
  out: (line: string) => void,
  readLine: (prompt: string) => Promise<string | undefined>,
): Promise<number | undefined> {
  for (const [i, label] of MENU_OPTIONS.entries()) out(`  ${i + 1}) ${label}`)
  out('')
  for (;;) {
    const choice = (await readLine('Choose 1 or 2 (default 2): '))?.trim()
    if (choice === undefined) return undefined
    if (choice === '1') return 0
    if (choice === '2' || choice === '') return 1
    out(`"${choice}" isn't 1 or 2 — try again, or press Enter for the local path.`)
  }
}

// Raw-mode keypresses from the real terminal. Returns null when the terminal
// cannot do it — no TTY, or no `setRawMode` — so the caller falls back to the
// numbered prompt rather than hanging. Raw mode is entered once and restored in
// `done()`, so an aborted run never leaves the shell in raw mode.
function createKeyReader(): KeyReader | null {
  const stdin = process.stdin
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return null
  stdin.setRawMode(true)
  stdin.resume()
  let closed = false
  // Watched once for the reader's whole life. Registering the end listener per
  // read would miss an EOF that arrived between reads — or before the first one —
  // and the menu would then wait on input that can never arrive.
  let ended = false
  const markEnded = (): void => {
    ended = true
  }
  stdin.once('end', markEnded)
  stdin.once('close', markEnded)
  return {
    read: () =>
      new Promise<MenuKey | undefined>((resolve) => {
        if (ended) {
          resolve(undefined)
          return
        }
        const finish = (value: MenuKey | undefined): void => {
          stdin.removeListener('data', onData)
          stdin.removeListener('end', onClosed)
          stdin.removeListener('close', onClosed)
          resolve(value)
        }
        const onData = (buf: Buffer): void => finish(decodeKey(buf))
        const onClosed = (): void => {
          ended = true
          finish(undefined)
        }
        stdin.on('data', onData)
        stdin.once('end', onClosed)
        stdin.once('close', onClosed)
      }),
    done: () => {
      if (closed) return
      closed = true
      stdin.removeListener('end', markEnded)
      stdin.removeListener('close', markEnded)
      stdin.setRawMode(false)
      stdin.pause()
    },
  }
}

function decodeKey(buf: Buffer): MenuKey {
  const s = buf.toString('utf8')
  if (s === '\u001b[A' || s === 'k') return 'up'
  if (s === '\u001b[B' || s === 'j') return 'down'
  if (s === '\r' || s === '\n') return 'enter'
  if (s === '1') return 'select-1'
  if (s === '2') return 'select-2'
  // Ctrl-C and a bare Escape both mean "I didn't want this" — treated as no
  // answer, which lands on the local path exactly as EOF already does.
  if (s === '\u0003' || s === '\u001b') return 'cancel'
  return 'ignore'
}

function defaultMoveCursorUp(rows: number): void {
  if (rows > 0) process.stdout.write(`\u001b[${rows}A`)
}

// Menu option 2: build the local graph, then offer an agent prompt with real values.
async function runSelfHosted(
  out: (line: string) => void,
  readLine: (prompt: string) => Promise<string | undefined>,
  orchestrator: (cwd: string, opts?: OrchestratorOverrides) => Promise<number>,
  cwd: string,
  readRegistry: () => Promise<{ projects: { name: string; path: string }[] }>,
  readDaemon: (project: string) => Promise<{ projectPath: string; restPort: number } | undefined>,
  instrumentFlagGiven: boolean,
  dryRun: boolean,
): Promise<number> {
  // A project's name is its directory's basename, and names are unique across the
  // machine — so a second `api` or `app` collides with one registered somewhere else.
  // Ask here, before anything is written, rather than let the run reach the registry
  // and fail with advice (`pass --project`) that a menu offers no way to take.
  const project = await resolveProjectName(out, readLine, cwd, readRegistry)

  // Then ask before editing their files. Instrumentation is the point of the local
  // path — it is what fills the OBSERVED layer — so Enter takes it. But it writes to a
  // manifest and runs a package manager, and doing that to someone's repo without
  // saying so first is the kind of thing they find out about in `git status`.
  // Someone who already passed `--no-instrument` or `--dry-run` has answered.
  // Naming comes first: it decides what this project IS, and it is the question that
  // has to be settled before anything is written anywhere.
  const declined = instrumentFlagGiven ? undefined : await askToInstrument(out, readLine)

  out('Building your local graph now…')
  out('')
  // The instrument answer given here IS the answer — the orchestrator has its own
  // interactive prompt (`orchestrator.ts`, gated on `opts.yes`), and asking the same
  // question twice in a row is worse than never having asked. Accepting carries
  // `yes` so that prompt stays quiet; declining carries `--no-instrument`, which
  // skips it for the same reason.
  // The door's wordmark and version are the header for this run, so the
  // orchestrator is told not to introduce the product a second time (#1242).
  const overrides: OrchestratorOverrides = {
    headerShown: true,
    ...(project !== undefined ? { project } : {}),
    ...(declined === undefined ? {} : declined ? { noInstrument: true } : { yes: true }),
  }
  const code = await orchestrator(cwd, overrides)
  if (code !== 0 || dryRun) return code

  const wantsPrompt = (
    await readLine('Print a copy-paste setup prompt for your coding agent? [Y/n]: ')
  )
    ?.trim()
    .toLowerCase()
  // Default (empty / Enter / no terminal) is yes; only an explicit no skips it.
  if (wantsPrompt !== 'n' && wantsPrompt !== 'no') {
    const projectName = project ?? path.basename(path.resolve(cwd))
    const daemon = await readDaemon(projectName).catch(() => undefined)
    const port =
      daemon && path.resolve(daemon.projectPath) === path.resolve(cwd) ? daemon.restPort : undefined
    out('')
    out('─── copy the directive below into your coding agent ───')
    out('')
    out(renderAgentSetupPrompt(projectName, port))
    out('')
    out('────────────────────────────────────────────────────')
    out('')
  }
  return code
}

/** Overrides the front door hands the orchestrator from what the person chose. */
export interface OrchestratorOverrides {
  /** A name chosen at the door because the directory's own basename was taken. */
  project?: string
  noInstrument?: boolean
  /** Suppresses the orchestrator's own instrument prompt — the door already asked. */
  yes?: boolean
  /** The door printed the wordmark and version, so the orchestrator skips its banner. */
  headerShown?: boolean
}

// Returns true when they declined — the value `--no-instrument` carries.
async function askToInstrument(
  out: (line: string) => void,
  readLine: (prompt: string) => Promise<string | undefined>,
): Promise<boolean> {
  out('Instrument the services for OpenTelemetry now?')
  out('This edits package.json / requirements.txt / go.mod and runs the package manager.')
  const answer = (await readLine('[Y/n]: '))?.trim().toLowerCase()
  const declined = answer === 'n' || answer === 'no'
  if (declined) {
    out('')
    out('Skipping instrumentation — the graph will hold the declared side only.')
    out('Run `npx neat.is init . --apply` when you want the runtime half.')
  }
  out('')
  return declined
}

// Returns a name to register under, or undefined to let the orchestrator use the
// basename as it always has. Never throws: an unreadable registry means we cannot
// know there is a collision, and guessing would be worse than the existing error.
async function resolveProjectName(
  out: (line: string) => void,
  readLine: (prompt: string) => Promise<string | undefined>,
  cwd: string,
  readRegistry: () => Promise<{ projects: { name: string; path: string }[] }>,
): Promise<string | undefined> {
  const here = path.resolve(cwd)
  const base = path.basename(here)
  let taken: Map<string, string>
  try {
    const { projects } = await readRegistry()
    taken = new Map(projects.map((p) => [p.name, p.path]))
  } catch {
    return undefined
  }

  const clash = taken.get(base)
  // No entry, or the entry IS this directory — a re-run, which registers idempotently.
  if (clash === undefined || path.resolve(clash) === here) return undefined

  out('')
  out(`A project named \`${base}\` is already registered (${clash}).`)
  const suggested = firstFreeName(base, taken)
  for (;;) {
    const answer = (await readLine(`Name this one: [${suggested}] `))?.trim()
    // No terminal to answer with → take the suggestion rather than dead-end.
    if (answer === undefined) return suggested
    const chosen = answer.length === 0 ? suggested : answer
    if (!isUsableProjectName(chosen)) {
      out(`"${chosen}" won't work as a project name — letters, digits, dot, dash and underscore.`)
      continue
    }
    const other = taken.get(chosen)
    if (other !== undefined && path.resolve(other) !== here) {
      out(`\`${chosen}\` is registered too (${other}).`)
      continue
    }
    out('')
    return chosen
  }
}

// `<base>-2`, `-3`, … — the first that nothing holds.
function firstFreeName(base: string, taken: Map<string, string>): string {
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// The registry only requires a non-empty string, but a name becomes a filename
// (`pathsForProject` writes `<name>.json`), so a separator or a traversal segment
// would escape `neat-out/`. Keep it to what a directory basename can safely be.
function isUsableProjectName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && /^[A-Za-z0-9._-]+$/.test(name)
}

export interface WelcomeGateDeps {
  // Whether stdin / stdout are terminals. Default: the real process streams.
  // Injected in tests so gating never needs a real TTY.
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  // The directory the question is asked about. Default: process.cwd().
  cwd?: string
  // Reads the machine project registry through `registry.ts`, which owns that
  // file's authority (ADR-048 §8) — nothing here names or touches it directly.
  // An entry whose `path` resolves to `cwd` means this directory is already a
  // NEAT project.
  readRegistry?: () => Promise<{ projects: { path: string }[] }>
  // Whether this directory already holds an extracted graph — a `neat-out/` with
  // a snapshot in it. Default: a real fs check. Injected so the gate is testable
  // without laying down files.
  hasSnapshot?: (cwd: string) => Promise<boolean>
}

/**
 * Whether a bare, no-command `neat` should open the front door rather than run
 * the orchestrator directly. True only when:
 *   - the session is interactive (both stdin and stdout are TTYs), AND
 *   - this directory is not yet a NEAT project — no registry entry resolving to
 *     it, and no `neat-out/` snapshot sitting in it.
 *
 * The question is about the **project**, not the machine. Gating on the profile
 * store meant one `neat login` anywhere closed the door for every future project
 * on that machine, so the first run in a new repo — the moment the door exists
 * for — dropped straight into an extraction. A returning user still falls through
 * immediately in any directory they have already set up, which is the case the
 * profile gate was really protecting.
 *
 * Conservative by design: anything uncertain (an unreadable registry, a failed
 * read) returns false so the caller keeps the exact current behaviour. It never
 * throws.
 */
export async function shouldShowWelcome(deps: WelcomeGateDeps = {}): Promise<boolean> {
  const stdinTTY = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY)
  const stdoutTTY = deps.stdoutIsTTY ?? Boolean(process.stdout.isTTY)
  // Non-interactive (piped, CI, redirected) → never a menu; the orchestrator
  // path handles scripted use exactly as before.
  if (!stdinTTY || !stdoutTTY) return false

  const cwd = deps.cwd ?? process.cwd()
  const readRegistry = deps.readRegistry ?? (() => readRegistryFile())
  const hasSnapshot = deps.hasSnapshot ?? defaultHasSnapshot

  try {
    const here = path.resolve(cwd)
    const { projects } = await readRegistry()
    // Registered under any name → already a project, whatever it is called.
    if (projects.some((p) => path.resolve(p.path) === here)) return false
    // Extracted here before without being registered (a bare run in a checkout,
    // an `init` that never registered) → still not a first run.
    if (await hasSnapshot(here)) return false
    return true
  } catch {
    // Uncertain → fall back to current behaviour rather than guess.
    return false
  }
}

// `neat-out/` holding a snapshot is the on-disk mark that this directory has been
// extracted before. The default project writes `graph.json`; a named project
// writes `<name>.json` (`pathsForProject`), so any `.json` in there counts rather
// than only the default's filename.
async function defaultHasSnapshot(cwd: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(cwd, 'neat-out'))
    return entries.some((e) => e.endsWith('.json'))
  } catch {
    // No `neat-out/` at all is the common case and means no snapshot.
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

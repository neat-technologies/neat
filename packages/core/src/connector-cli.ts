// `neat connector add/list/remove/test` — the write side of the ADR-130
// on-ramp (docs/contracts/connector-config.md §3). The daemon-read chain
// (#730) already turns a `~/.neat/connectors.json` entry into a running poll
// loop; this is the command a human actually touches to put an entry there.
//
// Everything provider-specific is dispatched through the registry table
// (connectors/registry.ts §5) — the required-field schema this prompts for and
// the auth round-trip `add`/`test` run both come from the entry, so no per-
// provider branch lives here. The two security non-negotiables the contract
// names ride through this module: validate-on-add by default (the credential
// is proven against the provider before it's written), and env-ref-by-default /
// `0600` / never-a-resolved-secret-on-screen (the write helpers in
// connectors-config.ts own the file mode; this module only ever prints the
// redacted pointer, never a resolved value).
//
// Handlers take their filesystem home, environment, `fetch`, prompt, and output
// streams as injected deps so the whole surface is testable against a temp home
// and a stubbed provider — no live account, no real `~/.neat`.

import readline from 'node:readline'
import {
  autoSlugConnectorId,
  connectorsConfigPath,
  describeCredential,
  isCredentialRef,
  readConnectorsConfig,
  readProjectConnectors,
  removeProjectConnectorEntry,
  upsertProjectConnectorEntry,
  type ConnectorEntry,
  type CredentialRef,
} from './connectors-config.js'
import { resolveProject, TargetResolutionError } from './project-resolve.js'
import { keychainRef, systemKeychain } from './keychain.js'
import { readTokenStdin } from './secret-input.js'
import {
  deprovisionConnector,
  getProviderFieldSchema,
  isPushProvider,
  knownProviderNames,
  provisionConnector,
  validateConnectorEntry,
  type ProviderFieldSchema,
  type ValidateOutcome,
} from './connectors/registry.js'

// ── deps / injection ──────────────────────────────────────────────────────

export interface ConnectorCliDeps {
  // The machine-level `~/.neat` (NEAT_HOME override) — used only to read the
  // legacy `connectors.json` during migration. Tests pass a temp home.
  home?: string
  // The directory the command runs in; the project is resolved by walking up
  // from here to the nearest `.neat/project.json`. Undefined → process.cwd().
  cwd?: string
  env?: NodeJS.ProcessEnv
  // Test seam for the provider auth round-trip (contract §4). Undefined → the
  // junction's real `fetch`.
  fetchImpl?: typeof fetch
  // Interactive prompt. Undefined → a readline prompt that returns '' when
  // stdin isn't a TTY, so CI never hangs waiting on input.
  prompt?: (question: string) => Promise<string>
  // Whether to prompt at all for missing fields. Undefined → `process.stdin`
  // is a TTY. Non-interactive runs require every field as a flag.
  interactive?: boolean
  // `--token-stdin` reader. Undefined → secret-input.ts's readTokenStdin.
  readTokenStdin?: (prompt: string) => Promise<string | undefined>
  out?: (line: string) => void
  err?: (line: string) => void
}

interface ResolvedDeps {
  home: string | undefined
  cwd: string
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  prompt: (question: string) => Promise<string>
  interactive: boolean
  readTokenStdin: (prompt: string) => Promise<string | undefined>
  out: (line: string) => void
  err: (line: string) => void
}

async function defaultPrompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ''
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise<string>((resolve) => rl.question(`${question} `, resolve))
  } finally {
    rl.close()
  }
}

function resolveDeps(deps: ConnectorCliDeps): ResolvedDeps {
  return {
    home: deps.home,
    cwd: deps.cwd ?? process.cwd(),
    env: deps.env ?? process.env,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    prompt: deps.prompt ?? defaultPrompt,
    interactive: deps.interactive ?? Boolean(process.stdin.isTTY),
    readTokenStdin: deps.readTokenStdin ?? readTokenStdin,
    out: deps.out ?? ((l) => console.log(l)),
    err: deps.err ?? ((l) => console.error(l)),
  }
}

// ── project resolution (ADR-273) ────────────────────────────────────────────

interface ResolvedCliProject {
  root: string
  // Absent for a project from before ADR-273 (no .neat/project.json yet).
  projectId?: string
  binding: 'local' | 'hosted'
  org?: string
}

// The project the CLI operates on: its root (the dir that holds `.neat/`) and
// this machine's binding to it. Resolved the same way every verb resolves its
// target (project-identity.md §3): `--project <name>` by name or id, else the
// nearest project walking up from the cwd, else a pre-273 registration, else an
// honest error — never a silent global write (ADR-273 §0).
async function resolveCliProject(
  args: ConnectorArgs,
  deps: ResolvedDeps,
): Promise<{ ok: true; project: ResolvedCliProject } | { ok: false; code: number }> {
  try {
    const resolved = await resolveProject({
      ...(args.project ? { project: args.project } : {}),
      cwd: deps.cwd,
      env: deps.env,
    })
    if (!resolved.root) {
      deps.err('neat connector: that project has no local directory, so it has no local connectors file.')
      return { ok: false, code: 2 }
    }
    return {
      ok: true,
      project: {
        root: resolved.root,
        ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
        binding: resolved.binding,
        ...(resolved.org ? { org: resolved.org } : {}),
      },
    }
  } catch (err) {
    if (err instanceof TargetResolutionError) {
      deps.err(`neat connector: ${err.message}`)
      return { ok: false, code: 2 }
    }
    throw err
  }
}

// A hosted-bound project's connectors are managed in the control plane, not the
// per-project file (ADR-273 §0). A local connector op on one is a loud error.
function hostedConnectorError(deps: ResolvedDeps, verb: string): number {
  deps.err(
    `neat connector ${verb}: this project is hosted — its connectors are managed in the control plane, ` +
      'not a local file. Use `neat connect <provider>` to connect a provider to the hosted project.',
  )
  return 2
}

// ── argument parsing ──────────────────────────────────────────────────────

export interface ConnectorArgs {
  subcommand: string
  positional: string[]
  project?: string
  // Single-field credential from --credential / --token (an env-ref or a
  // literal). Multi-field providers read their fields from `fields` instead.
  credential?: string
  // `--token-stdin`: read the secret from a pipe (or a no-echo prompt), store
  // it in the OS keychain, and write only the keychain reference.
  tokenStdin: boolean
  id?: string
  skipValidate: boolean
  // `--help`/`-h` anywhere prints usage and exits 0; `--json` asks a read
  // subcommand (list) for machine-readable output. Both are valueless flags —
  // the parser recognizes them so they never trip the "flag requires a value"
  // path (a papercut the first blind run hit: `neat connector --help` erroring).
  help: boolean
  json: boolean
  // Provider-specific option/credential fields, camelCased from their kebab
  // flag (`--account-id` → accountId). Object-valued flags (`--workers '{…}'`)
  // are JSON-parsed; `*Ms` flags are numbered; everything else stays a string.
  fields: Record<string, unknown>
}

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function coerceFieldValue(name: string, raw: string): unknown {
  const t = raw.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t)
    } catch {
      return raw
    }
  }
  // Only numeric-shaped option names become numbers, so string ids that happen
  // to be all-digits (rare, but possible) are never silently retyped.
  if (/Ms$/.test(name) && /^\d+$/.test(t)) return Number(t)
  return raw
}

export function parseConnectorArgs(
  args: string[],
): { ok: true; value: ConnectorArgs } | { ok: false; error: string } {
  const out: ConnectorArgs = {
    subcommand: '',
    positional: [],
    skipValidate: false,
    tokenStdin: false,
    help: false,
    json: false,
    fields: {},
  }
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--token-stdin') {
      out.tokenStdin = true
      continue
    }
    if (arg === '--skip-validate') {
      out.skipValidate = true
      continue
    }
    // Valueless flags — recognized here so they never reach the "flag requires
    // a value" branch below (which assumes every `--flag` takes an argument).
    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }
    if (arg === '--json') {
      out.json = true
      continue
    }
    if (arg.startsWith('--')) {
      let flag = arg
      let value: string | undefined
      const eq = arg.indexOf('=')
      if (eq >= 0) {
        flag = arg.slice(0, eq)
        value = arg.slice(eq + 1)
      } else {
        const next = args[i + 1]
        if (next === undefined || next.startsWith('--')) {
          return { ok: false, error: `${flag} requires a value` }
        }
        value = next
        i++
      }
      const name = flag.slice(2)
      if (name === 'project') {
        out.project = value
        continue
      }
      if (name === 'credential' || name === 'token') {
        out.credential = value
        continue
      }
      if (name === 'id') {
        out.id = value
        continue
      }
      const field = kebabToCamel(name)
      out.fields[field] = coerceFieldValue(field, value)
      continue
    }
    positional.push(arg)
  }
  out.subcommand = positional[0] ?? ''
  out.positional = positional.slice(1)
  return { ok: true, value: out }
}

// ── credential assembly ───────────────────────────────────────────────────

// Build the credential ref from flags + prompts. A single-field provider takes
// one ref (--credential/--token or its primary key flag); a multi-field
// provider (Firebase carries projectId + accessToken) takes one ref per
// required field. Values are stored verbatim: a leading `$` is an env-ref
// pointer, anything else is a literal — the exact rule the daemon resolves by,
// so no transformation happens here.
async function buildCredentialRef(
  dispatch: ProviderFieldSchema,
  args: ConnectorArgs,
  deps: ResolvedDeps,
): Promise<CredentialRef> {
  const hint = 'an env-var reference like $PROVIDER_TOKEN is recommended (stored as a pointer, not the secret); a literal value is stored as-is'
  if (dispatch.requiredCredentialFields.length <= 1) {
    const key = dispatch.primaryCredentialKey
    let value = args.credential
    if (value === undefined && typeof args.fields[key] === 'string') {
      value = args.fields[key] as string
    }
    if (value === undefined && deps.interactive) {
      value = await deps.prompt(`Credential for ${dispatch.provider} (${hint}):`)
    }
    return (value ?? '').trim()
  }
  const out: Record<string, string> = {}
  for (const f of dispatch.requiredCredentialFields) {
    let value: string | undefined
    if (typeof args.fields[f] === 'string') value = args.fields[f] as string
    else if (f === dispatch.primaryCredentialKey && args.credential !== undefined) value = args.credential
    if (value === undefined && deps.interactive) {
      value = await deps.prompt(`Credential field "${f}" for ${dispatch.provider} (${hint}):`)
    }
    out[f] = (value ?? '').trim()
  }
  return out
}

// Whether every required credential field carries a non-empty value.
function credentialComplete(dispatch: ProviderFieldSchema, ref: CredentialRef): string[] {
  if (typeof ref === 'string') {
    return ref.length > 0 ? [] : [dispatch.primaryCredentialKey]
  }
  return dispatch.requiredCredentialFields.filter((f) => !ref[f] || ref[f].length === 0)
}

// ── `add` ─────────────────────────────────────────────────────────────────

async function connectorAdd(
  args: ConnectorArgs,
  deps: ResolvedDeps,
  project: ResolvedCliProject,
): Promise<number> {
  if (project.binding === 'hosted') return hostedConnectorError(deps, 'add')
  // Provider — positional or prompt. Must be a known, built provider.
  let provider = args.positional[0]
  if (!provider && deps.interactive) {
    provider = (await deps.prompt(`Provider (${knownProviderNames().join(', ')}):`)).trim()
  }
  if (!provider) {
    deps.err('neat connector add: a provider is required (e.g. `neat connector add supabase`)')
    return 2
  }
  // Field schema from either table — pull or push (a Vercel drain, ADR-146) —
  // so the credential/option parsing below is identical for both shapes.
  const dispatch = getProviderFieldSchema(provider)
  if (!dispatch) {
    deps.err(
      `neat connector add: unknown provider "${provider}". known providers: ${knownProviderNames().join(', ')}`,
    )
    return 2
  }
  const push = isPushProvider(provider)

  // `--token-stdin` (Newdryve #10): the secret is read here, checked against the
  // provider under a private env name, then stored in the OS keychain; the
  // project file only ever holds `keychain:neat/<provider>/<projectId>`.
  let stdinSecret: string | undefined
  if (args.tokenStdin) {
    if (args.credential !== undefined) {
      deps.err('neat connector add: pass the credential with --token or --token-stdin, not both')
      return 2
    }
    if (dispatch.requiredCredentialFields.length > 1) {
      deps.err(`neat connector add: --token-stdin takes one secret; ${provider} needs ${dispatch.requiredCredentialFields.join(', ')} — pass each as a $VAR reference`)
      return 2
    }
    if (!project.projectId) {
      deps.err('neat connector add: --token-stdin keys the secret by project id, and this project has none yet — run `neat init` first')
      return 2
    }
    stdinSecret = (await deps.readTokenStdin(`${provider} token: `))?.trim()
    if (!stdinSecret) {
      deps.err('neat connector add: --token-stdin read nothing — pipe the token in (e.g. `pbpaste | neat connector add …`)')
      return 2
    }
  }
  const stdinRef = stdinSecret !== undefined && project.projectId ? keychainRef(provider, project.projectId) : undefined

  // Credential + non-secret options.
  const credential = stdinRef ?? (await buildCredentialRef(dispatch, args, deps))
  const options: Record<string, unknown> = { ...args.fields }
  // The credential fields aren't options — strip any that arrived via a
  // generic flag so they don't double-write into `options`.
  for (const k of dispatch.requiredCredentialFields) delete options[k]

  // Prompt for any still-missing required option field (interactive only).
  for (const field of dispatch.requiredOptionFields) {
    if (field in options) continue
    if (!deps.interactive) continue
    const answer = (await deps.prompt(`Option "${field}" for ${provider}:`)).trim()
    if (answer.length > 0) options[field] = coerceFieldValue(field, answer)
  }

  // Structural completeness — caught before any write, even under
  // --skip-validate, so an entry that can never run isn't silently stored.
  const missingCred = credentialComplete(dispatch, credential)
  if (missingCred.length > 0) {
    deps.err(
      `neat connector add: credential is incomplete — missing ${missingCred.join(', ')}. ` +
        'Pass it as a flag (e.g. `--token $PROVIDER_TOKEN`) or run interactively.',
    )
    return 2
  }
  const missingOpts = dispatch.requiredOptionFields.filter((f) => !(f in options))
  if (missingOpts.length > 0) {
    deps.err(
      `neat connector add: missing required option(s) for ${provider}: ${missingOpts.join(', ')}. ` +
        `Pass e.g. \`--${missingOpts[0].replace(/([A-Z])/g, '-$1').toLowerCase()} <value>\`.`,
    )
    return 2
  }

  // Assemble the entry — auto-slug the id unless one was given.
  const existing = await readProjectConnectors(project.root)
  const existingIds = new Set(existing.connectors.map((c) => c.id))
  const id = args.id ?? autoSlugConnectorId(provider, undefined, existingIds)
  const entry: ConnectorEntry = {
    id,
    provider,
    credential,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  }

  // Per-project files are references only — a plaintext secret can't sit in a
  // repo checkout (ADR-273 §0). Catch it before any provider round-trip or write.
  if (!isCredentialRef(credential)) {
    deps.err(
      'neat connector add: a per-project connector credential must be a reference — ' +
        'an env-ref like `$PROVIDER_TOKEN` or a `keychain:…` ref, never a plaintext secret ' +
        '(it would sit in the repo checkout). Re-run with a reference.',
    )
    return 2
  }

  // A --token-stdin secret isn't in the keychain yet: check it through a
  // private env name, and store it only once the provider has accepted it.
  const checkEnv = stdinSecret !== undefined ? { ...deps.env, NEAT_STDIN_TOKEN: stdinSecret } : deps.env
  const checkEntry = stdinSecret !== undefined ? { ...entry, credential: '$NEAT_STDIN_TOKEN' } : entry

  // Validate-on-add by default (contract §4) — a wrong credential fails fast
  // here rather than quietly at the first poll. An unset env-ref is its own
  // distinct outcome, never conflated with a rejected token. A push provider
  // skips this pre-check: its provision step (below) creates the drain, and
  // creating a drain against a custom endpoint validates reachability on
  // Vercel's side already, so a separate round-trip would only double the work.
  if (!push && !args.skipValidate) {
    const outcome = await validateConnectorEntry(checkEntry, checkEnv, deps.fetchImpl)
    const code = reportPreWriteValidation(outcome, deps)
    if (code !== 0) return code
  }

  // Push providers (ADR-146): `add` doesn't just record the entry, it
  // provisions the provider-side resource (the drain) — before the entry is
  // written, so a failed provision leaves nothing behind — and folds the
  // returned handle (drainId) into the entry so `remove` can tear it down.
  if (push) {
    if (args.skipValidate) {
      deps.out('note: --skip-validate has no effect for a push provider — provisioning the drain is the add.')
    }
    const outcome = await provisionConnector(checkEntry, checkEnv, deps.fetchImpl)
    if (outcome.status !== 'ok') {
      deps.err(
        `neat connector add: could not provision the ${provider} connector — ${outcome.reason}. Nothing was written.`,
      )
      return 1
    }
    if (outcome.options) entry.options = { ...(entry.options ?? {}), ...outcome.options }
    if (outcome.note) deps.out(`note: ${outcome.note}`)
  }

  if (stdinSecret !== undefined && project.projectId) {
    try {
      systemKeychain(deps.env).write('neat', `${provider}/${project.projectId}`, stdinSecret)
    } catch (err) {
      deps.err(`neat connector add: ${(err as Error).message}. Nothing was written.`)
      return 1
    }
    deps.out(`stored the token in your keychain as ${stdinRef}.`)
  }

  const { replaced } = await upsertProjectConnectorEntry(entry, project.root)
  const verb = replaced ? 'updated' : 'added'
  deps.out(`${verb} connector "${id}" (${provider}) for this project.`)
  if (push) {
    deps.out("The drain is live — traces arrive at the daemon's OTLP receiver. No poll or restart needed.")
  } else {
    if (args.skipValidate) {
      deps.out('skipped validation (--skip-validate) — the credential is checked at the next daemon poll.')
    }
    deps.out("Restart the project's daemon (or start it) to begin polling this connector.")
  }
  return 0
}

// Turn a pre-write validation outcome into an exit code, printing the distinct
// message each case warrants. 0 means proceed to write.
function reportPreWriteValidation(outcome: ValidateOutcome, deps: ResolvedDeps): number {
  switch (outcome.status) {
    case 'ok':
      deps.out('credential validated against the provider.')
      return 0
    case 'unset-env':
      deps.err(
        `neat connector add: ${outcome.reason}. Export the variable before adding, ` +
          'or pass --skip-validate to add now and set it before the daemon runs.',
      )
      return 1
    case 'rejected':
      deps.err(
        `neat connector add: the provider rejected the credential — ${outcome.reason}. ` +
          'Nothing was written. Fix the credential, or pass --skip-validate to store it anyway.',
      )
      return 1
    case 'missing-field':
      deps.err(`neat connector add: ${outcome.reason}.`)
      return 2
    case 'unknown-provider':
      deps.err(`neat connector add: ${outcome.reason}.`)
      return 2
  }
}

// ── `list` ────────────────────────────────────────────────────────────────

async function connectorList(deps: ResolvedDeps, project: ResolvedCliProject, json = false): Promise<number> {
  if (project.binding === 'hosted') {
    const note = 'this project is hosted — its connectors are managed in the control plane, not a local file.'
    deps.out(json ? JSON.stringify({ binding: 'hosted', connectors: [], note }, null, 2) : note)
    return 0
  }
  const entries = (await readProjectConnectors(project.root)).connectors
  // Legacy machine-level entries not yet assigned to a project (ADR-273 §0
  // migration) — surfaced, never silently dropped.
  const legacy = await readLegacyConnectors(deps)

  const credParts = (e: ConnectorEntry): string =>
    describeCredential(e.credential, deps.env)
      .map((c) => {
        const status = c.status ? ` (${c.status})` : c.kind === 'plaintext' ? ' (plaintext)' : ''
        return c.field ? `${c.field}=${c.display}${status}` : `${c.display}${status}`
      })
      .join(', ')

  // Machine-readable (--json). Credentials stay redacted — the pointer/`****`,
  // never a resolved secret (§6); `options` is safe verbatim.
  if (json) {
    const row = (e: ConnectorEntry): Record<string, unknown> => ({
      id: e.id,
      provider: e.provider,
      kind: isPushProvider(e.provider) ? 'push' : 'pull',
      credential: describeCredential(e.credential, deps.env).map((c) => ({
        ...(c.field ? { field: c.field } : {}),
        ref: c.display,
        ...(c.status ? { status: c.status } : { kind: c.kind }),
      })),
      ...(e.options ? { options: e.options } : {}),
    })
    deps.out(
      JSON.stringify(
        { connectors: entries.map(row), unassigned: legacy.map((e) => ({ ...row(e), wasProject: e.project ?? null })) },
        null,
        2,
      ),
    )
    return 0
  }

  if (entries.length === 0) {
    deps.out('no connectors configured for this project. run `neat connector add <provider>` to add one.')
  } else {
    deps.out('id\tprovider\tcredential')
    for (const e of entries) deps.out(`${e.id}\t${e.provider}\t${credParts(e)}`)
  }

  if (legacy.length > 0) {
    deps.out('')
    deps.out(
      `unassigned (legacy ${connectorsConfigPath(deps.home)}) — run \`neat connector assign <id>\` to move one into this project:`,
    )
    for (const e of legacy) deps.out(`  ${e.id}\t${e.provider}\t(was project: ${e.project ?? 'none'})`)
  }
  return 0
}

// The machine-level connectors.json, read for migration display (ADR-273 §0).
// A missing file is the common case → no legacy entries. Never resolves a secret.
async function readLegacyConnectors(deps: ResolvedDeps): Promise<ConnectorEntry[]> {
  try {
    return (await readConnectorsConfig(deps.home)).connectors
  } catch {
    return []
  }
}

// ── `remove` ──────────────────────────────────────────────────────────────

async function connectorRemove(
  deps: ResolvedDeps,
  project: ResolvedCliProject,
  id: string | undefined,
): Promise<number> {
  if (project.binding === 'hosted') return hostedConnectorError(deps, 'remove')
  if (!id) {
    deps.err('neat connector remove: missing <id>. run `neat connector list` to see configured ids.')
    return 2
  }
  // Read first: a push provider's drain must be torn down before the entry is
  // dropped, so a live drain is never orphaned from its config (connectors.md
  // §9). deprovision is idempotent, so retrying after a partial failure is safe.
  const config = await readProjectConnectors(project.root)
  const entry = config.connectors.find((c) => c.id === id)
  if (!entry) {
    deps.err(`neat connector remove: no connector with id "${id}". run \`neat connector list\` to see configured ids.`)
    return 1
  }
  if (isPushProvider(entry.provider)) {
    const outcome = await deprovisionConnector(entry, deps.env, deps.fetchImpl)
    if (outcome.status !== 'ok') {
      deps.err(
        `neat connector remove: could not delete the ${entry.provider} drain — ${outcome.reason}. ` +
          'The entry was kept so you can retry (or delete the drain in the Vercel dashboard, then re-run).',
      )
      return 1
    }
    if (outcome.note) deps.out(`note: ${outcome.note}`)
  }

  const removed = await removeProjectConnectorEntry(id, project.root)
  if (!removed) {
    deps.err(`neat connector remove: no connector with id "${id}". run \`neat connector list\` to see configured ids.`)
    return 1
  }
  deps.out(`removed connector "${id}" (${removed.provider}).`)
  return 0
}

// ── `test` ────────────────────────────────────────────────────────────────

async function connectorTest(
  deps: ResolvedDeps,
  project: ResolvedCliProject,
  id: string | undefined,
): Promise<number> {
  if (project.binding === 'hosted') return hostedConnectorError(deps, 'test')
  if (!id) {
    deps.err('neat connector test: missing <id>. run `neat connector list` to see configured ids.')
    return 2
  }
  const config = await readProjectConnectors(project.root)
  const entry = config.connectors.find((c) => c.id === id)
  if (!entry) {
    deps.err(`neat connector test: no connector with id "${id}". run \`neat connector list\` to see configured ids.`)
    return 1
  }
  const outcome = await validateConnectorEntry(entry, deps.env, deps.fetchImpl)
  switch (outcome.status) {
    case 'ok':
      deps.out(`ok: "${id}" (${entry.provider}) authenticated against the provider.`)
      return 0
    case 'unset-env':
      deps.err(`unset: "${id}" (${entry.provider}) — ${outcome.reason}. Export the variable so the daemon can resolve it.`)
      return 1
    case 'rejected':
      deps.err(`rejected: "${id}" (${entry.provider}) — ${outcome.reason}.`)
      return 1
    case 'missing-field':
      deps.err(`incomplete: "${id}" (${entry.provider}) — ${outcome.reason}.`)
      return 2
    case 'unknown-provider':
      deps.err(`unknown provider: "${id}" — ${outcome.reason}.`)
      return 2
  }
}

// ── `assign` ───────────────────────────────────────────────────────────────

// Migration (ADR-273 §0): move a legacy machine-level connector into this
// project's file. The machine-level `~/.neat/connectors.json` is read but never
// written — read-once-to-migrate — so a second project can still claim its own
// entries and nothing is destroyed out from under a daemon not yet re-pointed.
// Refs-only still holds: a plaintext legacy credential can't be copied into a
// project file that lives in the checkout.
async function connectorAssign(
  deps: ResolvedDeps,
  project: ResolvedCliProject,
  id: string | undefined,
): Promise<number> {
  if (project.binding === 'hosted') return hostedConnectorError(deps, 'assign')
  if (!id) {
    deps.err('neat connector assign: missing <id>. run `neat connector list` to see unassigned ids.')
    return 2
  }
  const entry = (await readLegacyConnectors(deps)).find((c) => c.id === id)
  if (!entry) {
    deps.err(
      `neat connector assign: no unassigned connector with id "${id}". ` +
        'run `neat connector list` to see what can be assigned.',
    )
    return 1
  }
  if (!isCredentialRef(entry.credential)) {
    deps.err(
      `neat connector assign: "${id}" stores a plaintext secret, which a project file (committed in your ` +
        'checkout) must never hold. Re-add it with an env-ref (`$VAR`) or a `keychain:…` ref instead.',
    )
    return 2
  }
  const { replaced } = await upsertProjectConnectorEntry(entry, project.root)
  deps.out(
    `${replaced ? 'reassigned' : 'assigned'} connector "${id}" (${entry.provider}) to this project. ` +
      `The machine-level entry in ${connectorsConfigPath(deps.home)} was left in place — ` +
      'remove it there once no other project needs it.',
  )
  return 0
}

// ── dispatch ──────────────────────────────────────────────────────────────

export function printConnectorUsage(write: (line: string) => void): void {
  write('usage: neat connector <add|list|remove|test|assign> [args]')
  write('  connectors are scoped to the project at or above the current directory')
  write('  (.neat/connectors.json); --project <path> targets a different checkout')
  write(`  providers:        ${knownProviderNames().join(', ')}`)
  write('                    pull (polled): supabase, railway, firebase, cloudflare, neon')
  write('                    push (drains): vercel — provisions a Vercel trace Drain that forwards')
  write("                                   traces to the daemon's OTLP receiver; no app instrumentation")
  write('  add <provider>    add a connector to this project; validates the credential first')
  write('                    credentials are references only: `$VAR` or `keychain:…`, never a raw secret')
  write('                    flags: --credential/--token <$VAR|keychain:…>  --id <id>')
  write('                    --token-stdin  read the token from a pipe (or a no-echo prompt),')
  write('                                   keep it in your OS keychain, write only the reference')
  write('                           --<option> <value> (provider-specific)  --skip-validate')
  write('                    vercel: neat connector add vercel --token $VERCEL_TOKEN \\')
  write('                              --otel-token $NEAT_OTEL_TOKEN --team-id <teamId> \\')
  write('                              --endpoint https://<public-host>/v1/traces [--project-ids <id,id>]')
  write('                    neon: neat connector add neon --credential $NEON_OBSERVER_URL \\')
  write('                            --project-id <projectId> --service-name <serviceName>')
  write("  list              list this project's connectors (credentials shown redacted); also lists")
  write('                    legacy machine-level entries awaiting `assign`')
  write('  remove <id>       remove a connector by id (a push provider also has its drain deleted)')
  write('  test <id>         re-run validation for an existing connector (a push provider re-tests its drain)')
  write('  assign <id>       move a legacy ~/.neat connector into this project (migration)')
}

/**
 * Entry point the CLI wires `neat connector …` to. `rawArgs` is argv past the
 * `connector` token. Returns a process exit code; never calls `process.exit`
 * itself so the caller (and tests) own control flow.
 */
export async function runConnectorCommand(
  rawArgs: string[],
  deps: ConnectorCliDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps)
  const parsed = parseConnectorArgs(rawArgs)
  if (!parsed.ok) {
    resolved.err(`neat connector: ${parsed.error}`)
    return 2
  }
  const a = parsed.value
  // `--help`/`-h` anywhere (with or without a subcommand) prints usage on
  // stdout and exits 0 — the instinctive `neat connector [add] --help` path.
  if (a.help) {
    printConnectorUsage(resolved.out)
    return 0
  }
  if (a.subcommand === '') {
    resolved.err('neat connector: missing subcommand.')
    printConnectorUsage(resolved.err)
    return 2
  }
  if (!['add', 'list', 'remove', 'test', 'assign'].includes(a.subcommand)) {
    resolved.err(`neat connector: unknown subcommand "${a.subcommand}".`)
    printConnectorUsage(resolved.err)
    return 2
  }
  // Every subcommand is project-scoped (ADR-273): resolve the project once, up
  // front, so a directory that is not a NEAT project errors before any handler
  // touches a file — never a silent fall-through to a global write.
  const proj = await resolveCliProject(a, resolved)
  if (!proj.ok) return proj.code
  const project = proj.project
  switch (a.subcommand) {
    case 'add':
      return connectorAdd(a, resolved, project)
    case 'list':
      return connectorList(resolved, project, a.json)
    case 'remove':
      return connectorRemove(resolved, project, a.positional[0])
    case 'test':
      return connectorTest(resolved, project, a.positional[0])
    case 'assign':
      return connectorAssign(resolved, project, a.positional[0])
    default:
      return 2
  }
}

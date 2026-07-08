// `neat connector add/list/remove/test` — the write side of the connector
// on-ramp (docs/contracts/connector-config.md §3, ADR-130).
//
// This is the one command a human runs to turn a built connector on for a
// registered project. It sits on top of the read side that already shipped
// (#730): connectors-config.ts owns reading and writing
// `~/.neat/connectors.json` (atomic, `0600`, flock, env-ref resolution), and
// connectors/registry.ts owns the provider dispatch table (factory, required-
// field schema) plus the validate round-trip. This module only orchestrates:
// it gathers a provider's fields from flags and interactive prompts, runs
// validate-on-add through the connector's own auth path by default, and hands
// a finished entry to the config writer. It never resolves a secret to disk
// and never prints a resolved one — the default credential form is a pointer
// (`$VAR`), and even a listing shows the pointer or `****`, never the value.
//
// `neat connector` is a new top-level command family, not an eleventh query
// verb (contract §3) — same mutation/config category as init / sync / deploy,
// outside the locked ten-verb query set.

import { createInterface } from 'node:readline/promises'
import {
  EnvRefUnsetError,
  readConnectorsConfig,
  removeConnectorEntry,
  upsertConnectorEntry,
  type ConnectorEntry,
  type CredentialRef,
} from './connectors-config.js'
import {
  ConnectorConfigError,
  getProviderDispatch,
  PROVIDER_DISPATCH,
  validateConnector,
  type ProviderDispatch,
  type ValidateConnectorOptions,
} from './connectors/registry.js'

// A prompt asks one question and returns the trimmed answer, falling back to
// `default` on an empty line. Injected in tests so an interactive flow runs
// without a TTY; the real one (below) reads a line off stdin.
export type PromptFn = (question: string, opts?: { default?: string }) => Promise<string>

export interface ConnectorCliDeps {
  // Present → the command may prompt for a missing field. Absent → any missing
  // required field is a misuse error instead of a hang (the CI / no-TTY case).
  prompt?: PromptFn
  // Defaults to the real registry round-trip; injected in tests to drive the
  // ok / unset-env / rejected outcomes without a live provider account.
  validate?: (entry: ConnectorEntry, options?: ValidateConnectorOptions) => Promise<void>
  // Resolved NEAT_HOME; defaults to the env-based resolution in
  // connectors-config.ts. Threaded so tests point at a temp home directly.
  home?: string
}

// ── flag parsing ───────────────────────────────────────────────────────────

interface ParsedConnectorFlags {
  positionals: string[]
  // Every `--name value` / `--name=value` pair, keyed by name. Provider option
  // and credential flags are dynamic (they vary per provider), so the parse is
  // generic rather than a fixed table.
  flags: Record<string, string>
  // `--option key=value`, repeatable.
  optionPairs: string[]
  skipValidate: boolean
  json: boolean
  yes: boolean
}

class MisuseError extends Error {}

function parseConnectorFlags(args: string[]): ParsedConnectorFlags {
  const out: ParsedConnectorFlags = {
    positionals: [],
    flags: {},
    optionPairs: [],
    skipValidate: false,
    json: false,
    yes: false,
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--skip-validate') { out.skipValidate = true; continue }
    if (a === '--json') { out.json = true; continue }
    if (a === '--yes' || a === '-y') { out.yes = true; continue }
    if (a.startsWith('--')) {
      const body = a.slice(2)
      let name: string
      let value: string
      const eq = body.indexOf('=')
      if (eq >= 0) {
        name = body.slice(0, eq)
        value = body.slice(eq + 1)
      } else {
        name = body
        const next = args[i + 1]
        if (next === undefined) throw new MisuseError(`--${name} requires a value`)
        value = next
        i++
      }
      if (name === 'option') out.optionPairs.push(value)
      else out.flags[name] = value
      continue
    }
    out.positionals.push(a)
  }
  return out
}

// camelCase option/credential key → the kebab flag that sets it. `accountId`
// becomes `--account-id`, `serviceNameById` becomes `--service-name-by-id`.
function toKebabFlag(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

// A suggested env-var name for a credential field — the default the credential
// prompt offers, so pressing Enter stores a pointer rather than a secret.
// `supabase` + `managementToken` → `$SUPABASE_MANAGEMENT_TOKEN`.
function suggestEnvRef(provider: string, field: string): string {
  const snake = field.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return `$${provider}_${snake}`.replace(/[^a-z0-9$]+/gi, '_').toUpperCase()
}

// A flag/option value can be a plain string, a number (intervalMs), a boolean,
// or JSON (workers / serviceNameById / functions maps). Parse the shape the
// value announces; fall back to the raw string.
function parseScalarOrJson(raw: string): unknown {
  const t = raw.trim()
  if (t.length === 0) return raw
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.parse(t) } catch { return raw }
  }
  if (/^-?\d+$/.test(t)) return Number(t)
  if (t === 'true') return true
  if (t === 'false') return false
  return raw
}

// ── credential handling ─────────────────────────────────────────────────────

// A provider is multi-field when its required credential keys are anything
// other than the single primary key (Firebase: projectId + accessToken).
function isMultiFieldCredential(dispatch: ProviderDispatch): boolean {
  const req = dispatch.requiredCredentialFields
  return !(req.length === 1 && req[0] === dispatch.primaryCredentialKey)
}

async function resolveOneCredentialRef(
  provider: string,
  field: string,
  flagValue: string | undefined,
  prompt: PromptFn | undefined,
): Promise<string> {
  if (flagValue !== undefined) return flagValue
  const suggestion = suggestEnvRef(provider, field)
  if (!prompt) {
    throw new MisuseError(
      `missing credential "${field}" — pass --credential-${toKebabFlag(field)} ${suggestion} (or run interactively)`,
    )
  }
  // Env-ref is the default: the prompt offers `$VAR`, so an empty line stores
  // a pointer. Typing a literal secret is the explicit plaintext opt-in.
  const answer = await prompt(
    `Credential for ${provider} "${field}" — an env-var reference like ${suggestion}, or a literal secret to store as plaintext`,
    { default: suggestion },
  )
  return answer.length > 0 ? answer : suggestion
}

async function gatherCredential(
  dispatch: ProviderDispatch,
  flags: Record<string, string>,
  prompt: PromptFn | undefined,
): Promise<CredentialRef> {
  const provider = dispatch.provider
  if (!isMultiFieldCredential(dispatch)) {
    const key = dispatch.primaryCredentialKey
    const flagValue =
      flags['credential'] ?? flags['token'] ?? flags[`credential-${toKebabFlag(key)}`]
    return resolveOneCredentialRef(provider, key, flagValue, prompt)
  }
  const out: Record<string, string> = {}
  for (const field of dispatch.requiredCredentialFields) {
    const flagValue = flags[`credential-${toKebabFlag(field)}`]
    out[field] = await resolveOneCredentialRef(provider, field, flagValue, prompt)
  }
  return out
}

// ── options handling ─────────────────────────────────────────────────────────

async function gatherOptions(
  dispatch: ProviderDispatch,
  parsed: ParsedConnectorFlags,
  prompt: PromptFn | undefined,
): Promise<Record<string, unknown>> {
  const options: Record<string, unknown> = {}

  // A whole-object escape hatch first, then per-key overrides layered on top.
  if (parsed.flags['options'] !== undefined) {
    let base: unknown
    try { base = JSON.parse(parsed.flags['options']) } catch (err) {
      throw new MisuseError(`--options must be valid JSON: ${(err as Error).message}`)
    }
    if (typeof base !== 'object' || base === null || Array.isArray(base)) {
      throw new MisuseError('--options must be a JSON object')
    }
    Object.assign(options, base)
  }
  for (const pair of parsed.optionPairs) {
    const eq = pair.indexOf('=')
    if (eq < 0) throw new MisuseError(`--option must be key=value, got "${pair}"`)
    options[pair.slice(0, eq)] = parseScalarOrJson(pair.slice(eq + 1))
  }

  // Fill each required option field that flags didn't already supply.
  for (const field of dispatch.requiredOptionFields) {
    if (field in options) continue
    const flagValue = parsed.flags[toKebabFlag(field)]
    if (flagValue !== undefined) {
      options[field] = parseScalarOrJson(flagValue)
      continue
    }
    if (!prompt) {
      throw new MisuseError(
        `missing required option "${field}" for ${dispatch.provider} — pass --${toKebabFlag(field)} <value> (or run interactively)`,
      )
    }
    const answer = await prompt(`${dispatch.provider} option "${field}" (JSON accepted for object values)`, {})
    options[field] = parseScalarOrJson(answer)
  }
  return options
}

// ── id auto-slug ──────────────────────────────────────────────────────────────

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Auto-slug from the provider, disambiguated by project when the plain slug is
// taken, then by a numeric suffix (contract §1).
function autoSlugId(provider: string, project: string | undefined, taken: Set<string>): string {
  if (!taken.has(provider)) return provider
  if (project) {
    const withProject = `${provider}-${slugify(project)}`
    if (!taken.has(withProject)) return withProject
  }
  let n = 2
  while (taken.has(`${provider}-${n}`)) n++
  return `${provider}-${n}`
}

// ── redaction (list / confirmations never print a resolved secret) ───────────

interface RefStatus {
  // What's safe to show: the `$VAR` pointer, or `****` for a stored literal.
  display: string
  // 'env-set' / 'env-unset' for a pointer; 'plaintext' for a stored literal.
  kind: 'env-set' | 'env-unset' | 'plaintext'
}

function classifyRef(ref: string, env: NodeJS.ProcessEnv): RefStatus {
  if (ref.length > 1 && ref.startsWith('$')) {
    const name = ref.slice(1)
    const value = env[name]
    const set = value !== undefined && value.length > 0
    return { display: ref, kind: set ? 'env-set' : 'env-unset' }
  }
  return { display: '****', kind: 'plaintext' }
}

function redactCredential(
  credential: CredentialRef,
  env: NodeJS.ProcessEnv,
): { display: string; statuses: RefStatus[] } {
  if (typeof credential === 'string') {
    const s = classifyRef(credential, env)
    return { display: s.display, statuses: [s] }
  }
  const parts: string[] = []
  const statuses: RefStatus[] = []
  for (const [field, ref] of Object.entries(credential)) {
    const s = classifyRef(ref, env)
    parts.push(`${field}=${s.display}`)
    statuses.push(s)
  }
  return { display: `{ ${parts.join(', ')} }`, statuses }
}

function statusLabel(statuses: RefStatus[]): string {
  if (statuses.some((s) => s.kind === 'env-unset')) return 'env unset'
  if (statuses.every((s) => s.kind === 'plaintext')) return 'plaintext'
  if (statuses.some((s) => s.kind === 'plaintext')) return 'mixed'
  return 'env set'
}

// ── outcome messaging for validate (shared by add + test) ────────────────────

type ValidateOutcome =
  | { status: 'ok' }
  | { status: 'unset-env'; message: string }
  | { status: 'config'; message: string }
  | { status: 'rejected'; message: string }

async function runValidate(
  entry: ConnectorEntry,
  deps: ConnectorCliDeps,
): Promise<ValidateOutcome> {
  const validate = deps.validate ?? validateConnector
  try {
    await validate(entry, {})
    return { status: 'ok' }
  } catch (err) {
    if (err instanceof EnvRefUnsetError) return { status: 'unset-env', message: err.message }
    if (err instanceof ConnectorConfigError) return { status: 'config', message: err.message }
    return { status: 'rejected', message: (err as Error).message }
  }
}

// ── subcommands ──────────────────────────────────────────────────────────────

const KNOWN_PROVIDERS = Object.keys(PROVIDER_DISPATCH).sort()

async function resolveProvider(
  positional: string | undefined,
  prompt: PromptFn | undefined,
): Promise<ProviderDispatch> {
  let name = positional
  if (!name) {
    if (!prompt) {
      throw new MisuseError(`missing <provider> — one of: ${KNOWN_PROVIDERS.join(', ')}`)
    }
    name = (await prompt(`Provider (one of: ${KNOWN_PROVIDERS.join(', ')})`, {})).trim()
  }
  const dispatch = getProviderDispatch(name)
  if (!dispatch) {
    throw new MisuseError(`unknown provider "${name}" — known providers: ${KNOWN_PROVIDERS.join(', ')}`)
  }
  return dispatch
}

async function connectorAdd(parsed: ParsedConnectorFlags, deps: ConnectorCliDeps): Promise<number> {
  const dispatch = await resolveProvider(parsed.positionals[0], deps.prompt)
  const provider = dispatch.provider

  // Project is optional — an omitted project binds the connector to whichever
  // project the daemon bootstraps (contract §1). Only prompt when interactive.
  let project = parsed.flags['project']
  if (project === undefined && deps.prompt) {
    const answer = (await deps.prompt('Project name (blank binds to whatever project the daemon runs)', {})).trim()
    if (answer.length > 0) project = answer
  }

  const credential = await gatherCredential(dispatch, parsed.flags, deps.prompt)
  const options = await gatherOptions(dispatch, parsed, deps.prompt)

  const config = await readConnectorsConfig(deps.home)
  const taken = new Set(config.connectors.map((c) => c.id))
  const id = parsed.flags['id'] ?? autoSlugId(provider, project, taken)

  const entry: ConnectorEntry = {
    id,
    provider,
    ...(project ? { project } : {}),
    credential,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  }

  // Validate-on-add by default — a wrong credential fails here, before the
  // entry is written, so it never surfaces quietly at the first poll (§4).
  if (!parsed.skipValidate) {
    const outcome = await runValidate(entry, deps)
    if (outcome.status === 'unset-env') {
      // Distinct from a validation failure: the token isn't wrong, the env var
      // just isn't exported yet (§4). Nothing is written.
      console.error(`neat connector add: ${outcome.message}`)
      console.error(
        `The credential points at an environment variable that isn't set. ` +
          `Export it and re-run, or pass --skip-validate to add now and populate it before the daemon runs.`,
      )
      return 1
    }
    if (outcome.status === 'config') {
      console.error(`neat connector add: ${outcome.message}`)
      return 2
    }
    if (outcome.status === 'rejected') {
      console.error(`neat connector add: ${provider} rejected the credential — ${outcome.message}`)
      console.error('Fix the credential (or pass --skip-validate to add without checking).')
      return 1
    }
  }

  const { replaced } = await upsertConnectorEntry(entry, deps.home)

  const { display } = redactCredential(credential, process.env)
  const verb = replaced ? 'updated' : 'added'
  console.log(`${verb} connector "${id}" (${provider}${project ? `, project ${project}` : ''})`)
  console.log(`  credential: ${display}`)
  if (parsed.skipValidate) {
    console.log('  validation skipped (--skip-validate) — the daemon checks the credential at its next poll.')
  } else {
    console.log(`  validated: ${provider} accepted the credential.`)
  }
  console.log('Restart the project daemon to start polling this connector.')
  return 0
}

async function connectorList(parsed: ParsedConnectorFlags, deps: ConnectorCliDeps): Promise<number> {
  const config = await readConnectorsConfig(deps.home)
  const filter = parsed.flags['project']
  const entries = filter
    ? config.connectors.filter((c) => c.project === filter)
    : config.connectors

  if (parsed.json) {
    // Machine-readable, and still redacted — a resolved secret never leaves
    // this process, JSON or not.
    const rows = entries.map((c) => {
      const { display, statuses } = redactCredential(c.credential, process.env)
      return {
        id: c.id,
        provider: c.provider,
        ...(c.project ? { project: c.project } : {}),
        credential: display,
        credentialStatus: statusLabel(statuses),
      }
    })
    console.log(JSON.stringify(rows, null, 2))
    return 0
  }

  if (entries.length === 0) {
    console.log(
      filter
        ? `no connectors configured for project "${filter}".`
        : 'no connectors configured. run `neat connector add <provider>` to add one.',
    )
    return 0
  }
  for (const c of entries) {
    const { display, statuses } = redactCredential(c.credential, process.env)
    const project = c.project ?? '(any project)'
    console.log(`${c.id}\t${c.provider}\t${project}\t${display}\t[${statusLabel(statuses)}]`)
  }
  return 0
}

async function connectorRemove(parsed: ParsedConnectorFlags, deps: ConnectorCliDeps): Promise<number> {
  const id = parsed.positionals[0]
  if (!id) throw new MisuseError('missing <id> — run `neat connector list` to see configured ids')
  const removed = await removeConnectorEntry(id, deps.home)
  if (!removed) {
    console.error(`neat connector remove: no connector with id "${id}".`)
    return 1
  }
  console.log(`removed connector "${id}" (${removed.provider}).`)
  return 0
}

async function connectorTest(parsed: ParsedConnectorFlags, deps: ConnectorCliDeps): Promise<number> {
  const id = parsed.positionals[0]
  if (!id) throw new MisuseError('missing <id> — run `neat connector list` to see configured ids')
  const config = await readConnectorsConfig(deps.home)
  const entry = config.connectors.find((c) => c.id === id)
  if (!entry) {
    console.error(`neat connector test: no connector with id "${id}".`)
    return 1
  }

  const outcome = await runValidate(entry, deps)
  if (outcome.status === 'ok') {
    console.log(`ok: "${id}" (${entry.provider}) — the provider accepted the credential.`)
    return 0
  }
  if (outcome.status === 'unset-env') {
    console.error(`neat connector test: ${outcome.message}`)
    console.error('The credential points at an environment variable that is not set — export it and re-run.')
    return 1
  }
  if (outcome.status === 'config') {
    console.error(`neat connector test: ${outcome.message}`)
    return 2
  }
  console.error(`neat connector test: ${entry.provider} rejected the credential — ${outcome.message}`)
  return 1
}

// ── entry point ──────────────────────────────────────────────────────────────

function printConnectorUsage(): void {
  console.log('usage: neat connector <add|list|remove|test> [args]')
  console.log('')
  console.log('  add <provider>     Add a connector. Prompts for missing fields, or takes them as flags.')
  console.log(`                     providers: ${KNOWN_PROVIDERS.join(', ')}`)
  console.log('                     Flags: --project <name>  --id <id>')
  console.log('                            --credential <$VAR|secret>  (alias --token; --credential-<field> for multi-field)')
  console.log('                            --<option> <value>  --option key=value  --options <json>')
  console.log('                            --skip-validate   add without the auth round-trip')
  console.log('                     A credential defaults to an env-var reference ($VAR); a literal value is stored plaintext.')
  console.log('  list               List configured connectors (credentials shown redacted). Flags: --project <name>  --json')
  console.log('  remove <id>        Remove a connector by id.')
  console.log('  test <id>          Re-run the auth round-trip against a configured connector.')
}

/**
 * `neat connector ...` — args are the tokens after `connector`. Returns a
 * process exit code (0 ok, 1 failure, 2 misuse) so the CLI dispatcher can
 * `process.exit` on it, matching the query verbs.
 */
export async function runConnectorCommand(
  args: string[],
  deps: ConnectorCliDeps = {},
): Promise<number> {
  const sub = args[0]
  if (!sub || sub === '-h' || sub === '--help') {
    printConnectorUsage()
    return sub ? 0 : 2
  }

  // Prompting is available only on a real TTY unless a prompt was injected
  // (tests). Off a TTY with no flags, a missing field is a clear misuse error
  // rather than a hung read.
  const resolvedDeps: ConnectorCliDeps = {
    ...deps,
    prompt: deps.prompt ?? (process.stdin.isTTY ? defaultPrompt : undefined),
  }

  let parsed: ParsedConnectorFlags
  try {
    parsed = parseConnectorFlags(args.slice(1))
  } catch (err) {
    if (err instanceof MisuseError) {
      console.error(`neat connector ${sub}: ${err.message}`)
      return 2
    }
    throw err
  }

  try {
    switch (sub) {
      case 'add': return await connectorAdd(parsed, resolvedDeps)
      case 'list': return await connectorList(parsed, resolvedDeps)
      case 'remove': return await connectorRemove(parsed, resolvedDeps)
      case 'test': return await connectorTest(parsed, resolvedDeps)
      default:
        console.error(`neat connector: unknown subcommand "${sub}"`)
        printConnectorUsage()
        return 2
    }
  } catch (err) {
    if (err instanceof MisuseError) {
      console.error(`neat connector ${sub}: ${err.message}`)
      return 2
    }
    console.error(`neat connector ${sub}: ${(err as Error).message}`)
    return 1
  }
}

// Real interactive prompt — one line off stdin, with a bracketed default an
// empty answer falls back to. Only wired when stdin is a TTY.
const defaultPrompt: PromptFn = async (question, opts) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = opts?.default ? ` [${opts.default}]` : ''
    const answer = (await rl.question(`${question}${suffix}: `)).trim()
    return answer.length === 0 && opts?.default ? opts.default : answer
  } finally {
    rl.close()
  }
}

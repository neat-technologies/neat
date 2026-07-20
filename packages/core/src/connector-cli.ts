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
  describeCredential,
  isEnvRef,
  readConnectorsConfig,
  removeConnectorEntry,
  upsertConnectorEntry,
  type ConnectorEntry,
  type CredentialRef,
} from './connectors-config.js'
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
  // NEAT_HOME override. Undefined uses connectors-config.ts's own env-based
  // resolution (the real CLI); tests pass a temp home.
  home?: string
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
  out?: (line: string) => void
  err?: (line: string) => void
}

interface ResolvedDeps {
  home: string | undefined
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  prompt: (question: string) => Promise<string>
  interactive: boolean
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
    env: deps.env ?? process.env,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    prompt: deps.prompt ?? defaultPrompt,
    interactive: deps.interactive ?? Boolean(process.stdin.isTTY),
    out: deps.out ?? ((l) => console.log(l)),
    err: deps.err ?? ((l) => console.error(l)),
  }
}

// ── argument parsing ──────────────────────────────────────────────────────

export interface ConnectorArgs {
  subcommand: string
  positional: string[]
  project?: string
  // Single-field credential from --credential / --token (an env-ref or a
  // literal). Multi-field providers read their fields from `fields` instead.
  credential?: string
  id?: string
  skipValidate: boolean
  plaintext: boolean
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
    plaintext: false,
    fields: {},
  }
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--skip-validate') {
      out.skipValidate = true
      continue
    }
    if (arg === '--plaintext') {
      out.plaintext = true
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

// The plaintext (non-env-ref) fields in a credential — the ones that put a
// secret at rest and so warrant the opt-in warning.
function plaintextFields(ref: CredentialRef): string[] {
  if (typeof ref === 'string') return isEnvRef(ref) ? [] : ['credential']
  return Object.entries(ref)
    .filter(([, v]) => !isEnvRef(v))
    .map(([k]) => k)
}

// ── `add` ─────────────────────────────────────────────────────────────────

async function connectorAdd(args: ConnectorArgs, deps: ResolvedDeps): Promise<number> {
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

  // Project — optional; blank binds to whatever project the daemon bootstraps.
  let project = args.project
  if (project === undefined && deps.interactive) {
    const answer = (await deps.prompt('Project (blank = the project the daemon is bootstrapping):')).trim()
    if (answer.length > 0) project = answer
  }

  // Credential + non-secret options.
  const credential = await buildCredentialRef(dispatch, args, deps)
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
  const existing = await readConnectorsConfig(deps.home)
  const existingIds = new Set(existing.connectors.map((c) => c.id))
  const id = args.id ?? autoSlugConnectorId(provider, project, existingIds)
  const entry: ConnectorEntry = {
    id,
    provider,
    ...(project ? { project } : {}),
    credential,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  }

  // Validate-on-add by default (contract §4) — a wrong credential fails fast
  // here rather than quietly at the first poll. An unset env-ref is its own
  // distinct outcome, never conflated with a rejected token. A push provider
  // skips this pre-check: its provision step (below) creates the drain, and
  // creating a drain against a custom endpoint validates reachability on
  // Vercel's side already, so a separate round-trip would only double the work.
  if (!push && !args.skipValidate) {
    const outcome = await validateConnectorEntry(entry, deps.env, deps.fetchImpl)
    const code = reportPreWriteValidation(outcome, deps)
    if (code !== 0) return code
  }

  // Plaintext is the explicit opt-in; surface it so a secret never lands at
  // rest by accident (contract §2).
  const plaintext = plaintextFields(credential)
  if (plaintext.length > 0 && !args.plaintext) {
    deps.err(
      `neat connector add: storing a literal secret at rest for ${plaintext.join(', ')} — ` +
        'prefer an env-var reference like `$PROVIDER_TOKEN` (pass --plaintext to silence this).',
    )
  }

  // Push providers (ADR-146): `add` doesn't just record the entry, it
  // provisions the provider-side resource (the drain) — before the entry is
  // written, so a failed provision leaves nothing behind — and folds the
  // returned handle (drainId) into the entry so `remove` can tear it down.
  if (push) {
    if (args.skipValidate) {
      deps.out('note: --skip-validate has no effect for a push provider — provisioning the drain is the add.')
    }
    const outcome = await provisionConnector(entry, deps.env, deps.fetchImpl)
    if (outcome.status !== 'ok') {
      deps.err(
        `neat connector add: could not provision the ${provider} connector — ${outcome.reason}. Nothing was written.`,
      )
      return 1
    }
    if (outcome.options) entry.options = { ...(entry.options ?? {}), ...outcome.options }
    if (outcome.note) deps.out(`note: ${outcome.note}`)
  }

  const { replaced } = await upsertConnectorEntry(entry, deps.home)
  const verb = replaced ? 'updated' : 'added'
  const where = project ? `project "${project}"` : 'the bootstrapping project'
  deps.out(`${verb} connector "${id}" (${provider}) for ${where}.`)
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

async function connectorList(deps: ResolvedDeps, filterProject?: string): Promise<number> {
  const config = await readConnectorsConfig(deps.home)
  let entries = config.connectors
  if (filterProject) entries = entries.filter((e) => e.project === filterProject)
  if (entries.length === 0) {
    deps.out(
      filterProject
        ? `no connectors configured for project "${filterProject}".`
        : 'no connectors configured. run `neat connector add <provider>` to add one.',
    )
    return 0
  }
  deps.out('id\tprovider\tproject\tcredential')
  for (const e of entries) {
    const project = e.project ?? '(bootstrapping project)'
    const credential = describeCredential(e.credential, deps.env)
      .map((c) => {
        const status = c.status ? ` (${c.status})` : c.kind === 'plaintext' ? ' (plaintext)' : ''
        return c.field ? `${c.field}=${c.display}${status}` : `${c.display}${status}`
      })
      .join(', ')
    deps.out(`${e.id}\t${e.provider}\t${project}\t${credential}`)
  }
  return 0
}

// ── `remove` ──────────────────────────────────────────────────────────────

async function connectorRemove(deps: ResolvedDeps, id: string | undefined): Promise<number> {
  if (!id) {
    deps.err('neat connector remove: missing <id>. run `neat connector list` to see configured ids.')
    return 2
  }
  // Read first: a push provider's drain must be torn down before the entry is
  // dropped, so a live drain is never orphaned from its config (connectors.md
  // §9). deprovision is idempotent, so retrying after a partial failure is safe.
  const config = await readConnectorsConfig(deps.home)
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

  const removed = await removeConnectorEntry(id, deps.home)
  if (!removed) {
    deps.err(`neat connector remove: no connector with id "${id}". run \`neat connector list\` to see configured ids.`)
    return 1
  }
  deps.out(`removed connector "${id}" (${removed.provider}).`)
  return 0
}

// ── `test` ────────────────────────────────────────────────────────────────

async function connectorTest(deps: ResolvedDeps, id: string | undefined): Promise<number> {
  if (!id) {
    deps.err('neat connector test: missing <id>. run `neat connector list` to see configured ids.')
    return 2
  }
  const config = await readConnectorsConfig(deps.home)
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

// ── dispatch ──────────────────────────────────────────────────────────────

export function printConnectorUsage(write: (line: string) => void): void {
  write('usage: neat connector <add|list|remove|test> [args]')
  write(`  providers:        ${knownProviderNames().join(', ')}`)
  write('                    pull (polled): supabase, railway, firebase, cloudflare')
  write('                    push (drains): vercel — provisions a Vercel trace Drain that forwards')
  write("                                   traces to the daemon's OTLP receiver; no app instrumentation")
  write('  add <provider>    add a connector; validates the credential first (--skip-validate to skip)')
  write('                    flags: --project <name>  --credential/--token <$VAR|value>  --id <id>')
  write('                           --<option> <value> (provider-specific)  --plaintext  --skip-validate')
  write('                    vercel: neat connector add vercel --token $VERCEL_TOKEN \\')
  write('                              --otel-token $NEAT_OTEL_TOKEN --team-id <teamId> \\')
  write('                              --endpoint https://<public-host>/v1/traces [--project-ids <id,id>]')
  write('  list              list configured connectors (credentials shown redacted)')
  write('                    flags: --project <name>')
  write('  remove <id>       remove a connector by id (a push provider also has its drain deleted)')
  write('  test <id>         re-run validation for an existing connector (a push provider re-tests its drain)')
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
  switch (a.subcommand) {
    case 'add':
      return connectorAdd(a, resolved)
    case 'list':
      return connectorList(resolved, a.project)
    case 'remove':
      return connectorRemove(resolved, a.positional[0])
    case 'test':
      return connectorTest(resolved, a.positional[0])
    case '':
      resolved.err('neat connector: missing subcommand.')
      printConnectorUsage(resolved.err)
      return 2
    default:
      resolved.err(`neat connector: unknown subcommand "${a.subcommand}".`)
      printConnectorUsage(resolved.err)
      return 2
  }
}

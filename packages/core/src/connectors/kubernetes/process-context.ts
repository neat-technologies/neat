// Process & config fusion — the OBSERVED "why" for a workload that fails BEFORE
// it emits its first span (ADR-237). A crash-loop, a bootstrap hang, an OOM, a
// panic-on-boot, a wrong config value: the fault classifier (map.ts) already
// sees *that* the workload is down, but the reason lives only in the pod's
// process stdout (the traceback the dead process left in its last terminated
// instance) and the container's env/args. This module turns those two raw inputs
// into a bounded, redacted `{ processLog, containerArgs, containerEnv }` block
// the fault finding carries as live OBSERVED runtime state on the incident
// ledger (map.ts → appendConnectorIncident).
//
// It is a pure, side-effect-free module: no fetch, no graph, no disk — just the
// secret redactor and the bounded builder, so the redaction rules and the caps
// are unit-testable in isolation (kubernetes-process-context.test.ts).
//
// SECRET DISCIPLINE (ADR-237, connectors.md §6/§10). This is the one carve-out
// from the "never write .env contents" rule (contracts.md Rule 13): it records
// REDACTED env values as *live runtime state on the incident ledger*, never a
// raw secret, never a ConfigNode, never a persisted node attribute. Two
// redaction gates run before any value leaves this module:
//   1. by KEY — an env var or flag whose name carries a secret stem
//      (SECRET_KEY_RE) has its value masked whole.
//   2. by VALUE SHAPE — every other value, arg, and the process log go through
//      `redactText`: credential URLs, secret-named pairs, auth-scheme
//      credentials, private keys, and self-identifying token formats.
// A `valueFrom` reference is never resolved — only its descriptor is captured —
// so a `secretKeyRef`'s actual value is never read in the first place.

import type { Container, EnvVar } from './types.js'

// ── caps (byte-bounded, honoring incident-serialization-cap.test.ts) ──────────

// The process log keeps its TAIL — a traceback / panic / OOM line sits at the
// END of the output, so the last lines are the ones that carry the cause.
export const DEFAULT_MAX_LOG_LINES = 50
export const DEFAULT_MAX_LOG_BYTES = 2 * 1024
// Bound the env/args lists so a container with hundreds of env vars can't bloat
// one incident, and cap each individual value so a single long value can't
// either.
export const DEFAULT_MAX_ENTRIES = 64
export const DEFAULT_MAX_VALUE_CHARS = 512

const REDACTED = '***REDACTED***'

// ── redaction ─────────────────────────────────────────────────────────────────

// Env var / flag names whose value is a secret by convention. Case-insensitive
// substring match — `DB_PASSWORD`, `API_TOKEN`, `STRIPE_SECRET_KEY`,
// `JWT_SIGNING_KEY`, `MYSQL_PWD`, `DB_PASS`, `SENTRY_DSN`, `GCP_CREDENTIALS`,
// `SESSION_COOKIE_SALT` all hit. Over-masking a benign name (`BYPASS_CACHE`)
// costs a little context; under-masking costs a secret, so the stems are broad.
const SECRET_KEY_RE =
  /TOKEN|SECRET|KEY|PASSW(?:OR)?D|PWD|(?:^|[^A-Z])PASS(?:$|[^A-Z])|CREDENTIAL|(?:^|[^A-Z])AUTH|PRIVATE|DSN|COOKIE|SESSION|SALT|SIGNATURE|CERT|CONN(?:ECTION)?_?STR/i

// A URL carrying inline credentials: `scheme://user:password@host`. The password
// between the first `:` after the authority's userinfo and the `@` is the secret;
// the scheme/host/path around it are safe context worth keeping. Global so every
// occurrence in a value is masked.
const CREDENTIAL_URL_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/@]+)(@)/g

/** Does this env var / flag name mark its value as a secret? */
export function isSecretKey(name: string): boolean {
  return SECRET_KEY_RE.test(name)
}

/** Mask the inline password inside any credential URL embedded in `value`. */
export function maskCredentialUrls(value: string): string {
  return value.replace(CREDENTIAL_URL_RE, (_m, prefix: string, _pw: string, at: string) => `${prefix}${REDACTED}${at}`)
}

// The value-shape gates every free-text value goes through — a non-secret-named
// env value, a process arg, and the process log alike. A traceback prints
// whatever the process held, so the log needs the same gates as the env.
//
// A PEM private key block, whole.
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
// The tail of a key block whose BEGIN line fell outside the fetched log.
const PRIVATE_KEY_TAIL_RE = /(?:^[A-Za-z0-9+/=]{32,}\r?\n)+-----END [A-Z ]*PRIVATE KEY-----/gm
// Any URL userinfo: `scheme://user:pass@` keeps the user and masks the password;
// `scheme://:pass@` (Redis) and `scheme://<key>@` (a Sentry-style DSN, where the
// userinfo IS the credential) are masked whole.
const URL_USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@]*)@/g
// A secret-named key followed by a value: `Password=x;` (ADO.NET), `password=x`
// (libpq / a query string), `DB_PASSWORD=x` (an env dump in a log), `"token": "x"`
// (JSON), `api_key: x` (YAML). The key stems are word-bounded so a log line like
// `3 tests passed: 12` keeps its number.
const SECRET_PAIR_RE =
  /((?:^|[\s?&;,{("'])[A-Za-z0-9_.-]*?(?:passw(?:or)?d|pwd|(?<![a-z])pass(?![a-z])|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|credentials?|(?<![a-z])auth(?![a-z])|(?<![a-z])dsn(?![a-z]))[A-Za-z0-9_.-]*["']?\s*[=:]\s*["']?)([^\s&;,"'})]+)/gi
// An HTTP auth scheme with its credential, e.g. a logged `Authorization: Bearer …`.
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g
// Self-identifying token formats that can ride in an innocuous-looking value.
const KNOWN_TOKEN_RE =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk_(?:live|test)_[A-Za-z0-9]{10,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bglpat-[A-Za-z0-9_-]{16,}|\bAIza[0-9A-Za-z_-]{30,}|\bneat_pat_[A-Za-z0-9_-]{16,}/g

/** Run every value-shape redaction gate over free text (a value, an arg, a log). */
export function redactText(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK_RE, REDACTED)
    .replace(PRIVATE_KEY_TAIL_RE, REDACTED)
    .replace(URL_USERINFO_RE, (_m, scheme: string, userinfo: string) => {
      const colon = userinfo.indexOf(':')
      return colon > 0 ? `${scheme}${userinfo.slice(0, colon)}:${REDACTED}@` : `${scheme}${REDACTED}@`
    })
    .replace(SECRET_PAIR_RE, (_m, key: string) => `${key}${REDACTED}`)
    .replace(AUTH_SCHEME_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KNOWN_TOKEN_RE, REDACTED)
}

/**
 * Redact one env var's literal value: masked whole when the NAME is a secret,
 * otherwise kept with any embedded credential-URL password masked by shape.
 */
export function redactValue(name: string, value: string): string {
  if (isSecretKey(name)) return REDACTED
  return redactText(value)
}

/**
 * Redact one process arg. An arg has no separate key, so two shapes are handled:
 * a `KEY=value` / `--key=value` flag whose key is secret has its value masked;
 * otherwise a credential URL embedded anywhere in the arg is masked by shape.
 */
export function redactArg(arg: string): string {
  const eq = /^(--?)?([A-Za-z0-9_.-]+)=([\s\S]*)$/.exec(arg)
  if (eq && isSecretKey(eq[2]!)) {
    return `${eq[1] ?? ''}${eq[2]}=${REDACTED}`
  }
  return redactText(arg)
}

// A bare flag naming a secret (`--password`, `--api-token`) whose value is the
// NEXT arg, as in `["--password", "hunter2"]`.
function isSecretFlag(arg: string): boolean {
  const m = /^--?([A-Za-z0-9_.-]+)$/.exec(arg)
  return m !== null && isSecretKey(m[1]!)
}

function capValue(s: string, max: number = DEFAULT_MAX_VALUE_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// ── env / args descriptors ────────────────────────────────────────────────────

/**
 * One env var → a `NAME=…` descriptor. A literal value is redacted and capped; a
 * `valueFrom` is captured as a reference descriptor only, never resolved — a
 * `secretKeyRef` drops its key (the key name can hint at the secret), a
 * `configMapKeyRef` keeps `name key <key>` (config references are not secrets).
 * Returns undefined for an unnamed var (nothing to anchor on).
 */
export function describeEnvVar(ev: EnvVar): string | undefined {
  const name = typeof ev.name === 'string' ? ev.name : ''
  if (name.length === 0) return undefined
  if (typeof ev.value === 'string') {
    return `${name}=${capValue(redactValue(name, ev.value))}`
  }
  const from = ev.valueFrom
  if (from) {
    if (from.secretKeyRef) {
      const ref = typeof from.secretKeyRef.name === 'string' && from.secretKeyRef.name.length > 0 ? from.secretKeyRef.name : '<unnamed>'
      return `${name}=<from secret ${ref}>`
    }
    if (from.configMapKeyRef) {
      const ref = typeof from.configMapKeyRef.name === 'string' && from.configMapKeyRef.name.length > 0 ? from.configMapKeyRef.name : '<unnamed>'
      const key = typeof from.configMapKeyRef.key === 'string' && from.configMapKeyRef.key.length > 0 ? ` key ${from.configMapKeyRef.key}` : ''
      return `${name}=<from configMap ${ref}${key}>`
    }
    if (from.fieldRef && typeof from.fieldRef.fieldPath === 'string' && from.fieldRef.fieldPath.length > 0) {
      return `${name}=<from field ${from.fieldRef.fieldPath}>`
    }
    if (from.resourceFieldRef && typeof from.resourceFieldRef.resource === 'string' && from.resourceFieldRef.resource.length > 0) {
      return `${name}=<from resource ${from.resourceFieldRef.resource}>`
    }
    return `${name}=<from reference>`
  }
  // An env var with neither value nor valueFrom — record the name, no value.
  return `${name}=`
}

function buildContainerEnv(container: Container): string[] {
  const out: string[] = []
  for (const ev of container.env ?? []) {
    const d = describeEnvVar(ev)
    if (d !== undefined) out.push(d)
    if (out.length >= DEFAULT_MAX_ENTRIES) break
  }
  return out
}

function buildContainerArgs(container: Container): string[] {
  const raw: string[] = []
  for (const c of container.command ?? []) if (typeof c === 'string') raw.push(c)
  for (const a of container.args ?? []) if (typeof a === 'string') raw.push(a)
  const out: string[] = []
  for (let i = 0; i < raw.length && out.length < DEFAULT_MAX_ENTRIES; i++) {
    const arg = raw[i]!
    out.push(capValue(redactArg(arg)))
    const next = raw[i + 1]
    if (isSecretFlag(arg) && next !== undefined && !next.startsWith('-') && out.length < DEFAULT_MAX_ENTRIES) {
      out.push(REDACTED)
      i++
    }
  }
  return out
}

// ── process log ────────────────────────────────────────────────────────────────

/**
 * Keep the TAIL of a process log, line- and byte-bounded. The last lines hold the
 * traceback / panic / OOM message, so trailing whitespace is trimmed, the last
 * `maxLines` lines are kept, then the result is clipped to `maxBytes` from the
 * end. Empty in → empty out.
 */
export function capProcessLog(
  text: string,
  maxLines: number = DEFAULT_MAX_LOG_LINES,
  maxBytes: number = DEFAULT_MAX_LOG_BYTES,
): string {
  const trimmed = text.replace(/\s+$/, '')
  if (trimmed.length === 0) return ''
  const lines = trimmed.split('\n')
  const tail = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines
  let out = tail.join('\n')
  if (out.length > maxBytes) out = out.slice(out.length - maxBytes)
  return out
}

// ── the builder ─────────────────────────────────────────────────────────────────

/**
 * The bounded, redacted OBSERVED runtime-state block a faulted workload's
 * incident carries. Every field is optional — a fault with no readable log, or a
 * pod with no spec, simply omits that field rather than minting an empty one.
 */
export interface ProcessContext {
  processLog?: string
  containerArgs?: string[]
  containerEnv?: string[]
}

export interface BuildProcessContextInput {
  // The fetched process stdout (client.ts, `previous=true` for a crash-looped
  // container so it's the LAST terminated instance's traceback, not the empty
  // current one). Undefined when the log couldn't be read (no `pods/log` RBAC, a
  // container that never started) — the block then carries env/args only.
  log?: string
  // The faulted pod's spec container, for its args + env. Undefined when the pod
  // carries no readable spec — the block then carries the log only.
  container?: Container
}

/**
 * Build the `{ processLog, containerArgs, containerEnv }` block from a fetched
 * process log and the faulted container's spec. Pure: all redaction and capping
 * happen here, so nothing raw or unbounded ever leaves. Returns an empty object
 * when there's nothing to record (no log, no container) — the caller merges only
 * the fields that are set.
 */
export function buildProcessContext(input: BuildProcessContextInput): ProcessContext {
  const out: ProcessContext = {}
  if (typeof input.log === 'string') {
    // Cap to the tail, then mask any credential URL the traceback printed — a
    // boot failure commonly logs the connection string it died dialing, so the
    // same value-shape redaction the env takes applies to the log.
    // Redact the whole fetched text first, so a secret that straddles the cap
    // boundary is still recognised whole; then keep the tail.
    const capped = capProcessLog(redactText(input.log))
    if (capped.length > 0) out.processLog = capped
  }
  if (input.container) {
    const args = buildContainerArgs(input.container)
    if (args.length > 0) out.containerArgs = args
    const env = buildContainerEnv(input.container)
    if (env.length > 0) out.containerEnv = env
  }
  return out
}

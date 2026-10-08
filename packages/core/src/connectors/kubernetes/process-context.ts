// Process & config fusion — the OBSERVED "why" for a workload that fails BEFORE
// it emits its first span (ADR-236). A crash-loop, a bootstrap hang, an OOM, a
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
// SECRET DISCIPLINE (ADR-236, connectors.md §6/§10). This is the one carve-out
// from the "never write .env contents" rule (contracts.md Rule 13): it records
// REDACTED env values as *live runtime state on the incident ledger*, never a
// raw secret, never a ConfigNode, never a persisted node attribute. Two
// redaction gates run before any value leaves this module:
//   1. by KEY — an env var whose name matches a secret pattern (`*TOKEN*` /
//      `*SECRET*` / `*KEY*` / `*PASSWORD*`) has its value masked whole.
//   2. by VALUE SHAPE — a credential URL (`scheme://user:pass@host`) has its
//      inline password masked wherever it appears (env value or arg), because a
//      connection string often rides in a non-secret-named var.
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

// Env var names whose value is a secret by convention. Case-insensitive
// substring match — `DB_PASSWORD`, `API_TOKEN`, `STRIPE_SECRET_KEY`,
// `JWT_SIGNING_KEY` all hit. These four stems are the policy ADR-236 approved.
const SECRET_KEY_RE = /TOKEN|SECRET|KEY|PASSWORD/i

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

/**
 * Redact one env var's literal value: masked whole when the NAME is a secret,
 * otherwise kept with any embedded credential-URL password masked by shape.
 */
export function redactValue(name: string, value: string): string {
  if (isSecretKey(name)) return REDACTED
  return maskCredentialUrls(value)
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
  return maskCredentialUrls(arg)
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
  return raw.slice(0, DEFAULT_MAX_ENTRIES).map((a) => capValue(redactArg(a)))
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
    const capped = maskCredentialUrls(capProcessLog(input.log))
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

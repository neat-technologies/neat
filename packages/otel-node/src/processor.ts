// The NEAT call-site span processor and its facade wraps, delivered as a
// package the user attaches with `--require`/`--import` instead of a file NEAT
// injects into their source. Ported faithfully from the generated otel-init in
// `@neat.is/core` (installers/templates.ts) — same three attribution layers:
//
//   1. Synchronous stack walk at span start — the sync-wrapper majority.
//   2. Handler-entry attribution — stamp the framework SERVER span and push the
//      handler frame into context so downstream CLIENT/PRODUCER spans inherit it.
//   3. Off-stack facades — undici / built-in `fetch` and Prisma create their
//      span detached from the caller's stack, so the call-site frame is pushed
//      into context for the inner dispatch and read back as a fallback.
//
// Emits the stable semantic-convention names (`code.file.path` /
// `code.line.number` / `code.function.name`, semconv ≥1.33). `@neat.is/core`
// ingest reads both these and the prior names; new emit is stable-first.
import { context } from '@opentelemetry/api'

// Context key shared by the facade/handler wraps (writers) and the processor
// fallback (reader). Symbol.for keeps it stable across module instances.
export const NEAT_USER_FRAME = Symbol.for('neat.user-frame')

export interface UserFrame {
  filepath: string
  lineno?: number
  function?: string
}

// This package's own bundle file. Every NEAT wrapper and instrumentation is
// bundled into it, so a frame there is never the user's call site, even when
// the package isn't under node_modules (a workspace, `npm link`, a file:
// install) and a wrapper lacks the __neat prefix.
const OWN_FILE: string | undefined = (() => {
  try {
    const line = String(new Error().stack || '').split('\n')[1] || ''
    const m = /\(?((?:file:\/\/)?[^()\s]+):\d+:\d+\)?\s*$/.exec(line.trim())
    const file = m ? m[1] : undefined
    return file && file.indexOf('file://') === 0 ? file.slice(7) : file
  } catch {
    return undefined
  }
})()

// Layer 1 — parse the first application frame off a stack, skipping node
// internals, node_modules, OpenTelemetry, and NEAT's own wraps/helpers.
export function pickUserFrame(stack: string | undefined): UserFrame | null {
  const lines = String(stack || '').split('\n')
  for (const rawLine of lines) {
    const raw = rawLine.trim()
    if (raw.indexOf('at ') !== 0) continue
    if (raw.indexOf('node_modules') !== -1) continue
    if (raw.indexOf('@opentelemetry') !== -1) continue
    if (raw.indexOf('node:') !== -1) continue
    if (raw.indexOf('NeatCallSiteSpanProcessor') !== -1) continue
    // Skip NEAT's own inlined wraps/helpers (all carry the __neat prefix) so a
    // facade frame never masquerades as the user's call site.
    if (raw.indexOf('__neat') !== -1) continue
    const bodyText = raw.slice(3)
    const loc = bodyText.match(/:(\d+):(\d+)\)?$/)
    if (!loc) continue
    const full = loc[0] ?? ''
    const lineDigits = loc[1] ?? ''
    const paren = bodyText.lastIndexOf('(')
    let filepath: string | undefined
    let fn: string | undefined
    if (paren !== -1) {
      fn = bodyText.slice(0, paren).trim()
      if (fn.indexOf('async ') === 0) fn = fn.slice(6)
      if (fn.indexOf('new ') === 0) fn = fn.slice(4)
      filepath = bodyText.slice(paren + 1, bodyText.length - full.length)
    } else {
      filepath = bodyText.slice(0, bodyText.length - full.length)
    }
    if (filepath.indexOf('file://') === 0) filepath = filepath.slice(7)
    if (!filepath || filepath === OWN_FILE) continue
    return { filepath, lineno: Number(lineDigits), function: fn || undefined }
  }
  return null
}

// Layer 2/3 fallback source: the frame a handler-entry or facade wrap pushed
// into context. Reads the span's own parent context first, then the active one.
function frameFromContext(parentContext: unknown): UserFrame | null {
  try {
    const pc = parentContext as { getValue?: (k: symbol) => unknown } | undefined
    const fromParent =
      pc && typeof pc.getValue === 'function' ? (pc.getValue(NEAT_USER_FRAME) as UserFrame | undefined) : undefined
    return fromParent || (context.active().getValue(NEAT_USER_FRAME) as UserFrame | undefined) || null
  } catch {
    return null
  }
}

export function setCodeAttrs(span: { setAttribute: (k: string, v: unknown) => void }, frame: UserFrame): void {
  span.setAttribute('code.file.path', frame.filepath)
  if (typeof frame.lineno === 'number') span.setAttribute('code.line.number', frame.lineno)
  if (frame.function) span.setAttribute('code.function.name', frame.function)
}

// The database system the knex facade read off the query's own client, carried
// in context from builder creation to the span (see wrapKnex).
export const NEAT_DB_SYSTEM = Symbol.for('neat.db-system')

function valueFromContext(parentContext: unknown, key: symbol): unknown {
  try {
    const pc = parentContext as { getValue?: (k: symbol) => unknown } | undefined
    const v = pc && typeof pc.getValue === 'function' ? pc.getValue(key) : undefined
    return v !== undefined ? v : context.active().getValue(key)
  } catch {
    return undefined
  }
}

// SpanProcessor: stamps CLIENT (2) / PRODUCER (3) spans with their call site.
export class NeatCallSiteSpanProcessor {
  onStart(
    span: { kind: number; attributes?: Record<string, unknown>; setAttribute: (k: string, v: unknown) => void },
    parentContext: unknown,
  ): void {
    if (!span || (span.kind !== 2 && span.kind !== 3)) return
    // The knex instrumentation maps db.system from `config.client` as a string;
    // an app that passes a dialect class (uptime-kuma, via redbean-node) gets no
    // db.system, and ingest's database branch keys on it. Fill it from the
    // client's own dialect.
    try {
      const attrs = span.attributes
      if (attrs && attrs['knex.version'] !== undefined && attrs['db.system'] === undefined) {
        const system = valueFromContext(parentContext, NEAT_DB_SYSTEM)
        if (typeof system === 'string' && system) span.setAttribute('db.system', system)
      }
    } catch {
      /* best-effort */
    }
    // Layer 1 — synchronous stack walk (sync-wrapper instrumentations).
    let frame = pickUserFrame(new Error().stack)
    // Layer 2/3 — the handler-entry or off-stack-facade frame from context.
    if (!frame) frame = frameFromContext(parentContext)
    if (!frame) return
    setCodeAttrs(span, frame)
  }
  onEnd(): void {}
  forceFlush(): Promise<void> {
    return Promise.resolve()
  }
  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

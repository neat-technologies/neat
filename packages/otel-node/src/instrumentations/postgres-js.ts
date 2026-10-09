// OpenTelemetry instrumentation for postgres.js (the `postgres` package).
//
// No upstream instrumentation covers postgres.js, so a service using it reached
// NEAT with no database spans at all: no OBSERVED edge to its Postgres, and no
// failure on it. This adds one CLIENT span per executed query.
//
// How it hooks in, against postgres.js 3.x internals:
//   - The `postgres(url, options)` factory is wrapped, so each `sql` instance's
//     connection options (host, port, database, user) are known.
//   - A query is a lazy `Query` (a Promise subclass). It executes exactly once,
//     through `Query.prototype.handle()`, and settles through its own
//     `resolve` / `reject`. The span starts in `handle()` and ends when the query
//     settles, so building a query fragment (`sql`…`` nested in another query)
//     never starts a span, and the instrumentation never triggers execution.
//   - The span's call site comes from the stack postgres.js captures when a
//     tagged query is built (`query.origin`), which is on the user's frame; the
//     execution itself runs a microtask later, off that stack.
//
// A query that never settles never ends its span, so it isn't exported; NEAT
// sees that hang from the caller's timeout instead (ADR-226).

import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation'
import { SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api'
import { pickUserFrame } from '../processor.js'

const PATCHED = Symbol.for('neat.postgresjs.patched')
const SPAN = Symbol.for('neat.postgresjs.span')

interface ConnInfo {
  host?: string
  port?: number
  database?: string
  user?: string
}

interface QueryLike {
  executed?: boolean
  tagged?: boolean
  strings?: unknown
  handler?: unknown
  origin?: string
  resolve: (x: unknown) => unknown
  reject: (e: unknown) => unknown
  [SPAN]?: Span
}

type Factory = (...args: unknown[]) => { options?: Record<string, unknown> } & ((...a: unknown[]) => unknown)

const first = <T>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v)

/** The statement text, with `$n` where a tagged query interpolated a value. */
export function statementOf(q: { tagged?: boolean; strings?: unknown }): string | undefined {
  const s = q.strings
  if (typeof s === 'string') return s
  if (Array.isArray(s)) return s.reduce((acc: string, part: unknown, i: number) => acc + (i ? `$${i}` : '') + String(part), '')
  return undefined
}

export class PostgresJsInstrumentation extends InstrumentationBase {
  // Connection options per `sql` instance, keyed by the instance's query handler.
  private readonly conns = new WeakMap<object, ConnInfo>()
  private lastConn: ConnInfo | undefined

  constructor() {
    super('@neat.is/instrumentation-postgres-js', '1.0.0', {})
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition(
        'postgres',
        ['>=3 <4'],
        (exports: unknown) => this.patchModule(exports),
        (exports: unknown) => exports,
      ),
    ]
  }

  private patchModule(exports: unknown): unknown {
    if (typeof exports === 'function') return this.wrapFactory(exports as Factory)
    const ns = exports as { default?: unknown }
    if (ns && typeof ns.default === 'function') ns.default = this.wrapFactory(ns.default as Factory)
    return exports
  }

  private wrapFactory(original: Factory): Factory {
    if ((original as unknown as Record<symbol, boolean>)[PATCHED]) return original
    const self = this
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const sql = original.apply(this, args)
      try {
        self.register(sql)
      } catch {
        // Instrumentation never breaks the app.
      }
      return sql
    } as unknown as Factory
    Object.assign(wrapped, original)
    ;(wrapped as unknown as Record<symbol, boolean>)[PATCHED] = true
    return wrapped
  }

  private register(sql: ReturnType<Factory>): void {
    const o = (sql.options ?? {}) as Record<string, unknown>
    const port = Number(first(o.port as number | number[] | undefined))
    const info: ConnInfo = {
      ...(typeof first(o.host as string | string[]) === 'string' ? { host: first(o.host as string | string[]) } : {}),
      ...(Number.isFinite(port) ? { port } : {}),
      ...(typeof o.database === 'string' ? { database: o.database } : {}),
      ...(typeof o.user === 'string' ? { user: o.user } : {}),
    }
    this.lastConn = info
    // A tagged call builds a lazy Query without running it, which hands us the
    // instance's handler (to key its options) and the Query prototype (to patch
    // `handle` once). Nothing is executed or queued.
    const probe = (sql as unknown as (s: TemplateStringsArray) => QueryLike)(Object.assign(['select 1'], { raw: ['select 1'] }) as unknown as TemplateStringsArray)
    const handler = probe?.handler
    if (handler && (typeof handler === 'object' || typeof handler === 'function')) {
      this.conns.set(handler as object, info)
    }
    const proto = probe && Object.getPrototypeOf(probe)
    if (proto && typeof proto.handle === 'function' && !proto[PATCHED]) {
      proto[PATCHED] = true
      this._wrap(proto, 'handle', (orig: (...a: unknown[]) => unknown) => {
        const inst = this
        return function (this: QueryLike, ...a: unknown[]) {
          if (!this.executed && !this[SPAN]) {
            try {
              inst.startSpan(this)
            } catch {
              // never break the query
            }
          }
          return orig.apply(this, a)
        }
      })
    }
  }

  private startSpan(q: QueryLike): void {
    const conn: ConnInfo = (q.handler && this.conns.get(q.handler as object)) || this.lastConn || {}
    const statement = statementOf(q)
    const operation = statement?.trim().split(/\s+/)[0]?.toUpperCase()
    const span = this.tracer.startSpan(operation ? `${operation} ${conn.database ?? 'postgres'}` : 'postgres.query', {
      kind: SpanKind.CLIENT,
      attributes: {
        'db.system': 'postgresql',
        ...(conn.database ? { 'db.name': conn.database, 'db.namespace': conn.database } : {}),
        ...(conn.user ? { 'db.user': conn.user } : {}),
        ...(conn.host ? { 'net.peer.name': conn.host, 'server.address': conn.host } : {}),
        ...(conn.port !== undefined ? { 'net.peer.port': conn.port, 'server.port': conn.port } : {}),
        ...(statement ? { 'db.statement': statement, 'db.query.text': statement } : {}),
        ...(operation ? { 'db.operation': operation, 'db.operation.name': operation } : {}),
      },
    })
    // The call site postgres.js recorded when the query was built (tagged queries).
    const frame = q.tagged ? pickUserFrame(q.origin) : null
    if (frame) {
      span.setAttribute('code.file.path', frame.filepath)
      span.setAttribute('code.filepath', frame.filepath)
      if (typeof frame.lineno === 'number') {
        span.setAttribute('code.line.number', frame.lineno)
        span.setAttribute('code.lineno', frame.lineno)
      }
      if (frame.function) {
        span.setAttribute('code.function.name', frame.function)
        span.setAttribute('code.function', frame.function)
      }
    }
    q[SPAN] = span

    let ended = false
    const end = (err?: unknown): void => {
      if (ended) return
      ended = true
      if (err !== undefined) {
        if (err instanceof Error) span.recordException(err)
        span.setStatus({ code: SpanStatusCode.ERROR, message: String((err as { message?: string })?.message ?? err) })
      }
      span.end()
    }
    // postgres.js reassigns resolve/reject (cursors do), so wrap through an
    // accessor: whatever function lands there still ends the span first.
    settleThrough(q, 'resolve', (fn) => (x: unknown) => (end(), fn(x)))
    settleThrough(q, 'reject', (fn) => (e: unknown) => (end(e), fn(e)))
  }
}

function settleThrough(
  q: QueryLike,
  key: 'resolve' | 'reject',
  wrap: (fn: (x: unknown) => unknown) => (x: unknown) => unknown,
): void {
  let current = wrap(q[key])
  Object.defineProperty(q, key, {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (fn: (x: unknown) => unknown) => {
      current = wrap(fn)
    },
  })
}

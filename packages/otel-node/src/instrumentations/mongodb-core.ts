// OpenTelemetry instrumentation for the MongoDB driver lines that predate the
// upstream instrumentation: `mongodb` 2.x and 3.0-3.2.
//
// The upstream @opentelemetry/instrumentation-mongodb covers `mongodb` >=3.3,
// where the wire layer lives inside the driver. Before that the driver delegates
// to the separate `mongodb-core` package (1.x for mongodb 2.0/2.1, 2.x for
// mongodb 2.2, 3.x for mongodb 3.0-3.2), and no upstream instrumentation hooks
// it. A service on those lines (OWASP NodeGoat runs mongodb 2.2.36; its CVE fix
// lands on 3.1.13) reached NEAT with no database spans at all.
//
// How it hooks in, against mongodb-core's own surface, the same shape across
// 1.x-3.x:
//   - `Server.prototype.command(ns, cmd, options, callback)` and
//     `insert` / `update` / `remove(ns, ops, options, callback)`. Every topology
//     (single server, replica set, mongos) ends on a `Server`, so this covers
//     them all. The span ends in the callback.
//   - `Cursor.prototype.next(callback)`: a cursor's first `next` issues its
//     query (find / aggregate) through the wire protocol handler directly, never
//     through `Server.prototype.command`, so a read is one span, not two.
// Handshake and auth commands (ismaster, saslStart, ...) get no span: they are
// the driver talking to itself, not the app's work.
//
// The call site comes from NEAT's call-site processor: a synchronous stack walk
// when the driver reaches the server on the caller's stack, otherwise the frame
// the `Collection` facade pushed into context (processor.ts).

import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation'
import { SpanKind, SpanStatusCode, context, trace, type Span } from '@opentelemetry/api'

const PATCHED = Symbol.for('neat.mongodbcore.patched')
const CURSOR_SPAN = Symbol.for('neat.mongodbcore.cursorSpan')
// Set on a cursor by the Collection facade in processor.ts: the frame of the
// app's find()/aggregate() call, which created the cursor.
const USER_FRAME = Symbol.for('neat.user-frame')

// Commands the driver issues for itself during connect, auth and monitoring.
const INTERNAL_COMMANDS = new Set([
  'ismaster', 'isMaster', 'hello', 'saslStart', 'saslContinue', 'getnonce', 'authenticate',
  'ping', 'buildinfo', 'buildInfo', 'getLastError', 'getlasterror', 'endSessions', 'killCursors',
  'getMore', 'logout',
])

type Callback = (err?: unknown, result?: unknown) => unknown
interface ServerLike {
  s?: { options?: { host?: string; port?: number } }
}
interface CursorLike {
  ns?: string
  cmd?: Record<string, unknown>
  server?: ServerLike
  topology?: ServerLike
  [CURSOR_SPAN]?: Span | 'done'
  [USER_FRAME]?: { filepath: string; lineno?: number; function?: string }
}

/** Split `db.collection` (the collection may itself contain dots). */
export function splitNamespace(ns: unknown): { db?: string; collection?: string } {
  if (typeof ns !== 'string' || ns.length === 0) return {}
  const dot = ns.indexOf('.')
  if (dot === -1) return { db: ns }
  const collection = ns.slice(dot + 1)
  return { db: ns.slice(0, dot), collection: collection === '$cmd' ? undefined : collection }
}

/** The command name: a MongoDB command document's first key. */
export function commandName(cmd: unknown): string | undefined {
  if (!cmd || typeof cmd !== 'object') return undefined
  const first = Object.keys(cmd as object)[0]
  return first || undefined
}

function addressOf(server: ServerLike | undefined): { host?: string; port?: number } {
  const o = server && server.s && server.s.options
  return o ? { host: typeof o.host === 'string' ? o.host : undefined, port: typeof o.port === 'number' ? o.port : undefined } : {}
}

export class MongodbCoreInstrumentation extends InstrumentationBase {
  constructor() {
    super('@neat.is/instrumentation-mongodb-core', '1.0.0', {})
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition(
        'mongodb-core',
        ['>=1 <4'],
        (exports: unknown) => this.patchModule(exports),
        (exports: unknown) => exports,
      ),
    ]
  }

  private patchModule(exports: unknown): unknown {
    try {
      const mod = exports as { Server?: { prototype?: Record<string | symbol, unknown> }; Cursor?: { prototype?: Record<string | symbol, unknown> } }
      const server = mod && mod.Server && mod.Server.prototype
      if (server && !server[PATCHED]) {
        server[PATCHED] = true
        this.wrapServerMethod(server, 'command')
        for (const op of ['insert', 'update', 'remove'] as const) this.wrapServerMethod(server, op)
      }
      const cursor = mod && mod.Cursor && mod.Cursor.prototype
      if (cursor && !cursor[PATCHED] && typeof cursor.next === 'function') {
        cursor[PATCHED] = true
        this.wrapCursorNext(cursor)
      }
    } catch {
      // Instrumentation never breaks the app.
    }
    return exports
  }

  private startSpan(
    operation: string,
    ns: { db?: string; collection?: string },
    address: { host?: string; port?: number },
  ): Span {
    return this.tracer.startSpan(
      ns.collection ? `${operation} ${ns.db}.${ns.collection}` : `${operation} ${ns.db ?? ''}`.trim(),
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system': 'mongodb',
          'db.system.name': 'mongodb',
          ...(ns.db ? { 'db.name': ns.db, 'db.namespace': ns.db } : {}),
          ...(ns.collection ? { 'db.mongodb.collection': ns.collection, 'db.collection.name': ns.collection } : {}),
          'db.operation': operation,
          'db.operation.name': operation,
          ...(address.host ? { 'net.peer.name': address.host, 'server.address': address.host } : {}),
          ...(address.port ? { 'net.peer.port': address.port, 'server.port': address.port } : {}),
        },
      },
    )
  }

  private endSpan(span: Span, err: unknown): void {
    try {
      if (err) {
        span.recordException(err as Error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: String((err as { message?: string })?.message ?? err) })
      }
      span.end()
    } catch {
      // never break the callback
    }
  }

  private wrapServerMethod(proto: Record<string | symbol, unknown>, method: 'command' | 'insert' | 'update' | 'remove'): void {
    const original = proto[method]
    if (typeof original !== 'function') return
    const inst = this
    proto[method] = function __neatMongoServerOp(this: ServerLike, ns: unknown, payload: unknown, ...rest: unknown[]) {
      let span: Span | undefined
      try {
        const operation = method === 'command' ? commandName(payload) : method
        if (operation && !(method === 'command' && INTERNAL_COMMANDS.has(operation))) {
          const parsed = splitNamespace(ns)
          // A command names its collection as its own value ({ find: 'users' }).
          const target = method === 'command' ? (payload as Record<string, unknown>)[operation] : undefined
          if (typeof target === 'string' && !parsed.collection) parsed.collection = target
          span = inst.startSpan(operation, parsed, addressOf(this))
        }
      } catch {
        span = undefined
      }
      if (!span) return (original as (...a: unknown[]) => unknown).call(this, ns, payload, ...rest)
      // The callback is the last function argument (options are optional).
      const cbIndex = rest.map((a) => typeof a === 'function').lastIndexOf(true)
      if (cbIndex !== -1) {
        const cb = rest[cbIndex] as Callback
        const s = span
        rest[cbIndex] = function (this: unknown, err?: unknown, result?: unknown) {
          inst.endSpan(s, err)
          return cb.call(this, err, result)
        }
      }
      try {
        return context.with(trace.setSpan(context.active(), span), () =>
          (original as (...a: unknown[]) => unknown).call(this, ns, payload, ...rest),
        )
      } catch (err) {
        inst.endSpan(span, err)
        throw err
      }
    }
  }

  private wrapCursorNext(proto: Record<string | symbol, unknown>): void {
    const original = proto.next as (this: CursorLike, cb?: Callback) => unknown
    const inst = this
    proto.next = function __neatMongoCursorNext(this: CursorLike, callback?: Callback) {
      // Only the first next() issues the query; later ones read the batch or
      // getMore, which stays inside this span's operation.
      if (this[CURSOR_SPAN] || typeof callback !== 'function') return original.call(this, callback)
      let span: Span | undefined
      try {
        const cmd = this.cmd || {}
        const operation = typeof cmd.aggregate !== 'undefined' ? 'aggregate' : 'find'
        const parsed = splitNamespace(this.ns)
        if (typeof cmd[operation] === 'string' && !parsed.collection) parsed.collection = cmd[operation] as string
        span = inst.startSpan(operation, parsed, addressOf(this.server || this.topology))
        const frame = this[USER_FRAME]
        if (frame && frame.filepath) {
          span.setAttribute('code.file.path', frame.filepath)
          if (typeof frame.lineno === 'number') span.setAttribute('code.line.number', frame.lineno)
          if (frame.function) span.setAttribute('code.function.name', frame.function)
        }
        this[CURSOR_SPAN] = span
      } catch {
        span = undefined
      }
      if (!span) return original.call(this, callback)
      const s = span
      const cursor = this
      const wrapped: Callback = function (this: unknown, err?: unknown, result?: unknown) {
        if (cursor[CURSOR_SPAN] === s) {
          // The selected server is known once the query ran.
          const a = addressOf(cursor.server)
          if (a.host) s.setAttributes({ 'net.peer.name': a.host, 'server.address': a.host })
          if (a.port) s.setAttributes({ 'net.peer.port': a.port, 'server.port': a.port })
          cursor[CURSOR_SPAN] = 'done'
          inst.endSpan(s, err)
        }
        return callback.call(this, err, result)
      }
      try {
        return context.with(trace.setSpan(context.active(), s), () => original.call(this, wrapped))
      } catch (err) {
        cursor[CURSOR_SPAN] = 'done'
        inst.endSpan(s, err)
        throw err
      }
    }
  }
}

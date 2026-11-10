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
import diagnosticsChannel from 'node:diagnostics_channel'
import { context, createContextKey, trace } from '@opentelemetry/api'

// Context key shared by the facade/handler wraps (writers) and the processor
// fallback (reader). Symbol.for keeps it stable across module instances.
const NEAT_USER_FRAME = Symbol.for('neat.user-frame')

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

function setCodeAttrs(span: { setAttribute: (k: string, v: unknown) => void }, frame: UserFrame): void {
  span.setAttribute('code.file.path', frame.filepath)
  if (typeof frame.lineno === 'number') span.setAttribute('code.line.number', frame.lineno)
  if (frame.function) span.setAttribute('code.function.name', frame.function)
}

// The database system the knex facade read off the query's own client, carried
// in context from builder creation to the span (see wrapKnex).
const NEAT_DB_SYSTEM = Symbol.for('neat.db-system')

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

// Capture the caller's synchronous frame at the wrap point and run `fn` with
// that frame pushed into the active context (layer 3). An off-stack
// instrumentation that creates its span inside `fn` inherits the frame.
function runWithUserFrame<T>(fn: () => T): T {
  const frame = pickUserFrame(new Error().stack)
  if (!frame) return fn()
  try {
    return context.with(context.active().setValue(NEAT_USER_FRAME, frame), fn)
  } catch {
    return fn()
  }
}

// Handler-entry attribution (layer 2). Stamp the active framework SERVER span
// with the handler frame captured at route registration, and push the same
// frame into context so downstream CLIENT/PRODUCER spans inherit the floor.
// The http instrumentation puts the SERVER span into context as RPC metadata
// (@opentelemetry/core's key, a Symbol.for, so it is the same key here); that is
// how framework instrumentations set http.route on it. A framework that wraps
// the handler in its own INTERNAL span (fastify, koa) leaves that span active,
// so the SERVER span is reached through the metadata instead.
const RPC_METADATA_KEY = createContextKey('OpenTelemetry SDK Context Key RPC_METADATA')
type StampableSpan = { kind?: number; setAttribute?: (k: string, v: unknown) => void }

// The span a handler-entry wrap stamps: the active SERVER span, or the active
// CONSUMER span a message-driven framework opens around its listener
// (socket.io); otherwise the SERVER span reached through the RPC metadata.
function activeServerSpan(): StampableSpan | undefined {
  const active = trace.getActiveSpan() as StampableSpan | undefined
  if (active && (active.kind === 1 || active.kind === 4)) return active
  const meta = context.active().getValue(RPC_METADATA_KEY) as { span?: StampableSpan } | undefined
  if (meta && meta.span && meta.span.kind === 1) return meta.span
  return undefined
}

function stampHandler<T>(frame: UserFrame, run: () => T): T {
  try {
    const server = activeServerSpan()
    if (server && typeof server.setAttribute === 'function') {
      setCodeAttrs(server as { setAttribute: (k: string, v: unknown) => void }, frame)
    }
  } catch {
    /* best-effort */
  }
  try {
    return context.with(context.active().setValue(NEAT_USER_FRAME, frame), run)
  } catch {
    return run()
  }
}

// How the facades reach the module graph. The register entries pass these in:
// a real `require` (the ESM build has none of its own, so a bare `require`
// there throws and every facade would silently skip), and import-in-the-middle's
// Hook, resolved through @opentelemetry/instrumentation so it is the same
// instance as the loader hook `register.mjs` installs. require-in-the-middle
// only sees `require()`; an ESM app's `import express` reaches the module only
// through the import hook.
export interface ModuleLoaders {
  require?: (id: string) => unknown
  ImportHook?: new (modules: string[], hookFn: (exported: Record<string, unknown>, name: string) => unknown) => unknown
}

let loaders: ModuleLoaders = {}

// Registers `onload` for `modules` with every hook available: require-in-the-
// middle for CommonJS loads and import-in-the-middle for ESM imports. Each wrap
// is idempotent, so a module seen by both hooks is wrapped once. Guarded: when
// neither hook is available the off-stack/handler wraps degrade to the stack
// walk + context floor.
function neatHook(modules: string[], onload: (exports: unknown, name: string) => unknown): boolean {
  let hooked = false
  try {
    // A bare `require` is defined only in the CJS build; under ESM the register
    // entry supplies one.
    const req = loaders.require ?? (typeof require === 'function' ? require : undefined)
    if (req) {
      const RITM = req('require-in-the-middle') as { Hook?: unknown }
      const Hook = (RITM && RITM.Hook ? RITM.Hook : RITM) as new (
        m: string[],
        o: { internals: boolean },
        fn: (exports: unknown, name: string) => unknown,
      ) => unknown
      new Hook(modules, { internals: false }, onload)
      hooked = true
    }
  } catch {
    /* fall through to the import hook */
  }
  try {
    if (loaders.ImportHook) {
      // import-in-the-middle hands over the module namespace. Return nothing so
      // the namespace's default export is left as it was.
      new loaders.ImportHook(modules, (exported, name) => {
        onload(exported, name)
        return undefined
      })
      hooked = true
    }
  } catch {
    /* best-effort */
  }
  return hooked
}

// Off-stack facade: Node's built-in fetch / undici. The instrumentation creates
// the CLIENT span inside a diagnostics_channel handler detached from the
// caller's stack, so wrap the global so the user frame is in context when the
// span is created.
function wrapFetch(): void {
  try {
    const g = globalThis as unknown as { fetch?: ((...a: unknown[]) => unknown) & { __neatWrapped?: boolean } }
    if (typeof g.fetch === 'function' && !g.fetch.__neatWrapped) {
      const realFetch = g.fetch
      const neatFetch = function __neatFetch(input: unknown, init: unknown) {
        return runWithUserFrame(() => (realFetch as (...a: unknown[]) => unknown)(input, init))
      } as ((...a: unknown[]) => unknown) & { __neatWrapped?: boolean }
      neatFetch.__neatWrapped = true
      g.fetch = neatFetch
    }
  } catch {
    /* best-effort */
  }
}

// Off-stack facade: @prisma/client. Prisma's query engine backdates its spans
// from Rust, off the caller's stack. Wrap the model methods so the call-site
// frame (still synchronous at `prisma.user.find`) is pushed into context.
function wrapPrisma(): void {
  neatHook(['@prisma/client'], (exports: unknown) => {
    try {
      // CJS hands over module.exports; ESM hands over the namespace, whose named
      // PrismaClient may be missing when the CJS re-export defeats static
      // analysis, so fall back to the default export (module.exports itself).
      type PrismaExports = { PrismaClient?: (new (...a: unknown[]) => unknown) & { __neatWrapped?: boolean } }
      const ns = exports as PrismaExports & { default?: PrismaExports }
      const ex = ns && typeof ns.PrismaClient === 'function' ? ns : ns && ns.default ? ns.default : ns
      const Client = ex && ex.PrismaClient
      if (typeof Client === 'function' && !Client.__neatWrapped) {
        const ops = [
          'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'create',
          'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy',
        ]
        const wrapModel = (model: Record<string, unknown> & { __neatWrapped?: boolean }) => {
          if (!model || model.__neatWrapped) return model
          for (const op of ops) {
            const orig = model[op]
            if (typeof orig !== 'function') continue
            model[op] = function __neatModelOp(this: unknown, ...args: unknown[]) {
              const self = this
              return runWithUserFrame(() => (orig as (...a: unknown[]) => unknown).apply(self, args))
            }
          }
          model.__neatWrapped = true
          return model
        }
        ex.PrismaClient = new Proxy(Client, {
          construct(Target, argList, NewTarget) {
            const instance = Reflect.construct(Target as new (...a: unknown[]) => unknown, argList, NewTarget)
            return new Proxy(instance as object, {
              get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver)
                if (value && typeof value === 'object' && typeof prop === 'string' && prop[0] !== '$' && prop[0] !== '_') {
                  return wrapModel(value as Record<string, unknown>)
                }
                return value
              },
            })
          },
        }) as typeof Client
        ;(ex.PrismaClient as { __neatWrapped?: boolean }).__neatWrapped = true
      }
    } catch {
      /* best-effort */
    }
    return exports
  })
}

// Handler-entry facades. express / connect share the Layer model; the wrap
// captures the registration frame and stamps + propagates it when the handler
// runs. The wrap list is the extensibility seam for koa / nestjs (fastify is
// covered through its diagnostics channel below).
function wrapConnectStyle(mod: unknown): void {
  try {
    const verbs = ['use', 'get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head']
    const wrapTarget = (target: (Record<string, unknown> & { __neatVerbsWrapped?: boolean }) | undefined) => {
      if (!target || target.__neatVerbsWrapped) return
      for (const verb of verbs) {
        const orig = target[verb]
        if (typeof orig !== 'function') continue
        // Named with the __neat prefix so the frame picker skips this wrapper
        // and lands on the user's registration line, not on this file.
        target[verb] = function __neatVerb(this: unknown, ...args: unknown[]) {
          const frame = pickUserFrame(new Error().stack)
          if (frame) {
            for (let a = 0; a < args.length; a++) {
              const h = args[a] as (((...x: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean; length: number }) | undefined
              if (typeof h === 'function' && !h.__neatHandlerWrapped && h.length <= 4) {
                const inner = h
                const neatHandler = function __neatHandler(this: unknown, ...hargs: unknown[]) {
                  const self = this
                  return stampHandler(frame, () => inner.apply(self, hargs))
                } as ((...x: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean }
                neatHandler.__neatHandlerWrapped = true
                args[a] = neatHandler
              }
            }
          }
          return (orig as (...a: unknown[]) => unknown).apply(this, args)
        }
      }
      target.__neatVerbsWrapped = true
    }
    type ConnectExports = { Router?: { prototype?: Record<string, unknown> }; application?: Record<string, unknown>; prototype?: Record<string, unknown> }
    // ESM imports arrive as a namespace whose default export is module.exports.
    const raw = mod as ConnectExports & { default?: ConnectExports }
    const m = raw && raw.default && !raw.application && !raw.Router ? raw.default : raw
    if (m && m.Router && m.Router.prototype) wrapTarget(m.Router.prototype)
    if (m && m.application) wrapTarget(m.application)
    if (m && m.prototype) wrapTarget(m.prototype)
  } catch {
    /* best-effort */
  }
}

// Handler-entry for fastify. Fastify publishes every new instance on the
// `fastify.initialization` diagnostics channel, so no module hook is needed and
// CJS and ESM apps are covered alike. An onRoute hook on the instance runs
// synchronously inside the app's own `fastify.get(...)` / `fastify.route(...)`
// call, so the registration frame is still on the stack there; child plugin
// contexts inherit the hook. The handler is wrapped to stamp the SERVER span
// with that frame and push it into context for downstream spans.
type FastifyRouteOptions = { handler?: ((...a: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean } }
type FastifyInstance = { addHook?: (name: string, fn: (opts: FastifyRouteOptions) => void) => unknown }

function wrapFastifyInstance(instance: FastifyInstance | undefined): void {
  try {
    if (!instance || typeof instance.addHook !== 'function') return
    instance.addHook('onRoute', function __neatOnRoute(routeOptions: FastifyRouteOptions) {
      try {
        const handler = routeOptions && routeOptions.handler
        if (typeof handler !== 'function' || handler.__neatHandlerWrapped) return
        const frame = pickUserFrame(new Error().stack)
        if (!frame) return
        const neatHandler = function __neatHandler(this: unknown, ...hargs: unknown[]) {
          const self = this
          return stampHandler(frame, () => handler.apply(self, hargs))
        } as ((...a: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean }
        neatHandler.__neatHandlerWrapped = true
        // Keep the handler's own name: the fastify instrumentation names its
        // request-handler span after it.
        Object.defineProperty(neatHandler, 'name', { value: handler.name, configurable: true })
        routeOptions.handler = neatHandler
      } catch {
        /* best-effort */
      }
    })
  } catch {
    /* best-effort */
  }
}

let fastifySubscribed = false
function installFastifyHandlerEntry(): void {
  if (fastifySubscribed) return
  try {
    diagnosticsChannel.subscribe('fastify.initialization', (message: unknown) => {
      wrapFastifyInstance((message as { fastify?: FastifyInstance } | undefined)?.fastify)
    })
    fastifySubscribed = true
  } catch {
    /* best-effort: an older Node without subscribe() keeps the stack-walk floor */
  }
}

// Off-stack facade: the mongodb driver's public Collection methods. mongodb 3.x
// reaches the server asynchronously (operation executors, promises), so the
// call site is pushed into context at the synchronous `collection.find(...)` /
// `insertOne(...)` call and read back by the processor when the CLIENT span
// starts. Wrapped per method, once; harmless where the stack walk already
// finds the frame.
const MONGO_COLLECTION_OPS = [
  'find', 'findOne', 'insert', 'insertOne', 'insertMany', 'update', 'updateOne', 'updateMany',
  'remove', 'deleteOne', 'deleteMany', 'replaceOne', 'save', 'aggregate', 'count', 'countDocuments',
  'distinct', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'findAndModify', 'bulkWrite',
]

function wrapMongoCollection(mod: unknown): void {
  try {
    type CollectionProto = Record<string, unknown> & { __neatWrapped?: boolean }
    const raw = mod as { Collection?: { prototype?: CollectionProto }; default?: { Collection?: { prototype?: CollectionProto } } }
    const proto = (raw && raw.Collection && raw.Collection.prototype) || (raw && raw.default && raw.default.Collection && raw.default.Collection.prototype)
    if (!proto || proto.__neatWrapped) return
    for (const op of MONGO_COLLECTION_OPS) {
      const orig = proto[op]
      if (typeof orig !== 'function') continue
      proto[op] = function __neatMongoCollectionOp(this: unknown, ...args: unknown[]) {
        const self = this
        const frame = pickUserFrame(new Error().stack)
        const run = () => (orig as (...a: unknown[]) => unknown).apply(self, args)
        if (!frame) return run()
        let result: unknown
        try {
          result = context.with(context.active().setValue(NEAT_USER_FRAME, frame), run)
        } catch (err) {
          throw err
        }
        // A cursor issues its query later (toArray / next), off this stack and
        // often off this async context; carry the frame on the cursor itself.
        if (result && typeof result === 'object' && typeof (result as { next?: unknown }).next === 'function') {
          try {
            Object.defineProperty(result, NEAT_USER_FRAME, { value: frame, configurable: true })
          } catch {
            /* frozen or exotic object: the context floor still applies */
          }
        }
        return result
      }
    }
    proto.__neatWrapped = true
  } catch {
    /* best-effort */
  }
}

// Handler-entry for socket.io (uptime-kuma's API is socket.io events, not HTTP
// routes). The socket.io instrumentation patches Socket.prototype.on so each
// incoming event runs its listener inside a CONSUMER span opened at dispatch,
// where the stack holds only socket.io internals. This wrap sits outside that
// patch (the instrumentation hooks the socket module as it loads; this hooks
// the package entry, which finishes loading after it), captures the frame of
// the app's own socket.on(...) call, and stamps the CONSUMER span when the
// listener runs.
type SocketProto = Record<string, unknown> & { __neatOnWrapped?: boolean }

// Socket.prototype carries the per-event listeners, the app's API surface. The
// one-per-client `io.on('connection', ...)` span is left unstamped.
function wrapSocketIo(mod: unknown): void {
  type SocketIoExports = { Socket?: { prototype?: SocketProto } }
  const raw = mod as SocketIoExports & { default?: SocketIoExports }
  const cls = (raw && raw.Socket) || (raw && raw.default && raw.default.Socket)
  wrapSocketIoOn(cls && cls.prototype)
}

function wrapSocketIoOn(proto: SocketProto | undefined): void {
  try {
    if (!proto || proto.__neatOnWrapped || typeof proto.on !== 'function') return
    const originalOn = proto.on as (...a: unknown[]) => unknown
    proto.on = function __neatSocketOn(this: unknown, ev: unknown, listener: unknown, ...rest: unknown[]) {
      const fn = listener as (((...x: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean }) | undefined
      if (typeof fn === 'function' && !fn.__neatHandlerWrapped) {
        const frame = pickUserFrame(new Error().stack)
        if (frame) {
          const neatListener = function __neatHandler(this: unknown, ...largs: unknown[]) {
            const self = this
            return stampHandler(frame, () => fn.apply(self, largs))
          } as ((...x: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean }
          neatListener.__neatHandlerWrapped = true
          Object.defineProperty(neatListener, 'name', { value: fn.name, configurable: true })
          return originalOn.call(this, ev, neatListener, ...rest)
        }
      }
      return originalOn.call(this, ev, listener, ...rest)
    }
    proto.__neatOnWrapped = true
  } catch {
    /* best-effort */
  }
}

// Off-stack facade: knex. A query executes later (on await / .then), off the
// app's stack. The builder is created synchronously inside the app's own call,
// so the frame and the client's dialect are captured there and carried to the
// query span, which then has a call site and a db.system even when the app
// configured knex with a dialect class rather than a client name.
const KNEX_DB_SYSTEMS: Record<string, string> = {
  sqlite3: 'sqlite', 'better-sqlite3': 'sqlite', pg: 'postgresql', postgres: 'postgresql', postgresql: 'postgresql',
  pgnative: 'postgresql', mysql: 'mysql', mysql2: 'mysql', mssql: 'mssql', oracledb: 'oracle', oracle: 'oracle',
  cockroachdb: 'cockroachdb', redshift: 'redshift',
}

type KnexClientLike = Record<string, unknown> & { dialect?: unknown; config?: { client?: unknown }; __neatWrapped?: boolean }

// Wrap one knex client's builder entry points. Done per instance, on the
// client the app's knex() call created, so a dialect that overrides
// queryBuilder (sqlite3 and postgres do) is covered the same as one that
// inherits it.
function wrapKnexClient(client: KnexClientLike | undefined): void {
  if (!client || client.__neatWrapped) return
  const dialect =
    (typeof client.dialect === 'string' && client.dialect) ||
    (client.config && typeof client.config.client === 'string' && client.config.client) ||
    undefined
  const system = dialect ? KNEX_DB_SYSTEMS[dialect] || dialect : undefined
  for (const method of ['queryBuilder', 'raw', 'schemaBuilder']) {
    const orig = client[method]
    if (typeof orig !== 'function') continue
    client[method] = function __neatKnexBuilder(this: unknown, ...args: unknown[]) {
      const builder = (orig as (...a: unknown[]) => unknown).apply(this, args) as
        | (Record<string, unknown> & { then?: unknown; __neatThen?: boolean })
        | undefined
      try {
        // The query runs when the builder is awaited, off this stack. Capture
        // the app's frame now, while it's still on the stack, and re-enter it
        // (with the dialect) around the builder's own then(): knex starts the
        // runner there, and its async chain, the query span included, inherits
        // that context. (The instrumentation's own builder-context capture is
        // bypassed by dialects that override queryBuilder: sqlite3, postgres.)
        if (builder && typeof builder.then === 'function' && !builder.__neatThen) {
          let ctx = context.active()
          const frame = pickUserFrame(new Error().stack)
          if (frame) ctx = ctx.setValue(NEAT_USER_FRAME, frame)
          if (system) ctx = ctx.setValue(NEAT_DB_SYSTEM, system)
          const origThen = builder.then as (...a: unknown[]) => unknown
          Object.defineProperty(builder, 'then', {
            configurable: true,
            writable: true,
            value: function __neatKnexThen(this: unknown, ...targs: unknown[]) {
              const self = this
              return context.with(ctx, () => origThen.apply(self, targs))
            },
          })
          Object.defineProperty(builder, '__neatThen', { value: true })
        }
      } catch {
        /* best-effort */
      }
      return builder
    }
  }
  client.__neatWrapped = true
}

// The knex package entry is the factory. Wrap it so every instance's client is
// wrapped as it is created; the factory's own properties (knex.knex,
// knex.Client, ...) are carried over.
function wrapKnex(mod: unknown): unknown {
  try {
    type Factory = ((...a: unknown[]) => { client?: KnexClientLike }) & { __neatWrapped?: boolean }
    const raw = mod as unknown
    const ns = raw as { default?: unknown } | undefined
    const factory = (typeof raw === 'function' ? raw : ns && typeof ns.default === 'function' ? ns.default : undefined) as
      | Factory
      | undefined
    if (!factory || factory.__neatWrapped) return mod
    const wrapped = function __neatKnex(this: unknown, ...args: unknown[]) {
      const instance = factory.apply(this, args)
      try {
        wrapKnexClient(instance && instance.client)
      } catch {
        /* best-effort */
      }
      return instance
    } as Factory
    for (const key of Object.getOwnPropertyNames(factory)) {
      if (key === 'length' || key === 'name' || key === 'prototype' || key === 'arguments' || key === 'caller') continue
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(factory, key) as PropertyDescriptor)
      } catch {
        /* skip non-copyable */
      }
    }
    // `const { knex } = require('knex')` reads this property; point it at the wrap too.
    ;(wrapped as unknown as Record<string, unknown>).knex = wrapped
    wrapped.__neatWrapped = true
    if (typeof raw === 'function') return wrapped
    ;(ns as { default?: unknown }).default = wrapped
    return mod
  } catch {
    return mod
  }
}

function installHandlerEntry(): void {
  installFastifyHandlerEntry()
  neatHook(['socket.io'], (exports: unknown) => {
    wrapSocketIo(exports)
    return exports
  })
  neatHook(['express'], (exports: unknown) => {
    wrapConnectStyle(exports)
    return exports
  })
  neatHook(['connect'], (exports: unknown) => {
    wrapConnectStyle(exports)
    return exports
  })
}

// Install every off-stack and handler-entry wrap. Called once after the SDK
// starts, before user code requires the framework / Prisma modules. Each wrap is
// independently guarded, so a failure degrades to the stack-walk + context floor.
export function installFacades(moduleLoaders: ModuleLoaders = {}): void {
  loaders = moduleLoaders
  wrapFetch()
  wrapPrisma()
  neatHook(['mongodb'], (exports: unknown) => {
    wrapMongoCollection(exports)
    return exports
  })
  neatHook(['knex'], (exports: unknown) => wrapKnex(exports))
  installHandlerEntry()
}

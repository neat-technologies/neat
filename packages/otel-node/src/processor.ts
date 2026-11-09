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
import { context, trace } from '@opentelemetry/api'

// Context key shared by the facade/handler wraps (writers) and the processor
// fallback (reader). Symbol.for keeps it stable across module instances.
const NEAT_USER_FRAME = Symbol.for('neat.user-frame')

export interface UserFrame {
  filepath: string
  lineno?: number
  function?: string
}

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
    if (!filepath) continue
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

// SpanProcessor: stamps CLIENT (2) / PRODUCER (3) spans with their call site.
export class NeatCallSiteSpanProcessor {
  onStart(span: { kind: number; setAttribute: (k: string, v: unknown) => void }, parentContext: unknown): void {
    if (!span || (span.kind !== 2 && span.kind !== 3)) return
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
function stampHandler<T>(frame: UserFrame, run: () => T): T {
  try {
    const active = trace.getActiveSpan() as { kind?: number; setAttribute?: (k: string, v: unknown) => void } | undefined
    if (active && active.kind === 1 && typeof active.setAttribute === 'function') {
      setCodeAttrs(active as { setAttribute: (k: string, v: unknown) => void }, frame)
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
// runs. The wrap list is the extensibility seam for koa / fastify / nestjs.
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

function installHandlerEntry(): void {
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
  installHandlerEntry()
}

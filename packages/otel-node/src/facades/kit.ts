// The narrow surface every facade is handed. A facade never reaches into the
// processor: it gets the module hook, the frame picker and the context setters
// through a FacadeKit, so it loads and tests on its own, and adding a framework
// means one file under src/facades plus one line in the registry (index.ts).
import { context, createContextKey, trace, type Context } from '@opentelemetry/api'
import { NEAT_DB_SYSTEM, NEAT_USER_FRAME, pickUserFrame, setCodeAttrs } from '../processor.js'
import type { UserFrame } from '../processor.js'

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

// Registers `onload` for `modules` with every hook available: require-in-the-
// middle for CommonJS loads and import-in-the-middle for ESM imports. Each wrap
// is idempotent, so a module seen by both hooks is wrapped once. Guarded: when
// neither hook is available the off-stack/handler wraps degrade to the stack
// walk + context floor.
function neatHook(
  loaders: ModuleLoaders,
  modules: string[],
  onload: (exports: unknown, name: string) => unknown,
): boolean {
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

export interface FacadeKit {
  /** Run `onload` when one of `modules` loads, through every module hook available. */
  hook(modules: string[], onload: (exports: unknown, name: string) => unknown): boolean
  /** The first application frame on a stack (layer 1). Pass `new Error().stack` from the wrapper itself. */
  pickUserFrame(stack: string | undefined): UserFrame | null
  /** Run `fn` with the caller's frame pushed into context (layer 3). */
  runWithUserFrame<T>(fn: () => T): T
  /** Stamp the active SERVER/CONSUMER span with `frame` and run `run` with it in context (layer 2). */
  stampHandler<T>(frame: UserFrame, run: () => T): T
  /** `ctx` carrying `frame` for the processor's context fallback. */
  withUserFrame(ctx: Context, frame: UserFrame): Context
  /** `ctx` carrying the database system the processor fills on a knex span. */
  withDbSystem(ctx: Context, system: string): Context
  /** Attach `frame` to an object whose query runs later off this context (a mongodb cursor). Throws on a frozen object. */
  carryFrame(target: object, frame: UserFrame): void
}

export interface Facade {
  name: string
  install(kit: FacadeKit): void
}

export function createFacadeKit(loaders: ModuleLoaders): FacadeKit {
  return {
    hook: (modules, onload) => neatHook(loaders, modules, onload),
    pickUserFrame,
    runWithUserFrame,
    stampHandler,
    withUserFrame: (ctx, frame) => ctx.setValue(NEAT_USER_FRAME, frame),
    withDbSystem: (ctx, system) => ctx.setValue(NEAT_DB_SYSTEM, system),
    carryFrame: (target, frame) => {
      Object.defineProperty(target, NEAT_USER_FRAME, { value: frame, configurable: true })
    },
  }
}

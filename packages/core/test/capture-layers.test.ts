// Layered capture mechanism (file-awareness.md §4–6, ADR-090).
//
// The capture spike (callsite-processor.test.ts) covers layer 1 — the
// synchronous stack walk. This exercises the layers the spike didn't: the
// context fallback the processor reads (layer 2/3 sink) and the undici/fetch
// off-stack facade (layer 3 source) that pushes the call-site frame into
// context so an instrumentation that creates its span off the caller's stack
// still attributes to the user's file. The exact bytes that ship in the
// generated otel-init (CALLSITE_PROCESSOR_JS) are materialised and run, the way
// the spike does, so a regression here fails CI before it ships.

import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CALLSITE_PROCESSOR_JS } from '../src/installers/templates.js'

// The generated file pulls `context` / `trace` from @opentelemetry/api; the
// real off-stack mechanism needs a working ContextManager (the SDK registers
// AsyncLocalStorage at start), so resolve both from this package and wire them.
const require = createRequire(import.meta.url)
const apiPath = require.resolve('@opentelemetry/api')
const { context, trace } = require(apiPath)
const { AsyncLocalStorageContextManager } = require(
  require.resolve('@opentelemetry/context-async-hooks'),
)

const NEAT_USER_FRAME = Symbol.for('neat.user-frame')

interface CaptureModule {
  NeatCallSiteSpanProcessor: new () => {
    onStart: (span: FakeSpan, parentContext?: unknown) => void
  }
  __neatInstallFacades: () => void
  __neatRunWithUserFrame: <T>(fn: () => T) => T
}

interface FakeSpan {
  kind: number
  attributes: Record<string, unknown>
  setAttribute: (k: string, v: unknown) => void
}

function fakeSpan(kind: number): FakeSpan {
  const attributes: Record<string, unknown> = {}
  return { kind, attributes, setAttribute(k, v) { attributes[k] = v } }
}

const CLIENT = 2
const SERVER = 1

const tmp = mkdtempSync(join(tmpdir(), 'neat-capture-'))
const modulePath = join(tmp, 'otel-init.cjs')
writeFileSync(
  modulePath,
  `const { context, trace } = require(${JSON.stringify(apiPath)})\n` +
    `${CALLSITE_PROCESSOR_JS}\n` +
    `module.exports = { NeatCallSiteSpanProcessor, __neatInstallFacades, __neatRunWithUserFrame }\n`,
  'utf8',
)
const mod = require(modulePath) as CaptureModule

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
})

describe('processor context fallback (file-awareness §4 layer 2/3 sink)', () => {
  // A library-only synchronous stack so the layer-1 walk yields nothing and the
  // processor must read the frame a handler-entry / facade wrap left in context.
  const libOnlyStack = [
    'Error',
    '    at Object.onStart (/app/node_modules/@opentelemetry/sdk-trace-base/build/src/Tracer.js:1:1)',
    '    at Agent.<anonymous> (/app/node_modules/undici/lib/dispatcher.js:2:2)',
    '    at node:internal/process/task_queues:3:3',
  ].join('\n')

  let RealError: ErrorConstructor
  afterEach(() => {
    if (RealError) globalThis.Error = RealError
  })

  // Stub the global Error so the processor's `new Error().stack` returns a
  // library-only stack, forcing the layer-1 walk to yield nothing. A plain
  // constructor that sets its own `stack` sidesteps V8's captureStackTrace
  // (which would install a real own-property `stack` and shadow a getter).
  function withLibOnlyStack<T>(run: () => T): T {
    RealError = globalThis.Error
    function StubError(this: { stack: string }): void {
      this.stack = libOnlyStack
    }
    globalThis.Error = StubError as unknown as ErrorConstructor
    try {
      return run()
    } finally {
      globalThis.Error = RealError
    }
  }

  it('reads code.* from the context frame when the stack carries no user frame', () => {
    const frame = { filepath: '/app/src/routes/users.ts', lineno: 42, function: 'getUser' }
    const span = fakeSpan(CLIENT)
    const proc = new mod.NeatCallSiteSpanProcessor()
    context.with(context.active().setValue(NEAT_USER_FRAME, frame), () => {
      withLibOnlyStack(() => proc.onStart(span, context.active()))
    })
    expect(span.attributes['code.filepath']).toBe('/app/src/routes/users.ts')
    expect(span.attributes['code.lineno']).toBe(42)
    expect(span.attributes['code.function']).toBe('getUser')
  })

  it('sets nothing when neither the stack nor the context carries a frame', () => {
    const span = fakeSpan(CLIENT)
    const proc = new mod.NeatCallSiteSpanProcessor()
    withLibOnlyStack(() => proc.onStart(span, context.active()))
    expect(span.attributes['code.filepath']).toBeUndefined()
  })

  it('never touches SERVER spans (the handler-entry wrap stamps those directly)', () => {
    const frame = { filepath: '/app/src/server.ts', lineno: 9, function: 'boot' }
    const span = fakeSpan(SERVER)
    const proc = new mod.NeatCallSiteSpanProcessor()
    context.with(context.active().setValue(NEAT_USER_FRAME, frame), () => {
      withLibOnlyStack(() => proc.onStart(span, context.active()))
    })
    expect(span.attributes['code.filepath']).toBeUndefined()
  })
})

describe('undici / fetch off-stack facade (file-awareness §4 layer 3 source)', () => {
  let realFetch: typeof globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('pushes the user call-site frame into context for an off-stack inner call', async () => {
    // The fake stands in for undici: it creates its span in a microtask, after
    // the caller's synchronous stack is gone. The frame must come from context.
    let seen: unknown = 'NONE'
    realFetch = globalThis.fetch
    globalThis.fetch = function fakeUndiciFetch() {
      return Promise.resolve().then(() => {
        seen = context.active().getValue(NEAT_USER_FRAME)
        return 'ok'
      }) as unknown as Promise<Response>
    }
    mod.__neatInstallFacades()

    async function userRoute() {
      return globalThis.fetch('https://api.example.com/v1/things')
    }
    await userRoute()

    expect(seen).not.toBe('NONE')
    expect(seen).toBeTruthy()
    const frame = seen as { filepath: string; function?: string }
    // The captured frame is the user's call site, not the facade's own frame.
    expect(frame.function).toBe('userRoute')
    expect(frame.filepath).toContain('capture-layers.test')
    expect(frame.filepath).not.toContain('otel-init')
    expect(frame.filepath).not.toContain('node_modules')
  })

  it('preserves the call-through result', async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = function fakeFetch() {
      return Promise.resolve('passed-through') as unknown as Promise<Response>
    }
    mod.__neatInstallFacades()
    const out = await (globalThis.fetch('https://x') as unknown as Promise<string>)
    expect(out).toBe('passed-through')
  })

  it('is idempotent — a second install does not double-wrap', () => {
    realFetch = globalThis.fetch
    const base = function originalFetch() { return Promise.resolve() as unknown as Promise<Response> }
    globalThis.fetch = base
    mod.__neatInstallFacades()
    const afterFirst = globalThis.fetch
    mod.__neatInstallFacades()
    expect(globalThis.fetch).toBe(afterFirst)
  })
})

describe('@prisma/client off-stack facade (file-awareness §4 layer 3 source)', () => {
  // This is the hardest capture tier and the one the other suites skip. The
  // fetch test above wraps a global; the synthetic-stack tests in
  // callsite-processor.test.ts only feed `'PrismaClient'` to the pure parser.
  // Neither constructs a client. This drives `__neatWrapPrisma` end to end: the
  // facade hooks `require('@prisma/client')` through require-in-the-middle,
  // replaces `PrismaClient` with a construct-trapping Proxy, and wraps each
  // model method so the synchronous call-site frame is pushed into context
  // before the engine dispatches off-stack.
  //
  // The model stand-in mirrors the shape the facade wraps (templates.ts
  // §272–364): a `PrismaClient` class whose model accessors (`prisma.user`) are
  // objects carrying the operation methods, and each method returns a promise
  // that resolves in a microtask — after the caller's synchronous stack is gone,
  // standing in for Prisma's Rust query engine backdating its span off-stack.
  // Inside that microtask the model reads the active context frame and feeds it
  // to the real call-site processor, the same join ingest performs on a live
  // engine span. The assertion is that the resulting code.* lands on the *user's*
  // call site, file-grained, not on the facade or the library.
  //
  // What this covers: the construct-Proxy + per-method wrap, the context push
  // surviving a real promise boundary, and the processor reading it back to set
  // file-grained code.*. What it can't reproduce in a unit test: the genuine
  // Rust-engine span emission and its post-hoc backdated start time — there is no
  // Rust engine here. The seam under test is the JS facade's context push, which
  // is exactly the part NEAT owns and the part that decides file-grain.

  // A `PrismaClient` whose model methods defer to a microtask, then read the
  // user frame the facade pushed into context and hand it to the processor —
  // the way ingest joins a live engine span against its call site.
  const PRISMA_CLIENT_STUB = (apiPathArg: string) => `
const { context, trace } = require(${JSON.stringify('PLACEHOLDER')})
const NEAT_USER_FRAME = Symbol.for('neat.user-frame')
const OPS = ['findUnique','findMany','create','update','delete']
function makeModel(captured) {
  const model = {}
  for (const op of OPS) {
    model[op] = function (args) {
      // Off-stack: the caller's synchronous stack is gone by the time this
      // resolves, so a stack walk here would miss the user frame. The frame
      // must come from the context the facade pushed at the wrap point.
      return Promise.resolve().then(function () {
        const frame = context.active().getValue(NEAT_USER_FRAME)
        captured.push({ op: op, frame: frame })
        return { op: op, args: args }
      })
    }
  }
  return model
}
class PrismaClient {
  constructor() {
    this.__neatCaptured = []
    // Model accessor — a plain object the construct-Proxy's get-trap wraps.
    this.user = makeModel(this.__neatCaptured)
  }
}
module.exports = { PrismaClient }
`.replace(JSON.stringify('PLACEHOLDER'), JSON.stringify(apiPathArg))

  function buildPrismaSandbox(): {
    Client: new () => {
      user: Record<string, (args?: unknown) => Promise<unknown>>
      __neatCaptured: Array<{ op: string; frame: unknown }>
    }
  } {
    // The materialised otel-init lives in a temp dir; the Prisma facade calls
    // require('require-in-the-middle') and require('@prisma/client') by name, so
    // both must resolve from there. Give the temp dir its own node_modules: a
    // re-export shim for the real require-in-the-middle, plus the fake client.
    const ritmPath = require.resolve('require-in-the-middle')
    const sandbox = mkdtempSync(join(tmpdir(), 'neat-prisma-'))
    const nm = join(sandbox, 'node_modules')

    const ritmShim = join(nm, 'require-in-the-middle')
    mkdirSync(ritmShim, { recursive: true })
    writeFileSync(join(ritmShim, 'package.json'), JSON.stringify({ name: 'require-in-the-middle', version: '0.0.0', main: 'index.js' }))
    writeFileSync(join(ritmShim, 'index.js'), `module.exports = require(${JSON.stringify(ritmPath)})\n`)

    const prismaPkg = join(nm, '@prisma', 'client')
    mkdirSync(prismaPkg, { recursive: true })
    writeFileSync(join(prismaPkg, 'package.json'), JSON.stringify({ name: '@prisma/client', version: '5.0.0', main: 'index.js' }))
    writeFileSync(join(prismaPkg, 'index.js'), PRISMA_CLIENT_STUB(apiPath))

    // The otel-init carrying the facade. require() resolves from this file's
    // own dir, so require-in-the-middle and @prisma/client both come from the
    // sandbox node_modules above.
    const initPath = join(sandbox, 'otel-init.cjs')
    writeFileSync(
      initPath,
      `const { context, trace } = require(${JSON.stringify(apiPath)})\n` +
        `${CALLSITE_PROCESSOR_JS}\n` +
        `module.exports = { __neatInstallFacades }\n`,
      'utf8',
    )
    const sandboxRequire = createRequire(initPath)
    const sandboxMod = sandboxRequire(initPath) as { __neatInstallFacades: () => void }

    // Install the facade, then require the client by name — the hook fires on
    // first require and swaps in the construct-trapping Proxy.
    sandboxMod.__neatInstallFacades()
    const client = sandboxRequire('@prisma/client') as {
      PrismaClient: new () => {
        user: Record<string, (args?: unknown) => Promise<unknown>>
        __neatCaptured: Array<{ op: string; frame: unknown }>
      }
    }
    return { Client: client.PrismaClient }
  }

  it('pushes the user call-site frame into context for the off-stack engine dispatch', async () => {
    const { Client } = buildPrismaSandbox()
    const prisma = new Client()

    // The user's call site. The frame captured must be this function, not the
    // facade wrap and not the Prisma library.
    async function listUsers() {
      return prisma.user.findMany({ where: { active: true } })
    }
    await listUsers()

    expect(prisma.__neatCaptured).toHaveLength(1)
    const { op, frame } = prisma.__neatCaptured[0] as {
      op: string
      frame: { filepath: string; lineno: number; function?: string }
    }
    expect(op).toBe('findMany')
    expect(frame).toBeTruthy()
    // File-grained: the user's own call site, not service-coarse, not the facade.
    expect(frame.function).toBe('listUsers')
    expect(frame.filepath).toContain('capture-layers.test')
    expect(frame.filepath).not.toContain('otel-init')
    expect(frame.filepath).not.toContain('node_modules')
    expect(typeof frame.lineno).toBe('number')
    expect(frame.lineno).toBeGreaterThan(0)
  })

  it('lands file-grained code.* on the resulting off-stack CLIENT span', async () => {
    // Drive the full join: the engine span carries no synchronous user stack
    // (it's backdated off-stack), so the processor's layer-1 walk yields nothing
    // and it falls back to the context frame the facade pushed at the call site.
    // The CLIENT span (kind 2) then gets stamped with that frame — exactly the
    // attribution ingest reads off a live engine span. This asserts the OBSERVED
    // edge would carry code.filepath / code.lineno (file grain), not just that
    // the frame reached context.
    const { Client } = buildPrismaSandbox()
    const prisma = new Client()
    const proc = new mod.NeatCallSiteSpanProcessor()

    // The engine creates its span off the caller's stack, so a stack walk at
    // onStart sees only library frames. Stub the global Error to a library-only
    // stack to reproduce that — the way the existing fallback test does — so the
    // processor must use the context frame, not a synchronous walk.
    const libOnlyStack = [
      'Error',
      '    at PrismaClient._request (/app/node_modules/@prisma/client/runtime/library.js:50:10)',
      '    at node:internal/process/task_queues:3:3',
    ].join('\n')
    const RealError = globalThis.Error
    function StubError(this: { stack: string }): void {
      this.stack = libOnlyStack
    }

    let span: FakeSpan
    async function findActiveUser() {
      await prisma.user.findUnique({ where: { id: 1 } })
      const frame = prisma.__neatCaptured[0].frame
      span = fakeSpan(CLIENT)
      // The engine span is created while the call-site context is active; the
      // facade pushed the user frame there. Stamp under a library-only stack so
      // only the context-fallback path can attribute the span.
      context.with(context.active().setValue(NEAT_USER_FRAME, frame), () => {
        globalThis.Error = StubError as unknown as ErrorConstructor
        try {
          proc.onStart(span, context.active())
        } finally {
          globalThis.Error = RealError
        }
      })
    }
    await findActiveUser()

    expect(span!.attributes['code.function']).toBe('findActiveUser')
    expect(span!.attributes['code.filepath']).toContain('capture-layers.test')
    expect(span!.attributes['code.filepath']).not.toContain('node_modules')
    expect(typeof span!.attributes['code.lineno']).toBe('number')
  })

  it('preserves the call-through result', async () => {
    const { Client } = buildPrismaSandbox()
    const prisma = new Client()
    const out = (await prisma.user.create({ data: { name: 'x' } })) as { op: string }
    expect(out.op).toBe('create')
  })

  it('does not double-wrap a second client constructed from the same module', async () => {
    const { Client } = buildPrismaSandbox()
    const a = new Client()
    const b = new Client()
    async function callerOne() {
      return a.user.findMany()
    }
    async function callerTwo() {
      return b.user.findMany()
    }
    await callerOne()
    await callerTwo()
    const frameA = a.__neatCaptured[0].frame as { function?: string }
    const frameB = b.__neatCaptured[0].frame as { function?: string }
    // Each construction's model methods are wrapped exactly once, so each
    // caller's own frame is captured — a double-wrap would push the wrong frame.
    expect(frameA.function).toBe('callerOne')
    expect(frameB.function).toBe('callerTwo')
  })
})

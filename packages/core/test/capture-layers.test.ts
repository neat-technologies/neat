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
import { mkdtempSync, writeFileSync } from 'node:fs'
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

// Step-0 capture spike (file-awareness.md §4–5, ADR-089 dispatch).
//
// The whole file-first OBSERVED layer rests on one question: does the user's
// call-site frame survive to span creation, across a real promise boundary, so
// the injected SpanProcessor can read it synchronously? This spike answers it
// in isolation — no running Brief — by materialising the exact processor source
// that ships in the generated otel-init (CALLSITE_PROCESSOR_JS) and exercising
// it. If this fails, nothing downstream is trustworthy.
//
// The live-Brief confirmation (capture landing on brief-api's real source on a
// running service) is the maintainer's pre-merge gate, run separately.

import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CALLSITE_PROCESSOR_JS } from '../src/installers/templates.js'

// Materialise the processor source into a real .cjs module so its frames carry
// a real file path (the way they will in a user's project), then require it.
const require = createRequire(import.meta.url)
const tmp = mkdtempSync(join(tmpdir(), 'neat-callsite-'))
const modulePath = join(tmp, 'otel-init.cjs')
writeFileSync(
  modulePath,
  `${CALLSITE_PROCESSOR_JS}\nmodule.exports = { __neatPickUserFrame, NeatCallSiteSpanProcessor }\n`,
  'utf8',
)

interface CallsiteModule {
  __neatPickUserFrame: (stack: string) =>
    | { filepath: string; lineno: number; function?: string }
    | null
  NeatCallSiteSpanProcessor: new () => {
    onStart: (span: FakeSpan) => void
    onEnd: () => void
    forceFlush: () => Promise<void>
    shutdown: () => Promise<void>
  }
}

const mod = require(modulePath) as CallsiteModule

interface FakeSpan {
  kind: number
  attributes: Record<string, unknown>
  setAttribute: (k: string, v: unknown) => void
}

function fakeSpan(kind: number): FakeSpan {
  const attributes: Record<string, unknown> = {}
  return {
    kind,
    attributes,
    setAttribute(k, v) {
      attributes[k] = v
    },
  }
}

// API SpanKind values (the runtime enum the SpanProcessor sees, not the OTLP
// wire numbering): INTERNAL 0, SERVER 1, CLIENT 2, PRODUCER 3, CONSUMER 4.
const CLIENT = 2
const PRODUCER = 3
const SERVER = 1
const INTERNAL = 0

afterAll(() => {
  // tmp dir is left for the OS to reap; nothing sensitive, and unlinking the
  // required module mid-suite risks a loader race on some platforms.
})

describe('call-site frame selection (pure)', () => {
  it('picks the first user frame, skipping node_modules / @opentelemetry / processor / node: frames', () => {
    const stack = [
      'Error',
      '    at NeatCallSiteSpanProcessor.onStart (/tmp/otel-init.cjs:30:20)',
      '    at Span.<anonymous> (/app/node_modules/@opentelemetry/sdk-trace-base/build/src/Tracer.js:120:5)',
      '    at PrismaClient._request (/app/node_modules/@prisma/client/runtime/library.js:50:10)',
      '    at getUser (/app/src/routes/users.ts:42:18)',
      '    at /app/src/server.ts:10:3',
    ].join('\n')
    expect(mod.__neatPickUserFrame(stack)).toEqual({
      filepath: '/app/src/routes/users.ts',
      lineno: 42,
      function: 'getUser',
    })
  })

  it('parses file:// urls and the async frame prefix', () => {
    const stack = ['Error', '    at async sendRequest (file:///app/src/client.mjs:7:9)'].join('\n')
    expect(mod.__neatPickUserFrame(stack)).toEqual({
      filepath: '/app/src/client.mjs',
      lineno: 7,
      function: 'sendRequest',
    })
  })

  it('parses an anonymous (no function name) frame', () => {
    const stack = ['Error', '    at /app/src/worker.ts:3:1'].join('\n')
    expect(mod.__neatPickUserFrame(stack)).toEqual({
      filepath: '/app/src/worker.ts',
      lineno: 3,
      function: undefined,
    })
  })

  it('returns null when every frame is library code', () => {
    const stack = [
      'Error',
      '    at NeatCallSiteSpanProcessor.onStart (/tmp/otel-init.cjs:30:20)',
      '    at wrap (/app/node_modules/@opentelemetry/instrumentation-http/build/src/http.js:1:1)',
    ].join('\n')
    expect(mod.__neatPickUserFrame(stack)).toBeNull()
  })
})

describe('NeatCallSiteSpanProcessor.onStart across a real await', () => {
  // The synthetic outbound call: await a real promise (resetting the sync
  // stack), then invoke the processor the way the SDK would at span creation.
  // The captured frame must be this function, not the processor's own frame.
  async function userCallSite(span: FakeSpan): Promise<void> {
    await Promise.resolve()
    const processor = new mod.NeatCallSiteSpanProcessor()
    processor.onStart(span)
  }

  it('captures the user frame on a CLIENT span after the promise boundary', async () => {
    const span = fakeSpan(CLIENT)
    await userCallSite(span)
    expect(span.attributes['code.function']).toBe('userCallSite')
    const filepath = span.attributes['code.filepath']
    expect(typeof filepath).toBe('string')
    expect(filepath as string).not.toContain('node_modules')
    expect(filepath as string).not.toContain('otel-init.cjs')
    expect(typeof span.attributes['code.lineno']).toBe('number')
    expect(span.attributes['code.lineno'] as number).toBeGreaterThan(0)
  })

  it('captures on a PRODUCER span too', async () => {
    const span = fakeSpan(PRODUCER)
    await userCallSite(span)
    expect(span.attributes['code.function']).toBe('userCallSite')
  })

  it('sets nothing on SERVER or INTERNAL spans (only outbound gets a call site)', async () => {
    const server = fakeSpan(SERVER)
    await userCallSite(server)
    expect(server.attributes['code.filepath']).toBeUndefined()

    const internal = fakeSpan(INTERNAL)
    await userCallSite(internal)
    expect(internal.attributes['code.filepath']).toBeUndefined()
  })
})

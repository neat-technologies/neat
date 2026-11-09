import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { wire } from '../src/index.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

// The E2E tests attach the built package to a child node process, so dist must
// exist. Under `turbo build test` it already does; building here makes a bare
// `vitest run` self-contained too.
beforeAll(() => {
  if (!existsSync(path.join(PKG_ROOT, 'dist', 'index.cjs'))) {
    execSync('npm run build', { cwd: PKG_ROOT, stdio: 'ignore' })
  }
}, 60000)

// Run a fixture app with the attachment flag and the OTel console exporter, and
// return the child's combined output. The console exporter prints each span
// (with its attributes) so we can assert the stamp without a live collector.
function runAttached(flag: '--require' | '--import', entry: string): string {
  const res = spawnSync(process.execPath, [flag, path.join(PKG_ROOT, flag === '--require' ? 'register.cjs' : 'register.mjs'), path.join(FIXTURES, entry)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OTEL_TRACES_EXPORTER: 'console',
      OTEL_SERVICE_NAME: 'neat-otel-node-test',
      OTEL_LOG_LEVEL: 'error',
    },
  })
  return (res.stdout ?? '') + (res.stdout && res.stderr ? '\n' : '') + (res.stderr ?? '')
}

describe('@neat.is/otel-node attachment', () => {
  it('stamps code.file.path on the outbound CLIENT span of an unmodified CJS app (--require)', () => {
    const out = runAttached('--require', 'app.cjs')
    expect(out).toContain('code.file.path')
    expect(out).toContain('app.cjs')
  })

  it('stamps code.file.path on the outbound CLIENT span of an unmodified ESM app (--import + loader hook)', () => {
    const out = runAttached('--import', 'app.mjs')
    expect(out).toContain('code.file.path')
    expect(out).toContain('app.mjs')
  })

  // The console exporter prints one object per span. Pull out the SERVER span
  // (kind 1) block so the assertion can't be satisfied by the CLIENT span.
  function serverSpan(out: string): string {
    const blocks = out.split(/\n\{\n/)
    return blocks.find((b) => /\n\s*kind: 1,/.test(b)) ?? ''
  }

  it.each([
    ['--require', 'express-handler.cjs'],
    ['--import', 'express-handler.mjs'],
    ['--require', 'fastify-handler.cjs'],
    ['--import', 'fastify-handler.mjs'],
  ] as const)('stamps the SERVER span with the route registration line (%s %s)', (flag, entry) => {
    const span = serverSpan(runAttached(flag, entry))
    expect(span).toContain(`'code.file.path': '${path.join(FIXTURES, entry)}'`)
    // Line 6 is the app.get(...) registration, not NEAT's own wrapper frame. The
    // fastify handler runs under the instrumentation's INTERNAL span, so this
    // also proves the SERVER span is reached through the RPC metadata.
    expect(span).toContain("'code.line.number': 6")
    expect(span).not.toContain(path.join(PKG_ROOT, 'dist'))
  })

  // The socket.io instrumentation runs each event listener inside a CONSUMER
  // span opened at dispatch; the stamp is the app's socket.on(...) line.
  it('stamps the socket.io CONSUMER span with the event handler registration line', () => {
    const out = runAttached('--require', 'socketio-handler.cjs')
    const blocks = out.split(/\n\{\n/)
    const span = blocks.find((b) => b.includes("'messaging.socket.io.event_name': 'getMonitorList'")) ?? ''
    expect(span).toMatch(/\n\s*kind: 4,/)
    expect(span).toContain(`'code.file.path': '${path.join(FIXTURES, 'socketio-handler.cjs')}'`)
    expect(span).toContain("'code.line.number': 9")
  })

  it('keeps the fastify handler name on the instrumentation span', () => {
    const out = runAttached('--require', 'fastify-handler.cjs')
    expect(out).not.toContain('__neat')
  })

  it('registers exactly once even if wire() is called twice (single-registration guard)', () => {
    let sdkStarts = 0
    const makeDeps = () => {
      const procs: unknown[] = []
      return {
        NodeSDK: class {
          start() {
            sdkStarts++
          }
        },
        getNodeAutoInstrumentations: () => [],
        trace: {
          getTracerProvider: () => ({
            getDelegate: () => ({
              addSpanProcessor: (p: unknown) => procs.push(p),
              _registeredSpanProcessors: procs,
            }),
          }),
        },
      }
    }
    wire(makeDeps())
    wire(makeDeps())
    expect(sdkStarts).toBe(1)
  })
})

import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import * as tpl from '../src/installers/templates.js'

// #1353 — every generated init that holds the SDK shuts it down on exit, so a
// short-lived process exports its last batch. The preload's behaviour is tested
// end to end in @neat.is/otel-node (test/exit.test.ts); here the generated
// bytes carry the same hook and still parse.

const VARIANTS: Record<string, string> = {
  OTEL_INIT_CJS: tpl.OTEL_INIT_CJS,
  OTEL_INIT_TS_CJS: tpl.OTEL_INIT_TS_CJS,
  OTEL_INIT_ESM: tpl.OTEL_INIT_ESM,
  OTEL_INIT_TS: tpl.OTEL_INIT_TS,
  REMIX_OTEL_SERVER_TS: tpl.REMIX_OTEL_SERVER_TS,
  REMIX_OTEL_SERVER_JS: tpl.REMIX_OTEL_SERVER_JS,
}

describe('generated otel-init flushes on exit (#1353)', () => {
  for (const [name, body] of Object.entries(VARIANTS)) {
    it(`${name} shuts the SDK down on beforeExit and SIGTERM/SIGINT, bounded`, () => {
      expect(body).toContain("process.once('beforeExit'")
      expect(body).toContain('sdk.shutdown()')
      expect(body).toContain("['SIGTERM', 'SIGINT']")
      expect(body).toContain('setTimeout(() => resolve(true), 2000)')
      // Exit is forced only when the flush timed out (app cleanup still runs).
      expect(body).toContain('if (timedOut) process.exit(')
    })
  }

  it('the CommonJS init still parses', () => {
    const src = tpl.OTEL_INIT_CJS.replace(/__INSTRUMENTATION_BLOCK__/g, '')
    expect(() => new vm.Script(src)).not.toThrow()
  })

  it('the stamp moves so installs generated before the fix are regenerated', () => {
    expect(tpl.OTEL_INIT_STAMP).toContain('neat-template-version: 9')
    expect(tpl.OTEL_INIT_STAMP).toContain('#1353')
  })
})

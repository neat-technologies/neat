import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { flagEventAttributes } from '../src/instrumentations/openfeature.js'

// A flag evaluation through OpenFeature lands as a `feature_flag.evaluation`
// event on the span active at the time, in the semconv shape core's ingest
// reads. These run the real @openfeature/server-sdk under the preload with
// its in-memory provider, so the hook is registered with no source edit.

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

beforeAll(() => {
  if (!existsSync(path.join(PKG_ROOT, 'dist', 'index.cjs'))) {
    execSync('npm run build', { cwd: PKG_ROOT, stdio: 'ignore' })
  }
}, 60000)

function run(flag: '--require' | '--import', entry: string): string {
  const res = spawnSync(
    process.execPath,
    [flag, path.join(PKG_ROOT, flag === '--require' ? 'register.cjs' : 'register.mjs'), path.join(FIXTURES, entry)],
    {
      encoding: 'utf8',
      cwd: PKG_ROOT,
      env: { ...process.env, OTEL_TRACES_EXPORTER: 'console', OTEL_SERVICE_NAME: 'flag-test', OTEL_LOG_LEVEL: 'error' },
      timeout: 20000,
    },
  )
  return (res.stdout ?? '') + '\n' + (res.stderr ?? '')
}

describe('OpenFeature flag evaluations', () => {
  it('records each evaluation in a request as an event on its SERVER span (CJS)', () => {
    const out = run('--require', 'openfeature.cjs')
    const events = out.match(/name: 'feature_flag\.evaluation'/g) ?? []
    // Three in the request; the one at boot had no span.
    expect(events).toHaveLength(3)
    expect(out).toContain("'feature_flag.key': 'cartFailure'")
    expect(out).toContain("'feature_flag.provider.name': 'in-memory'")
    expect(out).toContain("'feature_flag.result.variant': 'on'")
    expect(out).toContain("'feature_flag.result.reason': 'static'")
    expect(out).toContain("'feature_flag.result.value': 'true'")
    // The missing flag errors and the caller gets its code default.
    expect(out).toContain("'error.type': 'flag_not_found'")
    expect(out).toContain("'feature_flag.result.value': 'dflt'")
  })

  it('never records the evaluation context or an object value', () => {
    const out = run('--require', 'openfeature.cjs')
    expect(out).not.toContain('user-42')
    expect(out).not.toContain('a@b.c')
    expect(out).not.toContain('columns')
  })

  it('records evaluations in an ESM app loaded with --import', () => {
    const out = run('--import', 'openfeature.mjs')
    expect(out).toContain("'feature_flag.key': 'paymentFailure'")
    expect(out).toContain("'feature_flag.result.variant': '50%'")
    expect(out).toContain("'feature_flag.result.value': '0.5'")
  })
})

describe('flagEventAttributes', () => {
  it('needs a flag key', () => {
    expect(flagEventAttributes({})).toBeUndefined()
  })

  it('falls back to a general error type when the error carries no code', () => {
    expect(flagEventAttributes({ flagKey: 'f', defaultValue: 3 }, undefined, new Error('boom'))).toEqual({
      'feature_flag.key': 'f',
      'error.type': 'general',
      'feature_flag.result.reason': 'error',
      'feature_flag.result.value': '3',
    })
  })
})

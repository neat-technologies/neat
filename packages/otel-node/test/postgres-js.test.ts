import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { statementOf } from '../src/instrumentations/postgres-js.js'

// postgres.js has no upstream OTel instrumentation; @neat.is/otel-node ships
// one. These run the real `postgres` package against a closed port, so each
// query executes and is rejected (connection refused) — the full span path
// without a database.

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
      env: { ...process.env, OTEL_TRACES_EXPORTER: 'console', OTEL_SERVICE_NAME: 'pgjs-test', OTEL_LOG_LEVEL: 'error' },
      timeout: 20000,
    },
  )
  return (res.stdout ?? '') + '\n' + (res.stderr ?? '')
}

describe('postgres.js instrumentation', () => {
  it('emits a CLIENT span per executed query with the database, statement and call site (CJS)', () => {
    const out = run('--require', 'postgresjs.cjs')
    expect(out).toContain("'db.system': 'postgresql'")
    expect(out).toContain("'db.statement': 'select * from payments where id = $1'")
    expect(out).toContain("'net.peer.name': '127.0.0.1'")
    expect(out).toContain("'db.name': 'orders'")
    expect(out).toMatch(/'code\.file\.path': '[^']*postgresjs\.cjs'/)
    expect(out).toContain("'code.function.name': 'chargeCard'")
    // The refused connection lands as an error on the span.
    expect(out).toMatch(/code: 2/)
  })

  it('does not start a span for a query that is built but never run', () => {
    const out = run('--require', 'postgresjs.cjs')
    expect(out).not.toContain('never executed')
    // Only the one executed query, not the probe or the unexecuted one.
    expect(out.match(/'db\.system': 'postgresql'/g)?.length).toBe(1)
  })

  it('instruments an ESM app loaded with --import', () => {
    const out = run('--import', 'postgresjs.mjs')
    expect(out).toContain("'db.statement': 'select id from orders limit $1'")
    expect(out).toMatch(/'code\.file\.path': '[^']*postgresjs\.mjs'/)
  })
})

describe('statementOf', () => {
  it('rebuilds a tagged statement with $n placeholders and passes unsafe text through', () => {
    expect(statementOf({ tagged: true, strings: ['select * from t where a = ', ' and b = ', ''] })).toBe(
      'select * from t where a = $1 and b = $2',
    )
    expect(statementOf({ tagged: false, strings: 'select 1' })).toBe('select 1')
  })
})

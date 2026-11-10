import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// knex configured with a dialect class (uptime-kuma via redbean-node) leaves the
// upstream knex instrumentation without a db.system, and its query spans carry
// no call site because the query runs on await, off the app's stack. The fixture
// uses a fake dialect that answers queries itself, so no database is involved.

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

beforeAll(() => {
  if (!existsSync(path.join(PKG_ROOT, 'dist', 'index.cjs'))) {
    execSync('npm run build', { cwd: PKG_ROOT, stdio: 'ignore' })
  }
}, 60000)

describe('knex facade', () => {
  it('fills db.system from the client dialect and stamps the call site on the query span', () => {
    const res = spawnSync(process.execPath, ['--require', path.join(PKG_ROOT, 'register.cjs'), path.join(FIXTURES, 'knex-dialect-class.cjs')], {
      encoding: 'utf8',
      cwd: PKG_ROOT,
      env: { ...process.env, OTEL_TRACES_EXPORTER: 'console', OTEL_SERVICE_NAME: 'knex-test', OTEL_LOG_LEVEL: 'error' },
      timeout: 20000,
    })
    const out = (res.stdout ?? '') + '\n' + (res.stderr ?? '')
    const span = out.split(/\n\{\n/).find((b) => b.includes("name: 'select kuma.monitor'")) ?? ''
    expect(span).toMatch(/\n\s*kind: 2,/)
    expect(span).toContain("'db.system': 'postgresql'")
    expect(span).toContain("'db.sql.table': 'monitor'")
    expect(span).toContain(`'code.file.path': '${path.join(FIXTURES, 'knex-dialect-class.cjs')}'`)
    expect(span).toContain("'code.function.name': 'loadMonitors'")
  })
})

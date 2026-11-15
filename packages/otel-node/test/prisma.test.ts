import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

// The Prisma facade wraps each model op so the app's frame rides in context to
// the query span, which Prisma starts off the caller's stack. The apps and a
// stub client are copied into a temp dir so `@prisma/client` resolves to the
// stub under its real name (the module hook matches on it) and nothing is
// written under the repo's node_modules.

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
let dir = ''

beforeAll(() => {
  if (!existsSync(path.join(PKG_ROOT, 'dist', 'index.cjs'))) {
    execSync('npm run build', { cwd: PKG_ROOT, stdio: 'ignore' })
  }
  // realpath: macOS's tmpdir is a symlink, and stack frames carry the real path.
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'neat-prisma-')))
  const client = path.join(dir, 'node_modules', '@prisma', 'client')
  mkdirSync(client, { recursive: true })
  copyFileSync(path.join(FIXTURES, 'prisma-client-stub.cjs'), path.join(client, 'index.js'))
  copyFileSync(path.join(FIXTURES, 'prisma-app.cjs'), path.join(dir, 'prisma-app.cjs'))
  copyFileSync(path.join(FIXTURES, 'prisma-app.mjs'), path.join(dir, 'prisma-app.mjs'))
}, 60000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function run(flag: '--require' | '--import', entry: string): string {
  const res = spawnSync(process.execPath, [flag, path.join(PKG_ROOT, flag === '--require' ? 'register.cjs' : 'register.mjs'), path.join(dir, entry)], {
    encoding: 'utf8',
    cwd: dir,
    env: {
      ...process.env,
      // The stub client requires @opentelemetry/api from outside the repo.
      NODE_PATH: [path.join(PKG_ROOT, 'node_modules'), path.join(PKG_ROOT, '..', '..', 'node_modules')].join(path.delimiter),
      OTEL_TRACES_EXPORTER: 'console',
      OTEL_SERVICE_NAME: 'prisma-test',
      OTEL_LOG_LEVEL: 'error',
    },
    timeout: 20000,
  })
  return (res.stdout ?? '') + '\n' + (res.stderr ?? '')
}

describe('prisma facade', () => {
  it.each([
    ['--require', 'prisma-app.cjs', 9],
    ['--import', 'prisma-app.mjs', 7],
  ] as const)('stamps the model op call site on the off-stack query span (%s)', (flag, entry, line) => {
    const out = run(flag, entry)
    const span = out.split(/\n\{\n/).find((b) => b.includes("name: 'prisma:engine:db_query'")) ?? ''
    expect(span).toMatch(/\n\s*kind: 2,/)
    expect(span).toContain(`'code.file.path': '${path.join(dir, entry)}'`)
    expect(span).toContain(`'code.line.number': ${line}`)
    expect(span).toContain("'code.function.name': 'listUsers'")
  })
})

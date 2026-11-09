import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { splitNamespace, commandName } from '../src/instrumentations/mongodb-core.js'

// mongodb 2.x and 3.0-3.2 talk to the server through `mongodb-core`, which no
// upstream instrumentation covers (it starts at mongodb 3.3). These run the real
// drivers against a fake wire-protocol peer (fixtures/mongodb-fake-server.cjs),
// so each find and insert completes without a database.

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

beforeAll(() => {
  if (!existsSync(path.join(PKG_ROOT, 'dist', 'index.cjs'))) {
    execSync('npm run build', { cwd: PKG_ROOT, stdio: 'ignore' })
  }
}, 60000)

function run(entry: string): string {
  const res = spawnSync(process.execPath, ['--require', path.join(PKG_ROOT, 'register.cjs'), path.join(FIXTURES, entry)], {
    encoding: 'utf8',
    cwd: PKG_ROOT,
    env: { ...process.env, OTEL_TRACES_EXPORTER: 'console', OTEL_SERVICE_NAME: 'mongo-test', OTEL_LOG_LEVEL: 'error' },
    timeout: 20000,
  })
  return (res.stdout ?? '') + '\n' + (res.stderr ?? '')
}

function spanNamed(out: string, name: string): string {
  return out.split(/\n\{\n/).find((b) => b.includes(`name: '${name}'`)) ?? ''
}

describe('mongodb-core instrumentation (mongodb 2.x / 3.0-3.2)', () => {
  it('emits a CLIENT span per find and insert with the database, collection and call site (mongodb 2.2)', () => {
    const out = run('mongodb-v2.cjs')
    const find = spanNamed(out, 'find nodegoat.users')
    expect(find).toMatch(/\n\s*kind: 2,/)
    expect(find).toContain("'db.system': 'mongodb'")
    expect(find).toContain("'db.name': 'nodegoat'")
    expect(find).toContain("'db.mongodb.collection': 'users'")
    expect(find).toContain("'server.address': '127.0.0.1'")
    // The cursor's query runs later, off the find() stack; the frame rides the cursor.
    expect(find).toContain(`'code.file.path': '${path.join(FIXTURES, 'mongodb-v2.cjs')}'`)
    expect(find).toContain("'code.function.name': 'findUser'")
    const insert = spanNamed(out, 'insert nodegoat.allocations')
    expect(insert).toContain("'db.operation': 'insert'")
    expect(insert).toContain("'db.mongodb.collection': 'allocations'")
    expect(insert).toContain("'code.function.name': 'addAllocation'")
  })

  it('covers the mongodb 3.1 line the upstream instrumentation misses', () => {
    // Loaded through the `mongodb-3` npm alias, so the Collection facade (which
    // hooks the module by its real name, `mongodb`) doesn't apply here; the
    // call site under the real name is covered by the 2.2 case's path.
    const out = run('mongodb-v3.cjs')
    const find = spanNamed(out, 'find nodegoat.users')
    expect(find).toContain("'db.system': 'mongodb'")
    expect(find).toContain("'db.mongodb.collection': 'users'")
    const insert = spanNamed(out, 'insert nodegoat.allocations')
    expect(insert).toContain("'db.operation': 'insert'")
  })

  it('does not trace the driver handshake', () => {
    const out = run('mongodb-v2.cjs')
    expect(out).not.toMatch(/name: '(ismaster|isMaster|hello)/)
  })
})

describe('mongodb-core helpers', () => {
  it('splits a namespace, keeping dots inside the collection and dropping $cmd', () => {
    expect(splitNamespace('nodegoat.users')).toEqual({ db: 'nodegoat', collection: 'users' })
    expect(splitNamespace('app.audit.events')).toEqual({ db: 'app', collection: 'audit.events' })
    expect(splitNamespace('admin.$cmd')).toEqual({ db: 'admin', collection: undefined })
    expect(splitNamespace(undefined)).toEqual({})
  })

  it('reads the command name from the first key', () => {
    expect(commandName({ find: 'users', filter: {} })).toBe('find')
    expect(commandName({})).toBeUndefined()
    expect(commandName(null)).toBeUndefined()
  })
})

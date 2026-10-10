import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { PostgresJsInstrumentation } from '../src/instrumentations/postgres-js.js'

// The scoped `sql` instances postgres.js hands out — begin()'s transaction sql,
// a savepoint's, reserve()'s — each carry their own handler. Their queries must
// name the parent's database, never another instance's, and a query on a
// handler the instrumentation never registered (postgres.js's own type lookup)
// gets no span rather than a guessed database. These run against a small fake
// of postgres.js's public shape, so they're deterministic without a server.

class Query extends Promise<unknown> {
  executed = false
  tagged: boolean
  strings: unknown
  handler: (q: Query) => void
  resolve!: (x: unknown) => unknown
  reject!: (e: unknown) => unknown
  static get [Symbol.species]() {
    return Promise
  }
  constructor(strings: unknown, handler: (q: Query) => void) {
    let res!: (x: unknown) => void
    let rej!: (e: unknown) => void
    super((a, b) => {
      res = a
      rej = b
    })
    this.tagged = Array.isArray((strings as { raw?: unknown }).raw)
    this.strings = strings
    this.handler = handler
    this.resolve = (x) => res(x)
    this.reject = (e) => rej(e)
  }
  get origin(): string {
    return ''
  }
  handle(): void {
    if (this.executed) return
    this.executed = true
    this.handler(this)
  }
  override then(...a: Parameters<Promise<unknown>['then']>) {
    this.handle()
    return super.then(...a)
  }
}

// One "connection": every handler resolves immediately.
function fakePostgres(options: { host: string; port: number; database: string }) {
  const makeSql = () => {
    const handler = (q: Query) => q.resolve([])
    const sql = ((strings: TemplateStringsArray) => new Query(strings, handler)) as unknown as Record<string, unknown> &
      ((s: TemplateStringsArray) => Query)
    sql.unsafe = (text: string) => new Query([text], handler)
    return sql
  }
  const top = makeSql()
  top.options = { host: [options.host], port: [options.port], database: options.database, user: 'app' }
  top.begin = async (fn: (inner: unknown) => unknown) => {
    const inner = makeSql()
    inner.savepoint = async (sfn: (s: unknown) => unknown) => sfn(makeSql())
    return fn(inner)
  }
  top.reserve = async () => makeSql()
  // postgres.js's internal type lookup: a Query on a handler nobody registered.
  top.internal = () => new Query(['select oid from pg_type'], (q: Query) => q.resolve([]))
  return top
}

const exporter = new InMemorySpanExporter()
let inst: PostgresJsInstrumentation

beforeAll(() => {
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] } as never)
  provider.register()
  inst = new PostgresJsInstrumentation()
  inst.setTracerProvider(provider)
})

afterEach(() => exporter.reset())

const wrap = (factory: unknown) =>
  (inst as unknown as { patchModule: (e: unknown) => (o: unknown) => ReturnType<typeof fakePostgres> }).patchModule(factory)

const t = (s: string) => Object.assign([s], { raw: [s] }) as unknown as TemplateStringsArray

describe('postgres.js scoped instances', () => {
  it("names the parent's database inside begin(), a savepoint and reserve()", async () => {
    const postgres = wrap((o: { host: string; port: number; database: string }) => fakePostgres(o))
    const orders = postgres({ host: 'db-orders', port: 5432, database: 'orders' })
    // A second, later instance: the old fallback would have named it for the
    // transaction's queries.
    postgres({ host: 'db-billing', port: 5432, database: 'billing' })

    await (orders.begin as (fn: (sql: never) => unknown) => Promise<unknown>)(async (tx: never) => {
      await (tx as (s: TemplateStringsArray) => Query)(t('update orders set paid = true'))
      await (tx as { savepoint: (fn: (s: never) => unknown) => Promise<unknown> }).savepoint(async (sp: never) => {
        await (sp as (s: TemplateStringsArray) => Query)(t('insert into audit values (1)'))
      })
    })
    const reserved = (await (orders.reserve as () => Promise<unknown>)()) as (s: TemplateStringsArray) => Query
    await reserved(t('select 1 from orders'))

    const spans = exporter.getFinishedSpans()
    expect(spans.map((s) => s.attributes['db.statement'])).toEqual([
      'update orders set paid = true',
      'insert into audit values (1)',
      'select 1 from orders',
    ])
    for (const s of spans) {
      expect(s.attributes['db.name']).toBe('orders')
      expect(s.attributes['server.address']).toBe('db-orders')
    }
  })

  it('gives a query on an unregistered handler no span, rather than a guessed database', async () => {
    const postgres = wrap((o: { host: string; port: number; database: string }) => fakePostgres(o))
    const sql = postgres({ host: 'db', port: 5432, database: 'orders' })
    await (sql.internal as () => Query)()
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })

  it('records the operation but not the literal text of sql.unsafe()', async () => {
    const postgres = wrap((o: { host: string; port: number; database: string }) => fakePostgres(o))
    const sql = postgres({ host: 'db', port: 5432, database: 'orders' })
    await (sql.unsafe as (s: string) => Query)("select * from users where email = 'a@b.c'")
    const [span] = exporter.getFinishedSpans()
    expect(span?.attributes['db.operation']).toBe('SELECT')
    expect(span?.attributes['db.statement']).toBeUndefined()
    expect(JSON.stringify(span?.attributes)).not.toContain('a@b.c')
  })
})

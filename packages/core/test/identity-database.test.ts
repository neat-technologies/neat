import { describe, it, expect } from 'vitest'
import { databaseIdentity, localDatabaseIdentity } from '../src/identity/database.js'

// #1641 option B: one identity module per node kind. The DatabaseNode id must come
// out identical whether the static extractor or OTel ingest builds it, or the
// declared and observed nodes twin (ADR-276).
describe('database identity', () => {
  it('canonicalises the engine and builds database:<engine>:<host>', () => {
    expect(databaseIdentity('postgresql', 'db.example.com')).toEqual({
      id: 'database:postgresql:db.example.com',
      engine: 'postgresql',
    })
  })

  it('resolves engine aliases so static config and observed span fuse to one id', () => {
    // A static connection string may say `postgres`; an OTel `db.system` says
    // `postgresql`. Both must land on the same id.
    const fromConfig = databaseIdentity('postgres', 'db.example.com')
    const fromSpan = databaseIdentity('postgresql', 'db.example.com')
    expect(fromConfig.id).toBe(fromSpan.id)
    expect(fromConfig).toEqual({ id: 'database:postgresql:db.example.com', engine: 'postgresql' })
    expect(databaseIdentity('mariadb', 'h').engine).toBe('mysql')
  })

  it('reads an empty or missing engine as unknown', () => {
    expect(databaseIdentity(undefined, 'h').id).toBe('database:unknown:h')
    expect(databaseIdentity('', 'h').id).toBe('database:unknown:h')
  })

  it('puts the engine first so an IPv6 host keeps its colons at the tail', () => {
    expect(databaseIdentity('redis', '::1').id).toBe('database:redis:::1')
  })

  it('builds a service-scoped id for an embedded database, with no engine in it', () => {
    expect(localDatabaseIdentity('checkout', 'app.db')).toEqual({ id: 'database:checkout/app.db' })
  })
})

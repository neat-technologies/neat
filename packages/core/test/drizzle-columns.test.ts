import { describe, it, expect } from 'vitest'
import { drizzleEndpointsFromFile } from '../src/extract/calls/drizzle.js'
import { sqlalchemyEndpointsFromFile } from '../src/extract/calls/sqlalchemy.js'

// ADR-157 §3 — the EXTRACTED declared-column read, at DATABASE-name fidelity. The
// column name is reproduced the way the ORM names the DB column (the fusion key
// the running query carries), NOT the code field name: the explicit column name
// wins, the field/attribute name is the fallback the ORM itself uses.

const SVC = '/svc'

describe('drizzleEndpointsFromFile — declared columns at DB-name fidelity', () => {
  const eps = (content: string) =>
    drizzleEndpointsFromFile({ path: '/svc/src/schema.ts', content }, SVC)

  it('reproduces the DB column name — userId declared as user_id fuses as user_id, not userId', () => {
    const out = eps(`
      import { pgTable, serial, integer, text, timestamp } from 'drizzle-orm/pg-core'
      export const orders = pgTable('orders', {
        id: serial('id').primaryKey(),
        userId: integer('user_id').notNull(),
        total: integer(),
        status: text('status').default('pending'),
        createdAt: timestamp('created_at').defaultNow(),
      })
    `)
    expect(out).toHaveLength(1)
    expect(out[0]!.infraId).toBe('infra:sql-table:orders')
    expect(out[0]!.kind).toBe('sql-table')
    // The load-bearing assertion (ADR-157 §3): the camelCase field `userId`
    // declared as `user_id` extracts as `user_id`, NOT `userId`.
    expect(out[0]!.columns).toEqual(['id', 'user_id', 'total', 'status', 'created_at'])
    expect(out[0]!.columns).not.toContain('userId')
    expect(out[0]!.evidence.file).toBe('src/schema.ts')
  })

  it('falls back to the object key when the builder is given no explicit name', () => {
    const out = eps(`
      import { pgTable, integer } from 'drizzle-orm/pg-core'
      export const widgets = pgTable('widgets', {
        total: integer().default('0'),
        note: integer(),
      })
    `)
    // The key wins where there is no builder name, and the '0' default is not
    // mistaken for the column name.
    expect(out[0]!.columns).toEqual(['total', 'note'])
  })

  it('recognizes mysqlTable and sqliteTable builders', () => {
    const my = eps(`
      import { mysqlTable, int } from 'drizzle-orm/mysql-core'
      export const a = mysqlTable('a', { x: int('x') })
    `)
    expect(my[0]!.columns).toEqual(['x'])
    const sq = eps(`
      import { sqliteTable, integer } from 'drizzle-orm/sqlite-core'
      export const b = sqliteTable('b', { y: integer('y') })
    `)
    expect(sq[0]!.columns).toEqual(['y'])
  })

  it('returns nothing for a file that does not import drizzle-orm', () => {
    expect(eps('export const x = 1\n')).toEqual([])
  })
})

describe('sqlalchemyEndpointsFromFile — declared columns (attribute name == column name)', () => {
  const eps = (content: string) =>
    sqlalchemyEndpointsFromFile({ path: '/svc/models.py', content }, SVC)

  it('reads Column attributes as columns, honoring an explicit first-string name', () => {
    const out = eps(`
from sqlalchemy import Column, Integer, String
from db import Base

class Order(Base):
    __tablename__ = 'orders'
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer)
    total = Column('total_amount', Integer)
    items = relationship('Item')
`)
    const orders = out.find((e) => e.name === 'orders')
    expect(orders).toBeDefined()
    // attr==col for id/user_id; the explicit string wins for total → total_amount.
    // `relationship(...)` is not a column and is skipped.
    expect(orders!.columns).toEqual(['id', 'user_id', 'total_amount'])
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { getBlastRadius, getTransitiveDependencies } from '../src/traverse.js'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance, extractedEdgeId, infraId } from '@neat.is/types'
import { drizzleForeignKeys } from '../src/extract/calls/drizzle.js'
import { prismaForeignKeysFromSchema } from '../src/extract/calls/prisma.js'
import { sqlalchemyForeignKeys } from '../src/extract/calls/sqlalchemy.js'

// ADR-161 — foreign-key table→table REFERENCES edges. The per-ORM readers resolve
// the parent to the DATABASE table name (the fusion key `infra:sql-table:<name>`
// the column/table read + OTLP already target), reproduced verbatim, and leave a
// computed/unresolvable reference unclaimed rather than guessing.

const SVC = '/svc'
const tbl = (name: string) => infraId('sql-table', name)
const refEdge = (child: string, parent: string) =>
  extractedEdgeId(tbl(child), tbl(parent), EdgeType.REFERENCES)

describe('drizzleForeignKeys — inline .references() at DB-name fidelity', () => {
  const fks = (content: string) =>
    drizzleForeignKeys({ path: '/svc/src/schema.ts', content }, SVC)

  it('resolves the parent through the table variable to its DB table name', () => {
    const out = fks(`
      import { pgTable, serial, integer } from 'drizzle-orm/pg-core'
      export const appUsers = pgTable('app_users', {
        id: serial('id').primaryKey(),
      })
      export const posts = pgTable('posts', {
        id: serial('id').primaryKey(),
        authorId: integer('author_id').references(() => appUsers.id),
      })
    `)
    expect(out).toHaveLength(1)
    // The load-bearing assertion: parent is the DB table `app_users`, NOT the
    // `appUsers` variable name.
    expect(out[0]!.childTable).toBe('posts')
    expect(out[0]!.parentTable).toBe('app_users')
    expect(out[0]!.evidence.file).toBe('src/schema.ts')
    expect(out[0]!.evidence.line).toBeGreaterThan(0)
  })

  it('leaves a computed reference unclaimed — mints nothing', () => {
    const out = fks(`
      import { pgTable, serial, integer } from 'drizzle-orm/pg-core'
      export const posts = pgTable('posts', {
        id: serial('id').primaryKey(),
        reviewerId: integer('reviewer_id').references(() => pickTable().id),
      })
      function pickTable() { return posts }
    `)
    expect(out).toEqual([])
  })

  it('leaves a reference to a table not declared in this file unclaimed', () => {
    const out = fks(`
      import { pgTable, integer } from 'drizzle-orm/pg-core'
      import { users } from './other-schema'
      export const posts = pgTable('posts', {
        authorId: integer('author_id').references(() => users.id),
      })
    `)
    expect(out).toEqual([])
  })

  it('returns nothing for a file that does not import drizzle-orm', () => {
    expect(fks('export const x = 1\n')).toEqual([])
  })
})

describe('prismaForeignKeysFromSchema — @relation(fields:) side, at DB-name fidelity', () => {
  const fks = (content: string) =>
    prismaForeignKeysFromSchema({ path: '/svc/prisma/schema.prisma', content }, SVC)

  it('mints one edge on the FK-holding side, in the child→parent direction', () => {
    const out = fks(`
      model Author {
        id    Int    @id @default(autoincrement())
        books Book[]
      }
      model Book {
        id       Int    @id @default(autoincrement())
        authorId Int
        author   Author @relation(fields: [authorId], references: [id])
        @@map("books")
      }
    `)
    expect(out).toHaveLength(1)
    // Child is `books` (Book's @@map), parent is `Author` (verbatim model name).
    // The back-relation `books Book[]` on Author has no `fields:` and mints nothing.
    expect(out[0]!.childTable).toBe('books')
    expect(out[0]!.parentTable).toBe('Author')
    expect(out[0]!.evidence.file).toBe('prisma/schema.prisma')
  })

  it('mints nothing for a schema with no relations', () => {
    const out = fks(`
      model User {
        id    Int    @id
        email String
      }
    `)
    expect(out).toEqual([])
  })
})

describe('sqlalchemyForeignKeys — ForeignKey string names the DB table directly', () => {
  const fks = (content: string) =>
    sqlalchemyForeignKeys({ path: '/svc/models.py', content }, SVC)

  it('reads ForeignKey(table.column) → parent table, child from __tablename__', () => {
    const out = fks(`
from sqlalchemy import Column, Integer, ForeignKey
from db import Base

class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True)

class Post(Base):
    __tablename__ = 'posts'
    id = Column(Integer, primary_key=True)
    author_id = Column(Integer, ForeignKey('users.id'))
`)
    expect(out).toHaveLength(1)
    expect(out[0]!.childTable).toBe('posts')
    expect(out[0]!.parentTable).toBe('users')
    expect(out[0]!.evidence.file).toBe('models.py')
  })

  it('strips a schema qualifier: ForeignKey(public.users.id) → users', () => {
    const out = fks(`
from sqlalchemy import Column, Integer, ForeignKey

class Post(Base):
    __tablename__ = 'posts'
    author_id = Column(Integer, ForeignKey('public.users.id'))
`)
    expect(out[0]!.parentTable).toBe('users')
  })

  it('leaves a non-string ForeignKey(User.id) unclaimed', () => {
    const out = fks(`
from sqlalchemy import Column, Integer, ForeignKey

class Post(Base):
    __tablename__ = 'posts'
    author_id = Column(Integer, ForeignKey(User.id))
`)
    expect(out).toEqual([])
  })
})

describe('foreign-key edges end to end (ADR-161)', () => {
  beforeEach(() => resetGraph())
  const FIXTURE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'fk-edges',
  )

  it('mints REFERENCES edges from a Drizzle and a Prisma schema at DB-name fidelity', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    // Both tables' nodes exist, at their DB names — the fused node, no code-model twin.
    expect(graph.hasNode(tbl('app_users'))).toBe(true)
    expect(graph.hasNode(tbl('posts'))).toBe(true)
    expect(graph.hasNode(tbl('appUsers'))).toBe(false) // no variable-name twin
    expect(graph.hasNode(tbl('books'))).toBe(true)
    expect(graph.hasNode(tbl('Author'))).toBe(true)
    expect(graph.hasNode(tbl('Book'))).toBe(false) // @@map fidelity, no model-name twin

    // Drizzle: posts ──REFERENCES──▶ app_users, EXTRACTED, evidence on the FK line.
    const drizzleEdgeId = refEdge('posts', 'app_users')
    expect(graph.hasEdge(drizzleEdgeId)).toBe(true)
    const drizzleEdge = graph.getEdgeAttributes(drizzleEdgeId) as GraphEdge
    expect(drizzleEdge.source).toBe(tbl('posts'))
    expect(drizzleEdge.target).toBe(tbl('app_users'))
    expect(drizzleEdge.provenance).toBe(Provenance.EXTRACTED)
    expect(drizzleEdge.evidence?.file).toBe('src/schema.ts')
    expect(drizzleEdge.evidence?.line).toBeGreaterThan(0)

    // Prisma: books ──REFERENCES──▶ Author.
    const prismaEdgeId = refEdge('books', 'Author')
    expect(graph.hasEdge(prismaEdgeId)).toBe(true)
    const prismaEdge = graph.getEdgeAttributes(prismaEdgeId) as GraphEdge
    expect(prismaEdge.provenance).toBe(Provenance.EXTRACTED)
    expect(prismaEdge.evidence?.file).toBe('prisma/schema.prisma')

    // The computed Drizzle reference minted nothing: posts has exactly one
    // REFERENCES out-edge (to app_users), not two.
    const refTargets: string[] = []
    graph.forEachOutboundEdge(tbl('posts'), (_id, attrs) => {
      if ((attrs as GraphEdge).type === EdgeType.REFERENCES) {
        refTargets.push((attrs as GraphEdge).target)
      }
    })
    expect(refTargets).toEqual([tbl('app_users')])
  })

  it('blast radius from a parent table reaches the child that FKs into it', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    // "What breaks if app_users changes" walks REFERENCES inbound to posts.
    const drizzleBlast = getBlastRadius(graph, tbl('app_users'))
    expect(drizzleBlast.affectedNodes.map((n) => n.nodeId)).toContain(tbl('posts'))

    const prismaBlast = getBlastRadius(graph, tbl('Author'))
    expect(prismaBlast.affectedNodes.map((n) => n.nodeId)).toContain(tbl('books'))
  })

  it('the child table depends on its parent via REFERENCES', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    const deps = getTransitiveDependencies(graph, tbl('posts'))
    const referenced = deps.dependencies.find((d) => d.nodeId === tbl('app_users'))
    expect(referenced).toBeDefined()
    expect(referenced!.edgeType).toBe(EdgeType.REFERENCES)
  })
})

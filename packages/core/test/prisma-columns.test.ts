import { describe, it, expect } from 'vitest'
import { prismaColumnsFromSchema } from '../src/extract/calls/prisma.js'

// ADR-157 §3 — the EXTRACTED declared-column read for Prisma, at DATABASE-name
// fidelity. Prisma does NOT snake_case by default, so the column and table names
// are the model/field names verbatim, overridden only by `@map` / `@@map`. Scalar
// fields (foreign-key scalars included) are columns; relation fields are not.

const SVC = '/svc'
const eps = (content: string) =>
  prismaColumnsFromSchema({ path: '/svc/prisma/schema.prisma', content }, SVC)
const table = (content: string, name: string) => eps(content).find((e) => e.name === name)

describe('prismaColumnsFromSchema — declared columns at DB-name fidelity', () => {
  it('reads plain scalar fields as columns, verbatim (no snake_case)', () => {
    const out = eps(`
      model User {
        id        Int      @id @default(autoincrement())
        email     String   @unique
        createdAt DateTime @default(now())
      }
    `)
    expect(out).toHaveLength(1)
    expect(out[0]!.infraId).toBe('infra:sql-table:User')
    expect(out[0]!.kind).toBe('sql-table')
    // The load-bearing assertion: `createdAt` stays camelCase, NOT `created_at`.
    expect(out[0]!.columns).toEqual(['id', 'email', 'createdAt'])
    expect(out[0]!.evidence.file).toBe('prisma/schema.prisma')
  })

  it('honors @map — the column is the DB name, not the field name', () => {
    const t = table(
      `
      model Profile {
        id       Int    @id
        fullName String @map("full_name")
      }
    `,
      'Profile',
    )
    expect(t!.columns).toEqual(['id', 'full_name'])
    expect(t!.columns).not.toContain('fullName')
  })

  it('honors @@map — the table is the mapped name, not the model name', () => {
    const out = eps(`
      model Article {
        id   Int    @id
        slug String
        @@map("articles")
      }
    `)
    expect(out[0]!.name).toBe('articles')
    expect(out[0]!.infraId).toBe('infra:sql-table:articles')
  })

  it('skips relation fields — Model, Model[], and @relation scalars', () => {
    const t = table(
      `
      model Post {
        id       Int       @id
        title    String
        author   User      @relation(fields: [authorId], references: [id])
        authorId Int
        tags     Tag[]
        comments Comment[]
      }
      model User { id Int @id }
      model Tag { id Int @id }
      model Comment { id Int @id }
    `,
      'Post',
    )
    // FK scalar `authorId Int` is IN; `author`, `tags`, `comments` relations OUT.
    expect(t!.columns).toEqual(['id', 'title', 'authorId'])
    expect(t!.columns).not.toContain('author')
    expect(t!.columns).not.toContain('tags')
    expect(t!.columns).not.toContain('comments')
  })

  it('includes optional and enum-typed fields', () => {
    const t = table(
      `
      enum Role { USER ADMIN }
      model Account {
        id    Int     @id
        bio   String?
        role  Role    @default(USER)
      }
    `,
      'Account',
    )
    expect(t!.columns).toEqual(['id', 'bio', 'role'])
  })

  it('leaves an unresolved (non-scalar, non-enum, non-model) field unclaimed', () => {
    const t = table(
      `
      model Row {
        id    Int    @id
        point Unsupported("point")
      }
    `,
      'Row',
    )
    expect(t!.columns).toEqual(['id'])
  })

  it('returns nothing for a schema with no model blocks', () => {
    expect(
      eps(`
      datasource db {
        provider = "postgresql"
        url      = env("DATABASE_URL")
      }
    `),
    ).toEqual([])
  })
})

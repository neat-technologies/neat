import { pgTable, serial, integer, text } from 'drizzle-orm/pg-core'

// A two-table foreign key (ADR-161). `posts.authorId` references `appUsers.id`,
// so the extractor mints `infra:sql-table:posts ──REFERENCES──▶
// infra:sql-table:app_users` at DB-name fidelity — the parent resolves through the
// `appUsers` *variable* to the `pgTable('app_users', …)` table name, NOT the
// variable name. Reading the variable name would fuse onto nothing.
export const appUsers = pgTable('app_users', {
  id: serial('id').primaryKey(),
  email: text('email'),
})

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(() => appUsers.id),
  // A computed FK target: the referenced column comes from a function call, not a
  // table variable, so it resolves to nothing and mints no REFERENCES edge — the
  // never-guess discipline (ADR-161).
  reviewerId: integer('reviewer_id').references(() => pickTable().id),
  title: text('title'),
})

function pickTable() {
  return appUsers
}

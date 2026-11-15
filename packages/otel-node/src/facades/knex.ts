import { context } from '@opentelemetry/api'
import { NEAT_DB_SYSTEM, NEAT_USER_FRAME, pickUserFrame } from '../processor.js'

// Off-stack facade: knex. A query executes later (on await / .then), off the
// app's stack. The builder is created synchronously inside the app's own call,
// so the frame and the client's dialect are captured there and carried to the
// query span, which then has a call site and a db.system even when the app
// configured knex with a dialect class rather than a client name.
const KNEX_DB_SYSTEMS: Record<string, string> = {
  sqlite3: 'sqlite', 'better-sqlite3': 'sqlite', pg: 'postgresql', postgres: 'postgresql', postgresql: 'postgresql',
  pgnative: 'postgresql', mysql: 'mysql', mysql2: 'mysql', mssql: 'mssql', oracledb: 'oracle', oracle: 'oracle',
  cockroachdb: 'cockroachdb', redshift: 'redshift',
}

type KnexClientLike = Record<string, unknown> & { dialect?: unknown; config?: { client?: unknown }; __neatWrapped?: boolean }

// Wrap one knex client's builder entry points. Done per instance, on the
// client the app's knex() call created, so a dialect that overrides
// queryBuilder (sqlite3 and postgres do) is covered the same as one that
// inherits it.
function wrapKnexClient(client: KnexClientLike | undefined): void {
  if (!client || client.__neatWrapped) return
  const dialect =
    (typeof client.dialect === 'string' && client.dialect) ||
    (client.config && typeof client.config.client === 'string' && client.config.client) ||
    undefined
  const system = dialect ? KNEX_DB_SYSTEMS[dialect] || dialect : undefined
  for (const method of ['queryBuilder', 'raw', 'schemaBuilder']) {
    const orig = client[method]
    if (typeof orig !== 'function') continue
    client[method] = function __neatKnexBuilder(this: unknown, ...args: unknown[]) {
      const builder = (orig as (...a: unknown[]) => unknown).apply(this, args) as
        | (Record<string, unknown> & { then?: unknown; __neatThen?: boolean })
        | undefined
      try {
        // The query runs when the builder is awaited, off this stack. Capture
        // the app's frame now, while it's still on the stack, and re-enter it
        // (with the dialect) around the builder's own then(): knex starts the
        // runner there, and its async chain, the query span included, inherits
        // that context. (The instrumentation's own builder-context capture is
        // bypassed by dialects that override queryBuilder: sqlite3, postgres.)
        if (builder && typeof builder.then === 'function' && !builder.__neatThen) {
          let ctx = context.active()
          const frame = pickUserFrame(new Error().stack)
          if (frame) ctx = ctx.setValue(NEAT_USER_FRAME, frame)
          if (system) ctx = ctx.setValue(NEAT_DB_SYSTEM, system)
          const origThen = builder.then as (...a: unknown[]) => unknown
          Object.defineProperty(builder, 'then', {
            configurable: true,
            writable: true,
            value: function __neatKnexThen(this: unknown, ...targs: unknown[]) {
              const self = this
              return context.with(ctx, () => origThen.apply(self, targs))
            },
          })
          Object.defineProperty(builder, '__neatThen', { value: true })
        }
      } catch {
        /* best-effort */
      }
      return builder
    }
  }
  client.__neatWrapped = true
}

// The knex package entry is the factory. Wrap it so every instance's client is
// wrapped as it is created; the factory's own properties (knex.knex,
// knex.Client, ...) are carried over.
export function wrapKnex(mod: unknown): unknown {
  try {
    type Factory = ((...a: unknown[]) => { client?: KnexClientLike }) & { __neatWrapped?: boolean }
    const raw = mod as unknown
    const ns = raw as { default?: unknown } | undefined
    const factory = (typeof raw === 'function' ? raw : ns && typeof ns.default === 'function' ? ns.default : undefined) as
      | Factory
      | undefined
    if (!factory || factory.__neatWrapped) return mod
    const wrapped = function __neatKnex(this: unknown, ...args: unknown[]) {
      const instance = factory.apply(this, args)
      try {
        wrapKnexClient(instance && instance.client)
      } catch {
        /* best-effort */
      }
      return instance
    } as Factory
    for (const key of Object.getOwnPropertyNames(factory)) {
      if (key === 'length' || key === 'name' || key === 'prototype' || key === 'arguments' || key === 'caller') continue
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(factory, key) as PropertyDescriptor)
      } catch {
        /* skip non-copyable */
      }
    }
    // `const { knex } = require('knex')` reads this property; point it at the wrap too.
    ;(wrapped as unknown as Record<string, unknown>).knex = wrapped
    wrapped.__neatWrapped = true
    if (typeof raw === 'function') return wrapped
    ;(ns as { default?: unknown }).default = wrapped
    return mod
  } catch {
    return mod
  }
}

import { describe, it, expect } from 'vitest'
import { context, ROOT_CONTEXT } from '@opentelemetry/api'
import { FACADES } from '../src/facades/index.js'
import { fetchFacade } from '../src/facades/fetch.js'
import { connectStyleFacade } from '../src/facades/connect-style.js'
import type { FacadeKit } from '../src/facades/kit.js'

// A stub kit records what a facade asks of it; no SDK, no module hooks.
function stubKit(overrides: Partial<FacadeKit> = {}): FacadeKit & { hooked: string[][] } {
  const hooked: string[][] = []
  return {
    hooked,
    hook: (modules) => {
      hooked.push(modules)
      return true
    },
    pickUserFrame: () => null,
    runWithUserFrame: (fn) => fn(),
    stampHandler: (_frame, run) => run(),
    withUserFrame: (ctx) => ctx,
    withDbSystem: (ctx) => ctx,
    carryFrame: () => {},
    ...overrides,
  }
}

describe('facade registry', () => {
  it('installs the facades in a fixed order', () => {
    expect(FACADES.map((f) => f.name)).toEqual(['fetch', 'prisma', 'mongodb', 'knex', 'fastify', 'socket.io', 'connect-style'])
  })

  it('loads a facade on its own against a stub kit', () => {
    const kit = stubKit()
    connectStyleFacade.install(kit)
    expect(kit.hooked).toEqual([['express'], ['connect']])
  })

  it('routes the fetch facade through the kit it is handed', async () => {
    const g = globalThis as unknown as { fetch: unknown }
    const real = g.fetch
    let ran = 0
    g.fetch = async () => 'ok'
    try {
      fetchFacade.install(stubKit({ runWithUserFrame: (fn) => (ran++, context.with(ROOT_CONTEXT, fn)) }))
      expect(await (g.fetch as () => Promise<string>)()).toBe('ok')
      expect(ran).toBe(1)
    } finally {
      g.fetch = real
    }
  })
})

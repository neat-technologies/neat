import type { Facade, FacadeKit } from './kit.js'

// Off-stack facade: Node's built-in fetch / undici. The instrumentation creates
// the CLIENT span inside a diagnostics_channel handler detached from the
// caller's stack, so wrap the global so the user frame is in context when the
// span is created.
function wrapFetch(kit: FacadeKit): void {
  try {
    const g = globalThis as unknown as { fetch?: ((...a: unknown[]) => unknown) & { __neatWrapped?: boolean } }
    if (typeof g.fetch === 'function' && !g.fetch.__neatWrapped) {
      const realFetch = g.fetch
      const neatFetch = function __neatFetch(input: unknown, init: unknown) {
        return kit.runWithUserFrame(() => (realFetch as (...a: unknown[]) => unknown)(input, init))
      } as ((...a: unknown[]) => unknown) & { __neatWrapped?: boolean }
      neatFetch.__neatWrapped = true
      g.fetch = neatFetch
    }
  } catch {
    /* best-effort */
  }
}

export const fetchFacade: Facade = {
  name: 'fetch',
  install: (kit) => wrapFetch(kit),
}

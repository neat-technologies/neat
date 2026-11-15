import type { Facade, FacadeKit } from './kit.js'

// Off-stack facade: @prisma/client. Prisma's query engine backdates its spans
// from Rust, off the caller's stack. Wrap the model methods so the call-site
// frame (still synchronous at `prisma.user.find`) is pushed into context.
function wrapPrisma(kit: FacadeKit): void {
  kit.hook(['@prisma/client'], (exports: unknown) => {
    try {
      // CJS hands over module.exports; ESM hands over the namespace, whose named
      // PrismaClient may be missing when the CJS re-export defeats static
      // analysis, so fall back to the default export (module.exports itself).
      type PrismaExports = { PrismaClient?: (new (...a: unknown[]) => unknown) & { __neatWrapped?: boolean } }
      const ns = exports as PrismaExports & { default?: PrismaExports }
      const ex = ns && typeof ns.PrismaClient === 'function' ? ns : ns && ns.default ? ns.default : ns
      const Client = ex && ex.PrismaClient
      if (typeof Client === 'function' && !Client.__neatWrapped) {
        const ops = [
          'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'create',
          'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy',
        ]
        const wrapModel = (model: Record<string, unknown> & { __neatWrapped?: boolean }) => {
          if (!model || model.__neatWrapped) return model
          for (const op of ops) {
            const orig = model[op]
            if (typeof orig !== 'function') continue
            model[op] = function __neatModelOp(this: unknown, ...args: unknown[]) {
              const self = this
              return kit.runWithUserFrame(() => (orig as (...a: unknown[]) => unknown).apply(self, args))
            }
          }
          model.__neatWrapped = true
          return model
        }
        ex.PrismaClient = new Proxy(Client, {
          construct(Target, argList, NewTarget) {
            const instance = Reflect.construct(Target as new (...a: unknown[]) => unknown, argList, NewTarget)
            return new Proxy(instance as object, {
              get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver)
                if (value && typeof value === 'object' && typeof prop === 'string' && prop[0] !== '$' && prop[0] !== '_') {
                  return wrapModel(value as Record<string, unknown>)
                }
                return value
              },
            })
          },
        }) as typeof Client
        ;(ex.PrismaClient as { __neatWrapped?: boolean }).__neatWrapped = true
      }
    } catch {
      /* best-effort */
    }
    return exports
  })
}

export const prismaFacade: Facade = {
  name: 'prisma',
  install: (kit) => wrapPrisma(kit),
}

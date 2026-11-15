// The facade registry. Each entry is one module under src/facades that wraps a
// framework or client so its spans get a call site: off-stack facades push the
// caller's frame into context, handler-entry facades stamp the SERVER/CONSUMER
// span with the handler's registration frame. Installed in this order, once,
// after the SDK starts and before user code loads the modules. Each facade
// guards itself, so a failure degrades to the stack-walk + context floor.
//
// Adding a framework: write src/facades/<name>.ts exporting a Facade, and add
// it here.
import { createFacadeKit } from './kit.js'
import type { Facade, ModuleLoaders } from './kit.js'
import { fetchFacade } from './fetch.js'
import { prismaFacade } from './prisma.js'
import { mongodbFacade } from './mongodb.js'
import { knexFacade } from './knex.js'
import { fastifyFacade } from './fastify.js'
import { socketIoFacade } from './socket-io.js'
import { connectStyleFacade } from './connect-style.js'

export const FACADES: readonly Facade[] = [
  fetchFacade,
  prismaFacade,
  mongodbFacade,
  knexFacade,
  fastifyFacade,
  socketIoFacade,
  connectStyleFacade,
]

export function installFacades(moduleLoaders: ModuleLoaders = {}): void {
  const kit = createFacadeKit(moduleLoaders)
  for (const facade of FACADES) facade.install(kit)
}

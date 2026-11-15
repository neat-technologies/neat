import { neatHook, setLoaders } from './kit.js'
import type { ModuleLoaders } from './kit.js'
import { wrapFetch } from './fetch.js'
import { wrapPrisma } from './prisma.js'
import { wrapConnectStyle } from './connect-style.js'
import { installFastifyHandlerEntry } from './fastify.js'
import { wrapMongoCollection } from './mongodb.js'
import { wrapSocketIo } from './socket-io.js'
import { wrapKnex } from './knex.js'

function installHandlerEntry(): void {
  installFastifyHandlerEntry()
  neatHook(['socket.io'], (exports: unknown) => {
    wrapSocketIo(exports)
    return exports
  })
  neatHook(['express'], (exports: unknown) => {
    wrapConnectStyle(exports)
    return exports
  })
  neatHook(['connect'], (exports: unknown) => {
    wrapConnectStyle(exports)
    return exports
  })
}

// Install every off-stack and handler-entry wrap. Called once after the SDK
// starts, before user code requires the framework / Prisma modules. Each wrap is
// independently guarded, so a failure degrades to the stack-walk + context floor.
export function installFacades(moduleLoaders: ModuleLoaders = {}): void {
  setLoaders(moduleLoaders)
  wrapFetch()
  wrapPrisma()
  neatHook(['mongodb'], (exports: unknown) => {
    wrapMongoCollection(exports)
    return exports
  })
  neatHook(['knex'], (exports: unknown) => wrapKnex(exports))
  installHandlerEntry()
}

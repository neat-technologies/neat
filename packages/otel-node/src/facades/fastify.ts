import diagnosticsChannel from 'node:diagnostics_channel'
import { pickUserFrame } from '../processor.js'
import { stampHandler } from './kit.js'

// Handler-entry for fastify. Fastify publishes every new instance on the
// `fastify.initialization` diagnostics channel, so no module hook is needed and
// CJS and ESM apps are covered alike. An onRoute hook on the instance runs
// synchronously inside the app's own `fastify.get(...)` / `fastify.route(...)`
// call, so the registration frame is still on the stack there; child plugin
// contexts inherit the hook. The handler is wrapped to stamp the SERVER span
// with that frame and push it into context for downstream spans.
type FastifyRouteOptions = { handler?: ((...a: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean } }
type FastifyInstance = { addHook?: (name: string, fn: (opts: FastifyRouteOptions) => void) => unknown }

function wrapFastifyInstance(instance: FastifyInstance | undefined): void {
  try {
    if (!instance || typeof instance.addHook !== 'function') return
    instance.addHook('onRoute', function __neatOnRoute(routeOptions: FastifyRouteOptions) {
      try {
        const handler = routeOptions && routeOptions.handler
        if (typeof handler !== 'function' || handler.__neatHandlerWrapped) return
        const frame = pickUserFrame(new Error().stack)
        if (!frame) return
        const neatHandler = function __neatHandler(this: unknown, ...hargs: unknown[]) {
          const self = this
          return stampHandler(frame, () => handler.apply(self, hargs))
        } as ((...a: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean }
        neatHandler.__neatHandlerWrapped = true
        // Keep the handler's own name: the fastify instrumentation names its
        // request-handler span after it.
        Object.defineProperty(neatHandler, 'name', { value: handler.name, configurable: true })
        routeOptions.handler = neatHandler
      } catch {
        /* best-effort */
      }
    })
  } catch {
    /* best-effort */
  }
}

let fastifySubscribed = false
export function installFastifyHandlerEntry(): void {
  if (fastifySubscribed) return
  try {
    diagnosticsChannel.subscribe('fastify.initialization', (message: unknown) => {
      wrapFastifyInstance((message as { fastify?: FastifyInstance } | undefined)?.fastify)
    })
    fastifySubscribed = true
  } catch {
    /* best-effort: an older Node without subscribe() keeps the stack-walk floor */
  }
}

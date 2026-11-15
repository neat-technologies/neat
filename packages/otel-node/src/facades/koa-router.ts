import type { Facade } from './kit.js'
import { wrapConnectStyle } from './connect-style.js'

// Handler-entry for koa's routers: @koa/router, and koa-router, its old name.
// Both put their verbs on the Router prototype, so the connect-style wrap
// applies: it captures the app's router.get(...) line and stamps the SERVER
// span with it when the handler runs. Under koa 2 the koa instrumentation runs
// the handler inside its own INTERNAL span and the SERVER span is reached
// through the RPC metadata. Under koa 3, which that instrumentation doesn't
// patch, the http SERVER span is the active one.
//
// `use` is left alone on purpose. A router recognises a nested router by the
// `router` property on its routes() middleware, and a wrapped function would
// hide it.
const KOA_ROUTER_VERBS = ['get', 'post', 'put', 'delete', 'del', 'patch', 'all', 'options', 'head']

export const koaRouterFacade: Facade = {
  name: 'koa-router',
  install(kit) {
    kit.hook(['@koa/router', 'koa-router'], (exports: unknown) => {
      wrapConnectStyle(kit, exports, KOA_ROUTER_VERBS)
      return exports
    })
  },
}

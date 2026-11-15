import { pickUserFrame } from '../processor.js'
import { stampHandler } from './kit.js'

// Handler-entry facades. express / connect share the Layer model; the wrap
// captures the registration frame and stamps + propagates it when the handler
// runs. The wrap list is the extensibility seam for koa / nestjs (fastify is
// covered through its diagnostics channel below).
export function wrapConnectStyle(mod: unknown): void {
  try {
    const verbs = ['use', 'get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head']
    const wrapTarget = (target: (Record<string, unknown> & { __neatVerbsWrapped?: boolean }) | undefined) => {
      if (!target || target.__neatVerbsWrapped) return
      for (const verb of verbs) {
        const orig = target[verb]
        if (typeof orig !== 'function') continue
        // Named with the __neat prefix so the frame picker skips this wrapper
        // and lands on the user's registration line, not on this file.
        target[verb] = function __neatVerb(this: unknown, ...args: unknown[]) {
          const frame = pickUserFrame(new Error().stack)
          if (frame) {
            for (let a = 0; a < args.length; a++) {
              const h = args[a] as (((...x: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean; length: number }) | undefined
              if (typeof h === 'function' && !h.__neatHandlerWrapped && h.length <= 4) {
                const inner = h
                const neatHandler = function __neatHandler(this: unknown, ...hargs: unknown[]) {
                  const self = this
                  return stampHandler(frame, () => inner.apply(self, hargs))
                } as ((...x: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean }
                neatHandler.__neatHandlerWrapped = true
                args[a] = neatHandler
              }
            }
          }
          return (orig as (...a: unknown[]) => unknown).apply(this, args)
        }
      }
      target.__neatVerbsWrapped = true
    }
    type ConnectExports = { Router?: { prototype?: Record<string, unknown> }; application?: Record<string, unknown>; prototype?: Record<string, unknown> }
    // ESM imports arrive as a namespace whose default export is module.exports.
    const raw = mod as ConnectExports & { default?: ConnectExports }
    const m = raw && raw.default && !raw.application && !raw.Router ? raw.default : raw
    if (m && m.Router && m.Router.prototype) wrapTarget(m.Router.prototype)
    if (m && m.application) wrapTarget(m.application)
    if (m && m.prototype) wrapTarget(m.prototype)
  } catch {
    /* best-effort */
  }
}

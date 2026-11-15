import type { Facade, FacadeKit } from './kit.js'

// Handler-entry for socket.io (uptime-kuma's API is socket.io events, not HTTP
// routes). The socket.io instrumentation patches Socket.prototype.on so each
// incoming event runs its listener inside a CONSUMER span opened at dispatch,
// where the stack holds only socket.io internals. This wrap sits outside that
// patch (the instrumentation hooks the socket module as it loads; this hooks
// the package entry, which finishes loading after it), captures the frame of
// the app's own socket.on(...) call, and stamps the CONSUMER span when the
// listener runs.
type SocketProto = Record<string, unknown> & { __neatOnWrapped?: boolean }

// Socket.prototype carries the per-event listeners, the app's API surface. The
// one-per-client `io.on('connection', ...)` span is left unstamped.
function wrapSocketIo(kit: FacadeKit, mod: unknown): void {
  type SocketIoExports = { Socket?: { prototype?: SocketProto } }
  const raw = mod as SocketIoExports & { default?: SocketIoExports }
  const cls = (raw && raw.Socket) || (raw && raw.default && raw.default.Socket)
  wrapSocketIoOn(kit, cls && cls.prototype)
}

function wrapSocketIoOn(kit: FacadeKit, proto: SocketProto | undefined): void {
  try {
    if (!proto || proto.__neatOnWrapped || typeof proto.on !== 'function') return
    const originalOn = proto.on as (...a: unknown[]) => unknown
    proto.on = function __neatSocketOn(this: unknown, ev: unknown, listener: unknown, ...rest: unknown[]) {
      const fn = listener as (((...x: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean }) | undefined
      if (typeof fn === 'function' && !fn.__neatHandlerWrapped) {
        const frame = kit.pickUserFrame(new Error().stack)
        if (frame) {
          const neatListener = function __neatHandler(this: unknown, ...largs: unknown[]) {
            const self = this
            return kit.stampHandler(frame, () => fn.apply(self, largs))
          } as ((...x: unknown[]) => unknown) & { __neatHandlerWrapped?: boolean }
          neatListener.__neatHandlerWrapped = true
          Object.defineProperty(neatListener, 'name', { value: fn.name, configurable: true })
          return originalOn.call(this, ev, neatListener, ...rest)
        }
      }
      return originalOn.call(this, ev, listener, ...rest)
    }
    proto.__neatOnWrapped = true
  } catch {
    /* best-effort */
  }
}

export const socketIoFacade: Facade = {
  name: 'socket.io',
  install(kit) {
    kit.hook(['socket.io'], (exports: unknown) => {
      wrapSocketIo(kit, exports)
      return exports
    })
  },
}

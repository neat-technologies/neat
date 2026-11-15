import { context } from '@opentelemetry/api'
import type { Facade, FacadeKit } from './kit.js'

// Off-stack facade: the mongodb driver's public Collection methods. mongodb 3.x
// reaches the server asynchronously (operation executors, promises), so the
// call site is pushed into context at the synchronous `collection.find(...)` /
// `insertOne(...)` call and read back by the processor when the CLIENT span
// starts. Wrapped per method, once; harmless where the stack walk already
// finds the frame.
const MONGO_COLLECTION_OPS = [
  'find', 'findOne', 'insert', 'insertOne', 'insertMany', 'update', 'updateOne', 'updateMany',
  'remove', 'deleteOne', 'deleteMany', 'replaceOne', 'save', 'aggregate', 'count', 'countDocuments',
  'distinct', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'findAndModify', 'bulkWrite',
]

function wrapMongoCollection(kit: FacadeKit, mod: unknown): void {
  try {
    type CollectionProto = Record<string, unknown> & { __neatWrapped?: boolean }
    const raw = mod as { Collection?: { prototype?: CollectionProto }; default?: { Collection?: { prototype?: CollectionProto } } }
    const proto = (raw && raw.Collection && raw.Collection.prototype) || (raw && raw.default && raw.default.Collection && raw.default.Collection.prototype)
    if (!proto || proto.__neatWrapped) return
    for (const op of MONGO_COLLECTION_OPS) {
      const orig = proto[op]
      if (typeof orig !== 'function') continue
      proto[op] = function __neatMongoCollectionOp(this: unknown, ...args: unknown[]) {
        const self = this
        const frame = kit.pickUserFrame(new Error().stack)
        const run = () => (orig as (...a: unknown[]) => unknown).apply(self, args)
        if (!frame) return run()
        let result: unknown
        try {
          result = context.with(kit.withUserFrame(context.active(), frame), run)
        } catch (err) {
          throw err
        }
        // A cursor issues its query later (toArray / next), off this stack and
        // often off this async context; carry the frame on the cursor itself.
        if (result && typeof result === 'object' && typeof (result as { next?: unknown }).next === 'function') {
          try {
            kit.carryFrame(result, frame)
          } catch {
            /* frozen or exotic object: the context floor still applies */
          }
        }
        return result
      }
    }
    proto.__neatWrapped = true
  } catch {
    /* best-effort */
  }
}

export const mongodbFacade: Facade = {
  name: 'mongodb',
  install(kit) {
    kit.hook(['mongodb'], (exports: unknown) => {
      wrapMongoCollection(kit, exports)
      return exports
    })
  },
}

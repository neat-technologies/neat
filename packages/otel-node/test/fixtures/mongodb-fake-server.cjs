// A minimal MongoDB wire-protocol peer for the mongodb 2.x driver: answers every
// OP_QUERY with one OP_REPLY document. It reports maxWireVersion 3, so the driver
// issues find/insert as commands against `<db>.$cmd`. No database involved.
const net = require('node:net')
const path = require('node:path')
const BSON = require(require.resolve('bson', { paths: [path.dirname(require.resolve('mongodb-core'))] }))
const bson = new BSON()

function cstringEnd(buf, at) {
  let i = at
  while (buf[i] !== 0) i++
  return i
}

function replyFor(ns, query) {
  if (query.find) return { ok: 1, cursor: { id: 0, ns: ns.replace('$cmd', query.find), firstBatch: [{ _id: 1, user: 'alice' }] } }
  if (query.insert) return { ok: 1, n: 1 }
  return { ok: 1, ismaster: true, maxWireVersion: 3, minWireVersion: 0, maxBsonObjectSize: 16777216, maxMessageSizeBytes: 48000000, maxWriteBatchSize: 1000 }
}

function start(onListening) {
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 16 && pending.length >= pending.readInt32LE(0)) {
        const len = pending.readInt32LE(0)
        const msg = pending.subarray(0, len)
        pending = pending.subarray(len)
        const requestId = msg.readInt32LE(4)
        if (msg.readInt32LE(12) !== 2004) continue // only OP_QUERY expects a reply
        const nsEnd = cstringEnd(msg, 20)
        const ns = msg.toString('utf8', 20, nsEnd)
        const query = bson.deserialize(msg.subarray(nsEnd + 9))
        const doc = bson.serialize(replyFor(ns, query))
        const out = Buffer.alloc(36 + doc.length)
        out.writeInt32LE(36 + doc.length, 0)
        out.writeInt32LE(requestId + 1, 4)
        out.writeInt32LE(requestId, 8)
        out.writeInt32LE(1, 12) // OP_REPLY
        out.writeInt32LE(0, 16) // responseFlags
        out.writeBigInt64LE(0n, 20) // cursorID
        out.writeInt32LE(0, 28) // startingFrom
        out.writeInt32LE(1, 32) // numberReturned
        doc.copy(out, 36)
        socket.write(out)
      }
    })
  })
  server.listen(0, '127.0.0.1', () => onListening(server))
  return server
}

module.exports = { start }

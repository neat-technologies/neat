// An unmodified socket.io app: one event handler, one client emit, then exit.
// The attachment must stamp the CONSUMER span with the handler's registration line.
const { Server } = require('socket.io')
const { io: connect } = require('socket.io-client')
const http = require('node:http')
const srv = http.createServer()
const io = new Server(srv)
io.on('connection', (socket) => {
  socket.on('getMonitorList', (payload, ack) => { ack({ ok: true }) })
})
srv.listen(0, '127.0.0.1', () => {
  const client = connect('http://127.0.0.1:' + srv.address().port, { transports: ['websocket'] })
  client.emit('getMonitorList', {}, () => { client.close(); io.close(); setTimeout(() => process.exit(0), 100) })
})

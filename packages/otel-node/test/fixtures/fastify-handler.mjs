// An unmodified fastify app: one route, one request to itself, then exit.
// The attachment must stamp the SERVER span with the route's registration line.
import fastify from 'fastify'
import http from 'node:http'
const app = fastify()
app.get('/hello', async () => 'ok')
app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
  http.get('http://127.0.0.1:' + app.server.address().port + '/hello', (r) => { r.resume(); r.on('end', () => setTimeout(() => { app.close(); process.exit(0) }, 100)) })
})

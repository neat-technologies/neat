// A plain CommonJS app. References NEAT and OpenTelemetry nowhere. The only
// thing that instruments it is the `--require @neat.is/otel-node/register` on
// the command line. The http.get below is the call-site we expect stamped.
const http = require('node:http')

const server = http.createServer((req, res) => res.end('ok'))
server.listen(0, () => {
  const port = server.address().port
  const req = http.get(`http://127.0.0.1:${port}/hello`, (res) => {
    res.resume()
    res.on('end', () => {
      server.close()
      setTimeout(() => process.exit(0), 600)
    })
  })
  req.on('error', () => process.exit(1))
})

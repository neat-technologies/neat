// A plain ESM app. References NEAT and OpenTelemetry nowhere. Instrumented only
// by `--import @neat.is/otel-node/register`, which must install the ESM loader
// hook for the http import to be patched.
import http from 'node:http'

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

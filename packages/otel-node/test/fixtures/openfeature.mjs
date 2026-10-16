import http from 'node:http'
import { OpenFeature, InMemoryProvider } from '@openfeature/server-sdk'

await OpenFeature.setProviderAndWait(
  new InMemoryProvider({ paymentFailure: { variants: { '50%': 0.5, off: 0 }, defaultVariant: '50%', disabled: false } }),
)
const client = OpenFeature.getClient()
const server = http.createServer(async function charge(req, res) {
  res.end(String(await client.getNumberValue('paymentFailure', 0)))
})
server.listen(0, () => {
  http.get({ port: server.address().port, path: '/charge' }, (r) => {
    r.resume()
    r.on('end', () => server.close())
  })
})

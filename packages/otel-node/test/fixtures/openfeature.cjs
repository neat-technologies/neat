const http = require('node:http')
const { OpenFeature, InMemoryProvider } = require('@openfeature/server-sdk')

const flags = {
  cartFailure: { variants: { on: true, off: false }, defaultVariant: 'on', disabled: false },
  layout: { variants: { a: { columns: 2 } }, defaultVariant: 'a', disabled: false },
}

async function main() {
  // A flag read at boot has no span to attach to.
  await OpenFeature.setProviderAndWait(new InMemoryProvider(flags))
  await OpenFeature.getClient().getBooleanValue('cartFailure', false)
  const client = OpenFeature.getClient()
  const server = http.createServer(async function emptyCart(req, res) {
    const ctx = { targetingKey: 'user-42', email: 'a@b.c' }
    const fail = await client.getBooleanValue('cartFailure', false, ctx)
    const missing = await client.getStringValue('noSuchFlag', 'dflt', ctx)
    const layout = await client.getObjectValue('layout', {}, ctx)
    res.end(JSON.stringify({ fail, missing, layout }))
  })
  server.listen(0, () => {
    http.get({ port: server.address().port, path: '/cart/empty' }, (r) => {
      r.resume()
      r.on('end', () => server.close())
    })
  })
}
main()

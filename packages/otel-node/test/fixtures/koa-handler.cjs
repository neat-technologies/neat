// An unmodified koa app (koa 2, which the koa instrumentation patches) on @koa/router:
// one route, one request to itself, then exit. The SERVER span should carry
// the router.get(...) registration line.
const Koa = require('koa')
const Router = require('@koa/router')
const http = require('node:http')
const app = new Koa()
const router = new Router()
router.get('/hello', async (ctx) => { ctx.body = 'ok' })
app.use(router.routes())
const srv = app.listen(0, () => {
  http.get('http://127.0.0.1:' + srv.address().port + '/hello', (r) => { r.resume(); r.on('end', () => setTimeout(() => { srv.close(); process.exit(0) }, 100)) })
})

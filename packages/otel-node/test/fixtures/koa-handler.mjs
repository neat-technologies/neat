// The ESM form of koa-handler.cjs: koa and the router arrive through the import hook.
// The SERVER span should carry the router.get(...) registration line.
import Koa from 'koa'
import Router from '@koa/router'
import http from 'node:http'
const app = new Koa()
const router = new Router()
router.get('/hello', async (ctx) => { ctx.body = 'ok' })
app.use(router.routes())
const srv = app.listen(0, () => {
  http.get('http://127.0.0.1:' + srv.address().port + '/hello', (r) => { r.resume(); r.on('end', () => setTimeout(() => { srv.close(); process.exit(0) }, 100)) })
})

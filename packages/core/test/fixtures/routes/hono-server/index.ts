import { Hono } from 'hono'

const app = new Hono()

app.get('/widgets/:id', (c) => c.json({ id: c.req.param('id') }))

app.post('/widgets', async (c) => c.json({ created: true }))

export default app

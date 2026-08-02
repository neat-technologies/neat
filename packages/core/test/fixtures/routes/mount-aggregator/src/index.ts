import express from 'express'
import routes from './routes/routes'

const app = express()

app.get('/health', (req, res) => res.send('ok'))
// Mounted with no prefix here; the '/api' prefix lives one file deeper.
app.use(routes)

export default app

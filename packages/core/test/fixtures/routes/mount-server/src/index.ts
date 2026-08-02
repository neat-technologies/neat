import express from 'express'
import apiRouter from './api-router'
import cfgRouter from './cfg-router'

const app = express()

// A computed / config-derived prefix — NEAT can't read the literal, so the
// mounted router's routes stay un-prefixed rather than guessed (ADR-160).
const PREFIX = process.env.BASE_PATH ?? '/legacy'

app.get('/health', (req, res) => res.send('ok'))

// A literal string prefix over a cross-file router → composes to /api/things.
app.use('/api', apiRouter)

// A computed prefix → cfgRouter's routes are left bare.
app.use(PREFIX, cfgRouter)

export default app

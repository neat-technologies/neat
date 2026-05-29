// Capture harness sample service (file-awareness.md §4, ADR-090).
//
// One small CJS Express app whose routes each exercise a different real
// auto-instrumentation tier, so the harness can assert NEAT lands file-grained
// code.* on every emitted CLIENT/PRODUCER/SERVER span:
//
//   sync-wrapper   — pg query, http client call (stack walk at span start)
//   handler-floor  — a handler doing no facade call (SERVER span gets the
//                    handler frame via the handler-entry wrap)
//   off-stack #1   — undici / built-in fetch (diagnostics_channel)
//   off-stack #2   — @prisma/instrumentation (backdated dispatch)
//   aws-sdk v3     — a single SQS call (placeholder creds; fails at auth, the
//                    CLIENT span still emits) — the live sync-wrapper datapoint
//
// otel-init.cjs is injected by `neat init` before this file runs, so the
// instrumentation is live by the time the server boots. CJS on purpose: the
// require-in-the-middle-based framework/Prisma wraps hook CJS require.

const express = require('express')
const http = require('node:http')

const PORT = Number.parseInt(process.env.PORT || '8082', 10)
// A local sink the /http and /fetch routes call so the harness needs no
// outbound network. Started below on PORT+1.
const SINK_PORT = PORT + 1

const app = express()

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

// sync-wrapper tier — a pg query. The pg instrumentation wraps the driver
// synchronously, so the call-site frame is on the stack at span creation.
app.get('/sync-pg', async (_req, res) => {
  const { Client } = require('pg')
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  try {
    await client.connect()
    await client.query('SELECT 1 AS one')
    res.json({ pg: 'ok' })
  } catch (err) {
    // A connect/query failure still emits the CLIENT span we assert on.
    res.status(200).json({ pg: 'err', message: String(err && err.message) })
  } finally {
    try { await client.end() } catch (_e) { /* ignore */ }
  }
})

// sync-wrapper tier — an http client call to the local sink.
app.get('/http', (_req, res) => {
  const req = http.get({ host: '127.0.0.1', port: SINK_PORT, path: '/ping' }, (up) => {
    up.resume()
    up.on('end', () => res.json({ http: 'ok' }))
  })
  req.on('error', () => res.status(200).json({ http: 'err' }))
})

// handler-entry floor — this handler calls no facade-wrapped library, so its
// SERVER span only gets code.* from the handler-entry wrap stamping the active
// span with the registration frame.
app.get('/floor', (_req, res) => {
  let n = 0
  for (let i = 0; i < 1000; i++) n += i
  res.json({ floor: n })
})

// off-stack #1 — Node's built-in fetch (undici). The span is created in a
// diagnostics_channel handler off the caller's stack; the facade wrap must have
// pushed this call site into context.
app.get('/fetch', async (_req, res) => {
  try {
    const r = await fetch(`http://127.0.0.1:${SINK_PORT}/ping`)
    await r.text()
    res.json({ fetch: 'ok' })
  } catch (err) {
    res.status(200).json({ fetch: 'err', message: String(err && err.message) })
  }
})

// off-stack #2 — @prisma/instrumentation. The query fails (no schema pushed)
// but still emits a span; the facade wrap attributes it to this call site.
app.get('/prisma', async (_req, res) => {
  try {
    const { PrismaClient } = require('@prisma/client')
    const prisma = new PrismaClient()
    try {
      await prisma.widget.findMany()
      res.json({ prisma: 'ok' })
    } finally {
      await prisma.$disconnect()
    }
  } catch (err) {
    res.status(200).json({ prisma: 'err', message: String(err && err.message) })
  }
})

// aws-sdk v3 live confirm — one SQS call with placeholder creds. It fails at
// auth/endpoint resolution, but the CLIENT span emits and confirms the
// inventory's sync-wrapper classification with a live datapoint.
app.get('/aws', async (_req, res) => {
  try {
    const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs')
    const sqs = new SQSClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAFAKEFAKEFAKE', secretAccessKey: 'fake/secret' },
      maxAttempts: 1,
    })
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/neat-capture',
        MessageBody: 'capture-probe',
      }),
    )
    res.json({ aws: 'ok' })
  } catch (err) {
    res.status(200).json({ aws: 'err', message: String(err && err.message) })
  }
})

const sink = http.createServer((_req, res) => {
  res.end('pong')
})
sink.listen(SINK_PORT, '127.0.0.1', () => {
  app.listen(PORT, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`capture-app listening on http://127.0.0.1:${PORT} (sink on ${SINK_PORT})`)
  })
})

// Tart e2e fixture — a small, self-contained "Brief-like" service.
//
// The point of this app is not to be load-bearing software; it's to be a
// believable graph. When NEAT instruments it and we drive a little traffic,
// the daemon should grow a handful of OBSERVED edges that look like a real
// service: an outbound HTTP CALLS edge to a frontier host, and a CONNECTS_TO
// edge to a database. Both have to form with zero external dependencies — no
// Postgres, no creds, no internet — because this runs inside a fresh macOS VM.
//
// How each OBSERVED edge gets formed:
//   - CALLS -> frontier:  /quote and /enrich make a real http client call to
//     an upstream the app names by host. By default that upstream is a tiny
//     local stub this same process starts (UPSTREAM_URL), so the app talks to
//     a named host and the call always succeeds offline. Point UPSTREAM_URL at
//     a real httpbin-style endpoint to exercise the genuine-internet path.
//   - CONNECTS_TO -> database:  /items and /report open a better-sqlite3
//     connection to a file under the OS temp dir and run real queries. SQLite
//     is in-process, so the database "server" needs nothing installed.
//
// neat init injects otel-init before this file runs (NODE_OPTIONS=-r
// ./otel-init.cjs, or the orchestrator wires it), so the auto-instrumentation
// is live by the time the server boots. CJS on purpose: the
// require-in-the-middle hooks the bundled OTel set installs wrap CJS require,
// and better-sqlite3 + the http client are loaded through require here.

const express = require('express')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const PORT = Number.parseInt(process.env.PORT_APP || process.env.FIXTURE_PORT || '8080', 10)

// The upstream the app "calls". Default is a local stub we start below on
// STUB_PORT, but addressed by a NON-loopback NAME (upstream.neat.local) rather
// than 127.0.0.1. That distinction is load-bearing: NEAT deliberately suppresses
// a loopback peer on a CLIENT span — a call to 127.0.0.1/localhost is the app
// talking to itself, not a distinct upstream (ingest.ts isLoopbackHost, issues
// #590/#577) — so a 127.0.0.1 upstream would form NO CALLS->frontier edge. The
// name resolves to the local stub via an /etc/hosts entry the harness adds; the
// stub still binds loopback. Set UPSTREAM_URL to a real external endpoint to test
// the real-internet path (that also disables the built-in stub).
const STUB_PORT = Number.parseInt(process.env.STUB_PORT || String(PORT + 1), 10)
const EXTERNAL_UPSTREAM = process.env.UPSTREAM_URL
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'upstream.neat.local'
const UPSTREAM_URL = EXTERNAL_UPSTREAM || `http://${UPSTREAM_HOST}:${STUB_PORT}`

// SQLite lives in a writable temp dir so a read-only mount never blocks it.
const DB_PATH =
  process.env.FIXTURE_DB_PATH || path.join(os.tmpdir(), `neat-tart-fixture-${process.pid}.sqlite`)

// ---------------------------------------------------------------------------
// Database — a single better-sqlite3 connection, opened lazily and reused.
//
// The bundled OTel auto-instrumentation set covers pg / mysql / mongo / redis
// but has no SQLite instrumentation, so a raw better-sqlite3 call emits no span
// and no CONNECTS_TO edge would form. We close that gap the same honest way
// `neat extend` does for an uncovered library: emit a *real* CLIENT span at the
// call site carrying the db.* semconv NEAT's ingest reads (db.system + an
// address resolve to a DatabaseNode and a CONNECTS_TO edge). The span is
// genuine OTel, not a mock — and because it's created synchronously at the call
// site, NEAT's call-site span processor stamps code.filepath/lineno on it, so
// the CONNECTS_TO edge lands file-grained like the HTTP one.
//
// @opentelemetry/api is on the dependency tree because `neat init` adds it; we
// require it lazily and degrade to a no-op span if it isn't present, so the app
// still runs uninstrumented.
const DB_SYSTEM = 'sqlite'
const DB_ADDRESS = process.env.FIXTURE_DB_HOST || 'sqlite.local'

let _tracer = null
function tracer() {
  if (_tracer !== null) return _tracer
  try {
    _tracer = require('@opentelemetry/api').trace.getTracer('neat-tart-fixture-db')
  } catch (_e) {
    _tracer = false // api not installed → run without DB spans
  }
  return _tracer
}

// Run a DB operation inside a real CLIENT span so NEAT forms CONNECTS_TO.
function withDbSpan(op, statement, fn) {
  const t = tracer()
  if (!t) return fn()
  const api = require('@opentelemetry/api')
  const span = t.startSpan(`sqlite ${op}`, { kind: api.SpanKind.CLIENT })
  span.setAttribute('db.system', DB_SYSTEM)
  span.setAttribute('db.name', path.basename(DB_PATH))
  span.setAttribute('server.address', DB_ADDRESS)
  span.setAttribute('db.statement', statement)
  try {
    return fn()
  } catch (err) {
    span.recordException(err)
    throw err
  } finally {
    span.end()
  }
}

let db = null
function getDb() {
  if (db) return db
  const Database = require('better-sqlite3')
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  // Seed once so reads return rows.
  const count = db.prepare('SELECT COUNT(*) AS n FROM items').get().n
  if (count === 0) {
    const insert = db.prepare('INSERT INTO items (name) VALUES (?)')
    for (const name of ['alpha', 'bravo', 'charlie']) insert.run(name)
  }
  return db
}

// A small http client call to the named upstream. Returns the status so the
// route can report it; the OBSERVED CALLS edge forms regardless of the body.
function callUpstream(pathSuffix) {
  return new Promise((resolve) => {
    const url = new URL(pathSuffix || '/get', UPSTREAM_URL)
    const req = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, timeout: 4000 },
      (up) => {
        let body = ''
        up.on('data', (c) => {
          body += c
        })
        up.on('end', () => resolve({ status: up.statusCode, body: body.slice(0, 200) }))
      },
    )
    req.on('timeout', () => req.destroy(new Error('upstream timeout')))
    req.on('error', (err) => resolve({ status: 0, error: String(err && err.message) }))
  })
}

const app = express()
app.use(express.json())

// Liveness — the cheapest span, always available. run.sh polls this for boot.
app.get('/health', (_req, res) => {
  res.json({ ok: true, db: DB_PATH, upstream: UPSTREAM_URL })
})

// Outbound HTTP tier — forms CALLS -> frontier:<upstream host>.
app.get('/quote', async (_req, res) => {
  const up = await callUpstream('/get?symbol=NEAT')
  res.json({ route: 'quote', upstream: UPSTREAM_URL, upstreamStatus: up.status })
})

// Outbound HTTP tier again, different call site — a second file/line origin
// for the CALLS edge, so the graph shows more than one call point.
app.get('/enrich', async (_req, res) => {
  const up = await callUpstream('/get?enrich=1')
  res.json({ route: 'enrich', upstreamStatus: up.status, sample: up.body })
})

// Database read tier — forms CONNECTS_TO -> database (sqlite).
app.get('/items', (_req, res) => {
  try {
    const sql = 'SELECT id, name, created_at FROM items ORDER BY id'
    const rows = withDbSpan('SELECT', sql, () => getDb().prepare(sql).all())
    res.json({ route: 'items', count: rows.length, rows })
  } catch (err) {
    res.status(200).json({ route: 'items', error: String(err && err.message) })
  }
})

// Database write tier — a second DB call site so the CONNECTS_TO edge has
// real traffic and a believable callCount.
app.post('/items', (req, res) => {
  try {
    const name = (req.body && req.body.name) || `item-${Date.now()}`
    const sql = 'INSERT INTO items (name) VALUES (?)'
    const info = withDbSpan('INSERT', sql, () => getDb().prepare(sql).run(name))
    res.json({ route: 'items', inserted: { id: info.lastInsertRowid, name } })
  } catch (err) {
    res.status(200).json({ route: 'items', error: String(err && err.message) })
  }
})

// A route that fans out to both tiers — DB read then an upstream call — so the
// graph shows a handler that both reads its database and calls a frontier.
app.get('/report', async (_req, res) => {
  let count = -1
  try {
    const sql = 'SELECT COUNT(*) AS n FROM items'
    count = withDbSpan('SELECT', sql, () => getDb().prepare(sql).get().n)
  } catch (_e) {
    /* edge still forms on the attempt */
  }
  const up = await callUpstream('/get?report=1')
  res.json({ route: 'report', itemCount: count, upstreamStatus: up.status })
})

// ---------------------------------------------------------------------------
// Boot — start the local stub first (only if UPSTREAM_URL points at it), then
// the app, so the named upstream answers immediately.
// ---------------------------------------------------------------------------
function startApp() {
  app.listen(PORT, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[fixture] listening on http://127.0.0.1:${PORT}  upstream=${UPSTREAM_URL}  db=${DB_PATH}`,
    )
  })
}

const usingLocalStub = !EXTERNAL_UPSTREAM
if (usingLocalStub) {
  // A deterministic httpbin-ish stub: GET /get echoes a small JSON body.
  const stub = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ url: req.url, origin: '127.0.0.1', service: 'neat-tart-stub' }))
  })
  stub.listen(STUB_PORT, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`[fixture] local upstream stub on http://127.0.0.1:${STUB_PORT}`)
    startApp()
  })
} else {
  startApp()
}

// Clean up the WAL sidecars on exit so reruns start fresh.
process.on('SIGTERM', () => {
  try {
    if (db) db.close()
    for (const ext of ['', '-wal', '-shm']) {
      const f = DB_PATH + ext
      if (fs.existsSync(f)) fs.rmSync(f, { force: true })
    }
  } catch (_e) {
    /* ignore */
  }
  process.exit(0)
})

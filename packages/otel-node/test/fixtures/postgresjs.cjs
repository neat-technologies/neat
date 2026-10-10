// postgres.js against a port nothing listens on: the query is executed and
// rejected (connection refused), which exercises start → reject → export.
const postgres = require('postgres')
const sql = postgres({ host: '127.0.0.1', port: 1, database: 'orders', user: 'app', connect_timeout: 2 })
// Built but never run: must not produce a span.
sql`select 'never executed'`
async function chargeCard(id) {
  return sql`select * from payments where id = ${id}`
}
chargeCard(42)
  .catch(() => {})
  .finally(() => setTimeout(() => process.exit(0), 600))

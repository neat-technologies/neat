// knex configured with a dialect CLASS instead of a client name, the way
// uptime-kuma (via redbean-node) does it. The instrumentation can't map a class
// to db.system. The fake dialect answers every query itself, so no database or
// driver is involved.
const knex = require('knex')
const PgDialect = require('knex/lib/dialects/postgres')
class FakePg extends PgDialect {
  initializeDriver() { this.driver = {} }
  async acquireConnection() { return { __knexUid: 'fake' } }
  async releaseConnection() {}
  _query(connection, obj) { return Promise.resolve(Object.assign(obj, { response: { rows: [], fields: [] } })) }
  processResponse() { return [] }
}
const db = knex({ client: FakePg, connection: { host: '127.0.0.1', port: 5432, database: 'kuma', user: 'kuma' } })
async function loadMonitors() { return db('monitor').select('id', 'name').where('active', true) }
loadMonitors().then(() => db.destroy()).finally(() => setTimeout(() => process.exit(0), 300))

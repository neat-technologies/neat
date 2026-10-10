import postgres from 'postgres'
const sql = postgres({ host: '127.0.0.1', port: 1, database: 'orders', connect_timeout: 2 })
async function listOrders() {
  return sql`select id from orders limit ${5}`
}
try {
  await listOrders()
} catch {}
setTimeout(() => process.exit(0), 600)

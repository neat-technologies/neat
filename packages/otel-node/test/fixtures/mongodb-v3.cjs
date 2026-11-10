// An unmodified mongodb 3.1 app (NodeGoat's CVE-fix line) against a fake peer:
// one find and one insert, each from a named function on a known line.
const { MongoClient } = require('mongodb-3')
const { start } = require('./mongodb-fake-server.cjs')

start((server) => {
  MongoClient.connect('mongodb://127.0.0.1:' + server.address().port + '/nodegoat', (err, client) => {
    if (err) { console.error('connect failed', err); process.exit(1) }
    const db = client.db('nodegoat')
    function findUser(cb) { db.collection('users').find({ user: 'alice' }).toArray(cb) }
    function addAllocation(cb) { db.collection('allocations').insertOne({ userId: 1 }, cb) }
    findUser((e1) => {
      addAllocation((e2) => {
        if (e1 || e2) console.error('op failed', e1 || e2)
        client.close()
        server.close()
        setTimeout(() => process.exit(0), 200)
      })
    })
  })
})

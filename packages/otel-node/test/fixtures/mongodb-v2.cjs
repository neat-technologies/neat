// An unmodified mongodb 2.x app (NodeGoat's driver line) against a fake peer:
// one find and one insert, each from a named function on a known line.
const { MongoClient } = require('mongodb')
const { start } = require('./mongodb-fake-server.cjs')

start((server) => {
  MongoClient.connect('mongodb://127.0.0.1:' + server.address().port + '/nodegoat', (err, db) => {
    if (err) { console.error('connect failed', err); process.exit(1) }
    function findUser(cb) { db.collection('users').find({ user: 'alice' }).toArray(cb) }
    function addAllocation(cb) { db.collection('allocations').insertOne({ userId: 1 }, cb) }
    findUser((e1) => {
      addAllocation((e2) => {
        if (e1 || e2) console.error('op failed', e1 || e2)
        db.close()
        server.close()
        setTimeout(() => process.exit(0), 200)
      })
    })
  })
})

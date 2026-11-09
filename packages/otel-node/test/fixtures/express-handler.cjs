// An unmodified express app: one route, one request to itself, then exit.
// The attachment must stamp the SERVER span with the route's registration line.
const express = require('express')
const http = require('node:http')
const app = express()
app.get('/hello', (req, res) => { res.send('ok') })
const srv = app.listen(0, () => {
  http.get('http://127.0.0.1:' + srv.address().port + '/hello', (r) => { r.resume(); r.on('end', () => setTimeout(() => { srv.close(); process.exit(0) }, 100)) })
})

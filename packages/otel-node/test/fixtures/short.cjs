// A short-lived script: one outbound call, then it exits on its own. No
// server keeps it alive, so its spans only leave if the preload flushes on exit.
const http = require('node:http')
const target = process.env.FIXTURE_TARGET
http.get(target, (res) => res.resume()).on('error', () => {})

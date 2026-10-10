// An app with its own async cleanup on beforeExit: a 500 ms timer that prints a
// marker. The preload's flush must not cut it off.
let cleaned = false
process.on('beforeExit', () => {
  if (cleaned) return
  cleaned = true
  setTimeout(() => console.log('app-cleanup-done'), 500)
})
require('node:http').get(process.env.FIXTURE_TARGET, (res) => res.resume()).on('error', () => {})

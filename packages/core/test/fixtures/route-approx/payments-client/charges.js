// Base URL held in a const and interpolated ahead of a literal path. The host
// lives in the interpolation, so the naive reconstruction produces `:param` for
// the whole authority and the call is silently dropped. Resolving the const in
// scope recovers the real host and the literal `/charges` path.
const PAYMENTS_BASE = 'http://payments-api:7000'

async function listCharges() {
  const res = await fetch(`${PAYMENTS_BASE}/charges`)
  return res.json()
}

module.exports = { listCharges }

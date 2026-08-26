// Control: a fully literal URL. Nothing is interpolated, so this must keep
// grading verified-call-site (0.85) before and after the fidelity change.
async function health() {
  const res = await fetch('http://payments-api:7000/health')
  return res.json()
}

module.exports = { health }

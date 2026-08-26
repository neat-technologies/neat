// Base URL comes from a runtime argument — nothing static to resolve it to. The
// host cannot be recovered, so there is no target to attribute the call to. It
// must surface as an approximate diagnostic rather than vanishing silently.
async function callDynamic(baseUrl) {
  const res = await fetch(`${baseUrl}/charges`)
  return res.json()
}

module.exports = { callDynamic }

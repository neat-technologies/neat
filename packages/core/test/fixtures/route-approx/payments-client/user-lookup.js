// Genuine path parameter: a literal `/charges` segment anchors the route, and
// the interpolated id fills the slot the route declares. The literal anchor is
// what keeps this a confident match even though one segment is interpolated.
async function getCharge(id) {
  const res = await fetch(`http://payments-api:7000/charges/${id}`)
  return res.json()
}

module.exports = { getCharge }

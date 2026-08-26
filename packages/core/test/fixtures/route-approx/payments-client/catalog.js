// Literal host, but the only path segment is computed at runtime. The
// reconstruction is a lone `:param`, which matches the server's bare `/:id`
// route with no literal evidence that this client ever calls it. This is the
// confident false positive: a 0.85 edge to a route picked purely by shape.
async function fetchCategory(category) {
  const res = await fetch(`http://payments-api:7000/${category.toLowerCase()}`)
  return res.json()
}

module.exports = { fetchCategory }

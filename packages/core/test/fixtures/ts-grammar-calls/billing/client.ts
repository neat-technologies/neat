// A typed HTTP client for the `orders` service. The endpoint is written with a
// TypeScript angle-bracket type assertion — a shape tree-sitter-javascript
// can't parse. Under the JS grammar the whole expression collapses into an
// ERROR node and the URL literal is dropped, so the CALLS edge to `orders`
// went silently missing on this valid .ts file (issue #883). The TypeScript
// grammar parses it and the edge lands.
const endpoint = <string>'https://orders/charge'

export async function charge(amount: number): Promise<boolean> {
  const res = await fetch(endpoint, { method: 'POST', body: String(amount) })
  return res.ok
}

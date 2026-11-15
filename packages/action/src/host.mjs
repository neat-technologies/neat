// Queries to a connected NEAT host (neat-api-url): divergences and observed
// breaks for the fused graph comment. Every failure degrades to "nothing found";
// the static findings still stand.

import { NEAT_API_TOKEN, apiUrl } from './config.mjs'
import { formatDivergences, observedBreakFrom } from './graph.mjs'

// Headers for a request to the connected NEAT host. When a token is configured —
// a self-hosted daemon exposed over the customer's own network, or the hosted
// plane, both authenticate the /graph/* API — it rides as a bearer; unset (the
// neat-local static tier connects to no host) sends none. Read at call time so
// tests don't fight the module cache, same as the URL.
export function apiHeaders() {
  const token = process.env.INPUT_NEAT_API_TOKEN || NEAT_API_TOKEN
  const headers = { Accept: 'application/json', 'User-Agent': 'neat-action' }
  if (token) headers.Authorization = 'Bearer ' + token
  return headers
}

// The fused tier: query a connected NEAT host for declared-vs-observed
// divergences, keep the ones that involve a node this PR changed, and format
// them. Tolerant of the response shape; a host error degrades to the static tier.
export async function fetchDivergences(changedNodeIds) {
  const url = apiUrl()
  if (!url) return []
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/graph/divergences', {
      headers: apiHeaders(),
    })
    if (!res.ok) return []
    return formatDivergences(await res.json(), changedNodeIds)
  } catch {
    return []
  }
}

// The observed-break scan: for each node this PR removes or changes, ask the
// connected host what production actually does with it
// (GET /graph/observed-dependencies/:nodeId). A node the OTel layer has *seen*
// (`observed: true`) is one production is live on, so removing or changing it is
// a break. The response carries counts of observed edges — inboundObservedCount
// (callers of the node) and dependencies (the OBSERVED calls it makes) — but no
// request volume and no timestamp, so we surface honest dependent counts and let
// the renderer degrade gracefully. Never fabricate "served N× in 7d." Reads
// INPUT_NEAT_API_URL at call time so tests don't fight the module cache.
export async function fetchObservedBreaks(nodes) {
  const url = apiUrl()
  if (!url || !nodes?.length) return []
  const base = url.replace(/\/+$/, '')
  const breaks = []
  for (const node of nodes) {
    try {
      const res = await fetch(
        base + '/graph/observed-dependencies/' + encodeURIComponent(node.id),
        { headers: apiHeaders() },
      )
      if (!res.ok) continue
      const found = observedBreakFrom(node, await res.json())
      if (found) breaks.push(found)
    } catch {
      // A host hiccup on one node degrades that node to "no observed break," not
      // the whole run — the static findings still stand.
    }
  }
  return breaks
}

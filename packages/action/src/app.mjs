// NEAT GitHub App — the stateful, zero-config-install form of neat-action
// (Phase 3). Where the Action runs in the user's CI, the App is a hosted service:
// it receives pull_request webhooks, authenticates as the installed App, and
// posts the same graph-impact comment — reusing the exact graph logic in
// graph.mjs. Because it is a persistent service, it is also the natural "connected
// NEAT host" the Action's fused tier (neat-api-url) points at.
//
// This module is the App's security + wiring core (webhook verification, App
// auth, event routing), Node builtins only. The graph-impact computation reuses
// the Action's flow (extract base+head → diffGraphs → blastRadius → renderComment).
// Registering the App under a GitHub org and deploying this to a public host are
// operational steps — see DEPLOY.md.

import crypto from 'node:crypto'
import http from 'node:http'
import { renderComment, diffGraphs } from './graph.mjs'

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// Verify a GitHub webhook's `X-Hub-Signature-256` (HMAC-SHA256 of the raw body
// with the webhook secret), timing-safe.
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Build a short-lived App JWT (RS256) from the App id + PEM private key — the
// credential exchanged for an installation access token.
export function appJwt(appId, privateKeyPem, iatSeconds) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const iat = iatSeconds - 30 // clock-skew slack
  const payload = b64url(JSON.stringify({ iat, exp: iat + 570, iss: String(appId) }))
  const signingInput = `${header}.${payload}`
  const sig = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem)
  return `${signingInput}.${b64url(sig)}`
}

// Exchange the App JWT for an installation access token (posts the graph comment).
async function installationToken(appId, privateKeyPem, installationId, now) {
  const jwt = appJwt(appId, privateKeyPem, now)
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'neat-app',
    },
  })
  if (!res.ok) throw new Error(`installation token → ${res.status}`)
  return (await res.json()).token
}

// The webhook handler: verify, route pull_request events, authenticate, and post
// the graph-impact comment. `computeImpact` clones + extracts base/head and
// returns { delta, changedFiles, divergences } — it reuses the Action's flow
// (see main.mjs); injected so this stays testable without git/network.
export function makeHandler({ secret, appId, privateKey, computeImpact, now = () => Math.floor(Date.now() / 1000) }) {
  return async function handle(rawBody, headers) {
    if (!verifyWebhookSignature(rawBody, headers['x-hub-signature-256'], secret)) {
      return { status: 401, body: 'bad signature' }
    }
    if (headers['x-github-event'] !== 'pull_request') return { status: 204, body: '' }
    const event = JSON.parse(rawBody)
    if (!['opened', 'synchronize', 'reopened'].includes(event.action)) return { status: 204, body: '' }

    const pr = event.pull_request
    const [owner, repo] = event.repository.full_name.split('/')
    const token = await installationToken(appId, privateKey, event.installation.id, now())
    const { delta, changedFiles, divergences, graph } = await computeImpact({
      owner, repo, prNumber: pr.number, baseSha: pr.base.sha, headSha: pr.head.sha, token,
      cloneUrl: event.repository.clone_url,
    })
    const { marker, body } = renderComment({
      graph,
      delta: delta ?? diffGraphs({ nodes: new Map(), edges: [] }, graph),
      changedFiles,
      divergences,
      connected: divergences.length > 0,
    })
    await postSticky({ owner, repo, prNumber: pr.number, token, marker, body })
    return { status: 200, body: 'ok' }
  }
}

async function githubApi(token, method, url, body) {
  const res = await fetch('https://api.github.com' + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'neat-app',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`GitHub ${method} ${url} → ${res.status}`)
  return res.json()
}

async function postSticky({ owner, repo, prNumber, token, marker, body }) {
  const comments = await githubApi(token, 'GET', `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`)
  const existing = comments.find((c) => (c.body || '').includes(marker))
  if (existing) await githubApi(token, 'PATCH', `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { body })
  else await githubApi(token, 'POST', `/repos/${owner}/${repo}/issues/${prNumber}/comments`, { body })
}

// Minimal server wrapper. `computeImpact` must be supplied by the deploy
// (it reuses the Action's clone+extract flow).
export function startServer({ port = Number(process.env.PORT) || 3000, ...opts }) {
  const handle = makeHandler(opts)
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        const { status, body } = await handle(raw, req.headers)
        res.statusCode = status
        res.end(body)
      } catch (e) {
        res.statusCode = 500
        res.end(String(e.message))
      }
    })
  })
  server.listen(port)
  return server
}

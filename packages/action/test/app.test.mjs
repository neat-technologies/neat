import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { verifyWebhookSignature, appJwt, makeHandler } from '../src/app.mjs'

test('verifyWebhookSignature accepts a valid signature, rejects tampering', () => {
  const secret = 's3cret'
  const body = '{"hello":"world"}'
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  assert.equal(verifyWebhookSignature(body, sig, secret), true)
  assert.equal(verifyWebhookSignature(body + 'x', sig, secret), false)
  assert.equal(verifyWebhookSignature(body, sig, 'wrong-secret'), false)
  assert.equal(verifyWebhookSignature(body, '', secret), false)
})

test('appJwt produces an RS256 JWT that verifies with the public key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' })
  const jwt = appJwt('12345', pem, 1_700_000_000)
  const [h, p, s] = jwt.split('.')
  assert.ok(h && p && s, 'three JWT segments')
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256')
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).iss, '12345')
  const ok = crypto
    .createVerify('RSA-SHA256')
    .update(`${h}.${p}`)
    .verify(publicKey, Buffer.from(s, 'base64url'))
  assert.equal(ok, true, 'signature verifies against the public key')
})

test('handler verifies, authenticates, and posts the graph-impact comment', async () => {
  const secret = 'whsec'
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' })

  const graph = {
    nodes: new Map([['route:svc:GET /x', { type: 'RouteNode', name: 'GET /x' }]]),
    edges: [],
  }
  const computeImpact = async () => ({
    graph,
    delta: { routesAdded: ['GET /x'], routesRemoved: [], tablesAdded: [], tablesRemoved: [] },
    changedFiles: [],
    divergences: [],
  })

  let postedBody = null
  const realFetch = global.fetch
  global.fetch = async (url, opts = {}) => {
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'itok' }), { status: 201 })
    }
    if (url.includes('/comments') && opts.method === 'POST') {
      postedBody = JSON.parse(opts.body).body
      return new Response('{}', { status: 201 })
    }
    if (url.includes('/comments')) return new Response('[]', { status: 200 })
    return new Response('{}', { status: 200 })
  }
  try {
    const handle = makeHandler({
      secret,
      appId: '1',
      privateKey: pem,
      computeImpact,
      now: () => 1_700_000_000,
    })
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 7, base: { sha: 'b' }, head: { sha: 'h' } },
      repository: { full_name: 'o/r', clone_url: 'https://github.com/o/r.git' },
      installation: { id: 42 },
    })
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex')
    const out = await handle(payload, {
      'x-hub-signature-256': sig,
      'x-github-event': 'pull_request',
    })
    assert.equal(out.status, 200)
    assert.ok(postedBody.includes('GET /x'), 'the comment carries the graph delta')
    assert.ok(postedBody.includes('neat-action:graph-impact'), 'the sticky marker')
  } finally {
    global.fetch = realFetch
  }
})

test('handler rejects a bad signature with 401', async () => {
  const handle = makeHandler({ secret: 's', appId: '1', privateKey: 'x', computeImpact: async () => ({}) })
  const out = await handle('{}', { 'x-hub-signature-256': 'sha256=bad', 'x-github-event': 'pull_request' })
  assert.equal(out.status, 401)
})

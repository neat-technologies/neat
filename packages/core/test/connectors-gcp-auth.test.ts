import { describe, it, expect } from 'vitest'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import {
  buildServiceAccountAssertion,
  createGcpTokenSource,
  mintGcpAccessToken,
  parseServiceAccountKey,
  type GcpServiceAccountKey,
} from '../src/connectors/gcp-auth.js'

// A real RSA keypair so the assertion's RS256 signature can be verified for real, not just shape-checked.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const KEY: GcpServiceAccountKey = {
  client_email: 'neat-reader@acme.iam.gserviceaccount.com',
  private_key: privateKey,
  project_id: 'acme-prod',
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))
}

describe('parseServiceAccountKey', () => {
  it('reads client_email, private_key, project_id, and an optional token_uri', () => {
    const json = JSON.stringify({ ...KEY, token_uri: 'https://oauth2.example/token', extra: 'ignored' })
    const key = parseServiceAccountKey(json)
    expect(key.client_email).toBe(KEY.client_email)
    expect(key.project_id).toBe('acme-prod')
    expect(key.token_uri).toBe('https://oauth2.example/token')
  })

  it('throws a clear, secret-free error for bad JSON and each missing field', () => {
    expect(() => parseServiceAccountKey('{not json')).toThrow(/not valid JSON/)
    expect(() => parseServiceAccountKey(JSON.stringify({ private_key: 'x', project_id: 'p' }))).toThrow(/client_email/)
    expect(() => parseServiceAccountKey(JSON.stringify({ client_email: 'e', project_id: 'p' }))).toThrow(/private_key/)
    expect(() => parseServiceAccountKey(JSON.stringify({ client_email: 'e', private_key: 'x' }))).toThrow(/project_id/)
  })
})

describe('buildServiceAccountAssertion', () => {
  it('builds an RS256 JWT with the right claims and a signature the public key verifies', () => {
    const tokenUri = 'https://oauth2.googleapis.com/token'
    const nowMs = 1_800_000_000_000
    const jwt = buildServiceAccountAssertion(KEY, 'scope-a scope-b', tokenUri, nowMs)
    const [h, c, sig] = jwt.split('.')
    expect(decodeSegment(h!)).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = decodeSegment(c!)
    const iat = Math.floor(nowMs / 1000)
    expect(claims).toEqual({
      iss: KEY.client_email,
      scope: 'scope-a scope-b',
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    })
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).end().verify(publicKey, Buffer.from(sig!, 'base64url'))
    expect(ok).toBe(true)
  })
})

describe('mintGcpAccessToken', () => {
  it('posts the JWT-bearer grant and returns the token with an absolute expiry', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ access_token: 'ya29.minted', expires_in: 3600 }), { status: 200 })
    }) as unknown as typeof fetch

    const minted = await mintGcpAccessToken(KEY, 'scope', { fetchImpl, now: () => 1_000_000 })
    expect(minted.accessToken).toBe('ya29.minted')
    expect(minted.expiresAtMs).toBe(1_000_000 + 3600 * 1000)

    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token')
    const body = new URLSearchParams(calls[0]?.init?.body as string)
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect((body.get('assertion') ?? '').split('.')).toHaveLength(3)
  })

  it('throws (secret-free) on a non-2xx and on a missing access_token', async () => {
    const bad = (async () => new Response('invalid_grant', { status: 400, statusText: 'Bad Request' })) as unknown as typeof fetch
    await expect(mintGcpAccessToken(KEY, 's', { fetchImpl: bad })).rejects.toThrow(/gcp token mint failed: 400/)
    const noToken = (async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch
    await expect(mintGcpAccessToken(KEY, 's', { fetchImpl: noToken })).rejects.toThrow(/no access_token/)
  })
})

describe('createGcpTokenSource — the fix: a fresh token every tick, cheaply', () => {
  it('mints once, caches, then re-mints only after the token nears expiry — the dead-token bug is gone', async () => {
    let clock = 1_000_000
    let mints = 0
    const fetchImpl = (async () => {
      mints += 1
      return new Response(JSON.stringify({ access_token: `tok-${mints}`, expires_in: 3600 }), { status: 200 })
    }) as unknown as typeof fetch
    const source = createGcpTokenSource(KEY, 'scope', { fetchImpl, now: () => clock, refreshSkewMs: 60_000 })

    // First tick mints; the connector gets { projectId, accessToken }.
    expect(await source()).toEqual({ projectId: 'acme-prod', accessToken: 'tok-1' })
    // A tick a minute later reuses the cached token — no second mint.
    clock += 60_000
    expect(await source()).toEqual({ projectId: 'acme-prod', accessToken: 'tok-1' })
    expect(mints).toBe(1)

    // Past the ~1h lifetime (minus skew), the old token would be dead — the source re-mints instead.
    clock += 3600 * 1000
    expect(await source()).toEqual({ projectId: 'acme-prod', accessToken: 'tok-2' })
    expect(mints).toBe(2)
  })

  it('collapses a burst of concurrent ticks into a single mint', async () => {
    let mints = 0
    const fetchImpl = (async () => {
      mints += 1
      await new Promise((r) => setTimeout(r, 5))
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    }) as unknown as typeof fetch
    const source = createGcpTokenSource(KEY, 'scope', { fetchImpl })
    await Promise.all([source(), source(), source()])
    expect(mints).toBe(1)
  })
})

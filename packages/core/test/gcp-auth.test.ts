import { describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto'
import {
  buildServiceAccountAssertion,
  createGcpTokenSource,
  mintGcpAccessToken,
  parseServiceAccountKey,
  type GcpServiceAccountKey,
} from '../src/connectors/gcp-auth.js'

// A real RSA keypair so the signature is genuinely verifiable — the JWT-bearer
// flow (ADR-223) signs RS256 over the service-account private key, and these
// tests verify with the matching public key rather than trusting the shape.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const TOKEN_URI = 'https://oauth2.googleapis.com/token'

function testKey(overrides: Partial<GcpServiceAccountKey> = {}): GcpServiceAccountKey {
  return {
    client_email: 'neat-reader@neat-demo.iam.gserviceaccount.com',
    private_key: PRIVATE_PEM,
    project_id: 'neat-demo',
    ...overrides,
  }
}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}
function decodeJwtPart(part: string): unknown {
  return JSON.parse(b64urlToBuffer(part).toString('utf8'))
}

// A fetch stub that returns one token-endpoint response and records the request.
function stubTokenEndpoint(
  token: string,
  expiresIn = 3600,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: String(init?.body ?? ''),
      headers: (init?.headers as Record<string, string>) ?? {},
    })
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ access_token: token, token_type: 'Bearer', expires_in: expiresIn }),
    } as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('parseServiceAccountKey', () => {
  it('reads client_email, private_key, project_id, and an optional token_uri', () => {
    const json = JSON.stringify({ ...testKey(), token_uri: 'https://example/token', extra: 'ignored' })
    const key = parseServiceAccountKey(json)
    expect(key.client_email).toBe('neat-reader@neat-demo.iam.gserviceaccount.com')
    expect(key.project_id).toBe('neat-demo')
    expect(key.token_uri).toBe('https://example/token')
  })

  it('throws a clear, secret-free error naming a missing field', () => {
    expect(() => parseServiceAccountKey('not json')).toThrow(/not valid JSON/)
    expect(() => parseServiceAccountKey(JSON.stringify({ private_key: 'x', project_id: 'p' }))).toThrow(/client_email/)
    expect(() => parseServiceAccountKey(JSON.stringify({ client_email: 'e', project_id: 'p' }))).toThrow(/private_key/)
    expect(() => parseServiceAccountKey(JSON.stringify({ client_email: 'e', private_key: 'x' }))).toThrow(/project_id/)
  })
})

describe('buildServiceAccountAssertion (JWT-bearer, verified live against GCP docs)', () => {
  it('signs an RS256 JWT whose header + claims + signature match the flow spec', () => {
    const nowMs = 1_756_600_000_000
    const jwt = buildServiceAccountAssertion(testKey(), 'https://www.googleapis.com/auth/logging.read', TOKEN_URI, nowMs)
    const [h, c, sig] = jwt.split('.')

    expect(decodeJwtPart(h!)).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = decodeJwtPart(c!) as Record<string, unknown>
    const iat = Math.floor(nowMs / 1000)
    expect(claims).toEqual({
      iss: 'neat-reader@neat-demo.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/logging.read',
      aud: TOKEN_URI,
      iat,
      exp: iat + 3600,
    })

    // The signature verifies against the public key over `header.claims`.
    const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, b64urlToBuffer(sig!))
    expect(ok).toBe(true)
  })
})

describe('mintGcpAccessToken', () => {
  it('POSTs the JWT-bearer assertion form-encoded and returns the token with its expiry', async () => {
    const { fetchImpl, calls } = stubTokenEndpoint('ya29.minted', 3600)
    const nowMs = 1_756_600_000_000
    const minted = await mintGcpAccessToken(testKey(), 'https://www.googleapis.com/auth/logging.read', {
      fetchImpl,
      now: () => nowMs,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(TOKEN_URI)
    expect(calls[0]!.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const params = new URLSearchParams(calls[0]!.body)
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(params.get('assertion')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)

    expect(minted.accessToken).toBe('ya29.minted')
    expect(minted.expiresAtMs).toBe(nowMs + 3600 * 1000)
  })

  it('throws secret-free when the endpoint rejects the key or returns no token', async () => {
    const reject = (async () => ({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({}) }) as Response) as unknown as typeof fetch
    await expect(mintGcpAccessToken(testKey(), 'scope', { fetchImpl: reject })).rejects.toThrow(/gcp token mint failed: 400/)

    const noToken = (async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({}) }) as Response) as unknown as typeof fetch
    await expect(mintGcpAccessToken(testKey(), 'scope', { fetchImpl: noToken })).rejects.toThrow(/no access_token/)
  })
})

describe('createGcpTokenSource — cache + refresh on expiry (the staleness fix)', () => {
  it('mints once, reuses within lifetime, and re-mints only after the token nears expiry', async () => {
    let n = 0
    // Each mint returns a distinct token so a re-mint is observable.
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ access_token: `ya29.tok${++n}`, token_type: 'Bearer', expires_in: 3600 }),
    }) as Response) as unknown as typeof fetch

    let clock = 1_000_000_000_000
    const source = createGcpTokenSource(testKey(), 'scope', {
      fetchImpl,
      now: () => clock,
      refreshSkewMs: 60_000,
    })

    // First call mints.
    expect(await source()).toEqual({ projectId: 'neat-demo', accessToken: 'ya29.tok1' })
    expect(n).toBe(1)

    // 30 min later — well inside the 1h lifetime — no re-mint.
    clock += 30 * 60_000
    expect(await source()).toEqual({ projectId: 'neat-demo', accessToken: 'ya29.tok1' })
    expect(n).toBe(1)

    // Past (expiry - skew): the ~1h token expired at +3600s; jump to +3600s.
    clock += 30 * 60_000
    expect(await source()).toEqual({ projectId: 'neat-demo', accessToken: 'ya29.tok2' })
    expect(n).toBe(2)
  })

  it('shares one in-flight mint across a burst of concurrent calls', async () => {
    let mints = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetchImpl = (async () => {
      mints++
      await gate
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ access_token: 'ya29.one', expires_in: 3600 }) } as Response
    }) as unknown as typeof fetch

    const source = createGcpTokenSource(testKey(), 'scope', { fetchImpl, now: () => 1 })
    const a = source()
    const b = source()
    const c = source()
    release()
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(mints).toBe(1)
    expect(ra).toEqual(rb)
    expect(rb).toEqual(rc)
    expect(ra).toEqual({ projectId: 'neat-demo', accessToken: 'ya29.one' })
  })
})

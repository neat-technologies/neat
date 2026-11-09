import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { ErrorEvent } from '@neat.is/types'
import { redactSecretValues, scrubIncidentEvent } from '../src/credential-scrub.js'
import { LEDGER_SCRUB_VERSION, ledgerScrubMarkerPath, scrubLedgerAtRest } from '../src/ledger-scrub.js'
import { appendRuntimeIncident } from '../src/durable-incident.js'
import { readErrorEvents } from '../src/ingest.js'

// Credentials inside values (messages, stack traces, log tails, URLs), and the
// one-time rewrite that removes them, and header credentials, from a ledger
// written before the scrub existed.

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})
async function ledger(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-ledger-scrub-'))
  dirs.push(d)
  return path.join(d, 'errors.ndjson')
}

const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlMTIz'

describe('redactSecretValues', () => {
  const cases: Array<[string, string, string]> = [
    ['query token', 'GET https://api.example.com/v1/x?token=abc123secret&page=2', 'secret'],
    ['presigned S3 url', 'https://b.s3.amazonaws.com/k?X-Amz-Signature=deadbeef99&X-Amz-Credential=AKIDsecret', 'deadbeef99'],
    ['google api key in query', 'https://maps.googleapis.com/?key=AIzaSyA-not-really-a-key-1234567890abc', 'AIzaSy'],
    ['bearer in message', 'upstream said 401 for Authorization: Bearer abcd1234efgh5678', 'abcd1234efgh5678'],
    ['url userinfo', 'connect ECONNREFUSED postgres://app:hunter2pass@db:5432/app', 'hunter2pass'],
    ['github token', `push failed with ${GH}`, GH],
    ['jwt', `invalid session ${JWT}`, JWT],
    ['aws access key', 'AccessDenied for AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
    ['env assignment in a build log', 'Running with NPM_TOKEN=npm-value-xyz and CI=true', 'npm-value-xyz'],
    ['json field', '{"user":"a","password":"p@ss\\"word"}', 'p@ss'],
    ['pem block', 'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\nnext', 'MIIEow'],
  ]
  for (const [name, input, secret] of cases) {
    it(`redacts ${name}`, () => {
      const out = redactSecretValues(input)
      expect(out).not.toContain(secret)
      expect(out).toContain('[REDACTED]')
      // Idempotent: the at-rest rewrite relies on a clean record staying identical.
      expect(redactSecretValues(out)).toBe(out)
    })
  }

  it('keeps what the record needs to say what failed', () => {
    expect(redactSecretValues('GET /x?token=abc123&page=2')).toBe('GET /x?token=[REDACTED]&page=2')
    expect(redactSecretValues('NPM_TOKEN=abc')).toBe('NPM_TOKEN=[REDACTED]')
    expect(redactSecretValues('postgres://app:pw@db/app')).toBe('postgres://app:[REDACTED]@db/app')
  })

  it('leaves ordinary error text alone', () => {
    for (const text of [
      'Basic authentication failed for user admin',
      'Bearer token missing',
      'INVALID_TOKEN: jwt expired',
      'TypeError: Cannot read properties of undefined (reading \'token\')',
      '500 on GET /users/:id',
      'const token = getToken()',
      'https://example.com/search?q=hello&page=2',
    ]) {
      expect(redactSecretValues(text)).toBe(text)
    }
  })
})

describe('scrubIncidentEvent redacts values', () => {
  const base: ErrorEvent = {
    id: 'i', timestamp: '2026-11-05T00:00:00.000Z', service: 'app', traceId: 't', spanId: 's',
    errorMessage: 'boom', affectedNode: 'service:app',
  }

  it('in the message, stack trace, eas.logs, and url attributes', () => {
    const ev: ErrorEvent = {
      ...base,
      errorMessage: 'fetch https://x.io/a?access_token=tok999 failed',
      exceptionStacktrace: `Error: ${GH}\n    at main (index.js:1:1)`,
      attributes: {
        'eas.logs': 'Installing...\nNPM_TOKEN=npm-secret-1 npm ci\nfailed',
        'url.full': 'https://x.io/a?access_token=tok999',
        'eas.buildPhase': 'INSTALL_DEPENDENCIES',
        'http.response.status_code': 500,
      },
    }
    const text = JSON.stringify(scrubIncidentEvent(ev))
    for (const s of ['tok999', GH, 'npm-secret-1']) expect(text).not.toContain(s)
    const out = scrubIncidentEvent(ev)
    expect(out.attributes?.['eas.buildPhase']).toBe('INSTALL_DEPENDENCIES')
    expect(out.attributes?.['http.response.status_code']).toBe(500)
    expect(out.exceptionStacktrace).toContain('at main (index.js:1:1)')
  })

  it('returns the same record when there is nothing to change', () => {
    const ev = { ...base, attributes: { 'code.filepath': 'src/a.ts' } }
    expect(scrubIncidentEvent(ev)).toBe(ev)
  })

  it('the write path stores the redacted value', async () => {
    const p = await ledger()
    await appendRuntimeIncident(p, 'p', { ...base, errorMessage: 'GET /a?token=tok999' }, { token: undefined })
    expect(await fs.readFile(p, 'utf8')).not.toContain('tok999')
  })
})

describe('scrubLedgerAtRest', () => {
  const leaky = (id: string): ErrorEvent => ({
    id, timestamp: '2026-01-01T00:00:00.000Z', service: 'app', traceId: 't', spanId: 's',
    errorMessage: `GET /a?token=tok-${id}`,
    attributes: { 'http.request.header.authorization': `Bearer hdr-${id}9`, 'code.filepath': 'src/a.ts' },
    affectedNode: 'service:app',
  })
  const extraction = { producer: 'services', file: 'package.json', error: 'Unexpected token', source: 'extract' }
  const clean: ErrorEvent = {
    id: 'clean', timestamp: '2026-01-01T00:00:00.000Z', service: 'app', traceId: 't', spanId: 's',
    errorMessage: 'boom', affectedNode: 'service:app',
  }

  it('rewrites an old ledger in place, leaving other records byte-for-byte', async () => {
    const p = await ledger()
    const cleanLine = JSON.stringify(clean)
    const extractionLine = JSON.stringify(extraction)
    await fs.writeFile(
      p,
      [JSON.stringify(leaky('a')), extractionLine, cleanLine, 'not json {', JSON.stringify(leaky('b'))].join('\n') + '\n',
      { mode: 0o600 },
    )
    const result = await scrubLedgerAtRest(p)
    expect(result).toEqual({ status: 'rewritten', records: 3, scrubbed: 2 })

    const text = await fs.readFile(p, 'utf8')
    for (const s of ['tok-a', 'tok-b', 'hdr-a', 'hdr-b']) expect(text).not.toContain(s)
    const lines = text.split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[1]).toBe(extractionLine)
    expect(lines[2]).toBe(cleanLine)
    expect(lines[3]).toBe('not json {')
    expect(lines[5]).toBe('')
    expect(JSON.parse(lines[0]).attributes).toEqual({ 'code.filepath': 'src/a.ts' })
    expect((await fs.stat(p)).mode & 0o777).toBe(0o600)

    const marker = JSON.parse(await fs.readFile(ledgerScrubMarkerPath(p), 'utf8'))
    expect(marker.version).toBe(LEDGER_SCRUB_VERSION)
    const leftovers = (await fs.readdir(path.dirname(p))).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('runs once per scrub version', async () => {
    const p = await ledger()
    await fs.writeFile(p, JSON.stringify(leaky('a')) + '\n')
    expect((await scrubLedgerAtRest(p)).status).toBe('rewritten')
    // A record that somehow arrives raw after the marker is still scrubbed on read,
    // but the ledger is not rewritten again until the version moves.
    await fs.appendFile(p, JSON.stringify(leaky('c')) + '\n')
    expect(await scrubLedgerAtRest(p)).toEqual({ status: 'current' })
    expect(JSON.stringify(await readErrorEvents(p))).not.toContain('tok-c')
  })

  it('leaves a clean ledger untouched and marks it', async () => {
    const p = await ledger()
    const body = JSON.stringify(clean) + '\n' + JSON.stringify(extraction)
    await fs.writeFile(p, body)
    const { mtimeMs } = await fs.stat(p)
    expect(await scrubLedgerAtRest(p)).toEqual({ status: 'clean', records: 1 })
    expect(await fs.readFile(p, 'utf8')).toBe(body)
    expect((await fs.stat(p)).mtimeMs).toBe(mtimeMs)
    expect(await scrubLedgerAtRest(p)).toEqual({ status: 'current' })
  })

  it('keeps a missing final newline missing', async () => {
    const p = await ledger()
    await fs.writeFile(p, JSON.stringify(clean) + '\n' + JSON.stringify(leaky('a')))
    await scrubLedgerAtRest(p)
    const text = await fs.readFile(p, 'utf8')
    expect(text.endsWith('\n')).toBe(false)
    expect(text.split('\n')).toHaveLength(2)
  })

  it('marks a project with no ledger yet', async () => {
    const p = await ledger()
    expect(await scrubLedgerAtRest(p)).toEqual({ status: 'clean', records: 0 })
    expect(await scrubLedgerAtRest(p)).toEqual({ status: 'current' })
  })
})

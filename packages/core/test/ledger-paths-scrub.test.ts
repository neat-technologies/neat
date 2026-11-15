import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse as parseYaml } from 'yaml'
import {
  drainDroppedExtracted,
  drainExtractionErrors,
  recordExtractionError,
  writeExtractionErrors,
  writeRejectedExtracted,
} from '../src/extract/errors.js'
import { applyExtension } from '../src/extend/index.js'
import { scrubLedgerAtRest } from '../src/ledger-scrub.js'

// The ledgers besides incidents whose rows can carry text from outside NEAT
// (#1184 follow-up). Each test writes a known secret-shaped value through the
// real write path, reads the file back, and checks the value is gone while the
// row still says what failed.

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-ledger-paths-'))
  dirs.push(d)
  return d
}

// Built by concatenation so no credential-shaped literal sits in the source.
const DB_PASS = 'pg-' + 'Fake9Pass' + 'word77'
const NPM_AUTH = 'npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const REG_PASS = 'reg-' + 'Fake5secret'

describe('extraction errors (errors.ndjson, source: extract)', () => {
  it('a YAML parse error that quotes a compose PASSWORD line is stored redacted', async () => {
    const compose = `services:\n  db:\n    environment:\n      POSTGRES_PASSWORD=${DB_PASS}: [\n`
    let err: unknown
    try {
      parseYaml(compose)
    } catch (e) {
      err = e
    }
    // The leak is real: the parser quotes the offending source line.
    expect(String((err as Error).message)).toContain(DB_PASS)

    const p = path.join(await tmp(), 'errors.ndjson')
    drainExtractionErrors()
    recordExtractionError('aliases compose', 'docker-compose.yml', err)
    await writeExtractionErrors(drainExtractionErrors(), p)

    const text = await fs.readFile(p, 'utf8')
    expect(text).not.toContain(DB_PASS)
    const row = JSON.parse(text)
    expect(row).toMatchObject({ producer: 'aliases compose', file: 'docker-compose.yml', source: 'extract' })
    expect(row.error).toContain('POSTGRES_PASSWORD=[REDACTED]')
  })

  it('a JSON.parse error quotes only a short window of the source, never a whole token', async () => {
    // V8 quotes about ten characters either side of the failing position, so a
    // malformed JSON config can put a fragment of a value on disk, but not a whole
    // credential. The YAML case above is the one that quotes the full line.
    let err: unknown
    try {
      JSON.parse(`{"token": "${NPM_AUTH}" oops}`)
    } catch (e) {
      err = e
    }
    expect(String((err as Error).message)).toMatch(/is not valid JSON|in JSON at position/)
    expect(String((err as Error).message)).not.toContain(NPM_AUTH)

    const p = path.join(await tmp(), 'errors.ndjson')
    drainExtractionErrors()
    recordExtractionError('services', 'package.json', err)
    await writeExtractionErrors(drainExtractionErrors(), p)
    expect(await fs.readFile(p, 'utf8')).not.toContain(NPM_AUTH)
  })
})

describe('rejected extracted edges (rejected.ndjson)', () => {
  it('an evidence snippet holding a connection string is stored redacted', async () => {
    const p = path.join(await tmp(), 'rejected.ndjson')
    drainDroppedExtracted()
    await writeRejectedExtracted(
      [
        {
          source: 'service:api',
          target: 'database:postgres:db',
          type: 'CONNECTS_TO',
          confidence: 0.3,
          confidenceKind: 'heuristic',
          evidence: { file: 'src/db.ts', line: 4, snippet: `const url = 'postgres://app:${DB_PASS}@db:5432/app'` },
        },
      ],
      p,
    )
    const text = await fs.readFile(p, 'utf8')
    expect(text).not.toContain(DB_PASS)
    expect(JSON.parse(text).evidence.snippet).toContain('postgres://app:[REDACTED]@db:5432/app')
  })
})

describe('extend log (extend-log.ndjson)', () => {
  it("a failed install's npm stderr with _authToken and registry userinfo is stored redacted", async () => {
    const dir = await tmp()
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { '@prisma/client': '^6.1.0' } }),
    )
    await fs.writeFile(
      path.join(dir, 'otel-init.js'),
      ["const { NodeSDK } = require('@opentelemetry/sdk-node')", 'const instrumentations = []', '__INSTRUMENTATION_BLOCK__', 'new NodeSDK({ instrumentations })'].join('\n'),
    )
    const logPath = path.join(dir, 'extend-log.ndjson')
    const stderr = [
      'npm error code E401',
      `npm error 401 Unauthorized - GET https://ci:${REG_PASS}@registry.example.com/@prisma%2finstrumentation`,
      `npm error //registry.npmjs.org/:_authToken=${NPM_AUTH}`,
    ].join('\n')
    process.env.NEAT_EXTEND_LOG = logPath
    try {
      await applyExtension(
        { project: 'p', scanPath: dir },
        {
          library: '@prisma/client',
          instrumentation_package: '@prisma/instrumentation',
          version: '^6.0.0',
          registration_snippet: "instrumentations.push(new (require('@prisma/instrumentation').PrismaInstrumentation)())",
        },
        { runInstall: async (cmd) => ({ pm: cmd.pm as 'npm', cwd: cmd.cwd, args: cmd.args, exitCode: 1 as const, stderr }) },
      )
    } finally {
      delete process.env.NEAT_EXTEND_LOG
    }
    const text = await fs.readFile(logPath, 'utf8')
    expect(text).not.toContain(NPM_AUTH)
    expect(text).not.toContain(REG_PASS)
    const row = JSON.parse(text)
    expect(row.installOutput).toContain('npm error 401 Unauthorized')
    expect(row.installOutput).toContain('_authToken=[REDACTED]')
  })
})

describe('at-rest rewrite of rows that are not incidents (LEDGER_SCRUB_VERSION 2)', () => {
  it('rewrites an extraction error written before the scrub, keeping clean rows byte-for-byte', async () => {
    const p = path.join(await tmp(), 'errors.ndjson')
    const leaky = JSON.stringify({ producer: 'aliases compose', file: 'docker-compose.yml', error: `bad line POSTGRES_PASSWORD=${DB_PASS}`, ts: 't', source: 'extract' })
    const clean = JSON.stringify({ producer: 'services', file: 'package.json', error: 'Unexpected token', ts: 't', source: 'extract' })
    await fs.writeFile(p, `${leaky}\n${clean}\n`)

    expect(await scrubLedgerAtRest(p)).toEqual({ status: 'rewritten', records: 2, scrubbed: 1 })
    const lines = (await fs.readFile(p, 'utf8')).split('\n')
    expect(lines[0]).not.toContain(DB_PASS)
    expect(JSON.parse(lines[0]!).error).toBe('bad line POSTGRES_PASSWORD=[REDACTED]')
    expect(lines[1]).toBe(clean)
  })
})

import { describe, it, expect } from 'vitest'
import {
  buildProcessContext,
  capProcessLog,
  describeEnvVar,
  isSecretKey,
  maskCredentialUrls,
  redactArg,
  redactValue,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_LOG_LINES,
} from '../src/connectors/kubernetes/process-context.js'
import type { Container } from '../src/connectors/kubernetes/types.js'

// ADR-237 — the process-&-config fusion redactor + builder, unit-tested in
// isolation. This is the one carve-out from "never write .env contents"
// (contracts.md Rule 13): it records REDACTED env as live OBSERVED runtime state
// on the incident ledger, so the redaction rules and the byte caps are the whole
// safety property and are pinned here directly, with no cluster in the loop.

const REDACTED = '***REDACTED***'

describe('process-context redactor — by key', () => {
  it('flags the four secret-key stems case-insensitively', () => {
    for (const name of ['DB_PASSWORD', 'API_TOKEN', 'STRIPE_SECRET_KEY', 'jwt_signing_key', 'password']) {
      expect(isSecretKey(name)).toBe(true)
    }
    for (const name of ['FEATURE_FLAG_ENDPOINT', 'PORT', 'SERVICE_URL', 'LOG_LEVEL']) {
      expect(isSecretKey(name)).toBe(false)
    }
  })

  it('masks a secret-keyed value whole and keeps a non-secret value', () => {
    expect(redactValue('DB_PASSWORD', 's3cr3t-pg-pw')).toBe(REDACTED)
    expect(redactValue('API_TOKEN', 'tok-abc-123')).toBe(REDACTED)
    expect(redactValue('FEATURE_FLAG_ENDPOINT', 'http://feature-flag:8081')).toBe('http://feature-flag:8081')
  })
})

describe('process-context redactor — by value shape (credential URLs)', () => {
  it('masks the inline password in a connection string even under a non-secret key', () => {
    expect(redactValue('DATABASE_URL', 'postgres://app:hunter2@db:5432/recs')).toBe(
      `postgres://app:${REDACTED}@db:5432/recs`,
    )
    // scheme + host + path survive — only the password is masked.
    expect(redactValue('DATABASE_URL', 'postgres://app:hunter2@db:5432/recs')).toContain('db:5432/recs')
  })

  it('masks a credential URL anywhere in a string, every occurrence', () => {
    const v = 'primary=redis://u:p1@a secondary=amqp://u:p2@b'
    const out = maskCredentialUrls(v)
    expect(out).toBe(`primary=redis://u:${REDACTED}@a secondary=amqp://u:${REDACTED}@b`)
    expect(out).not.toContain('p1')
    expect(out).not.toContain('p2')
  })

  it('leaves a URL with no inline credentials untouched', () => {
    expect(maskCredentialUrls('https://api.example.com/v1')).toBe('https://api.example.com/v1')
  })
})

describe('process-context redactor — args', () => {
  it('redacts a secret-keyed KEY=value / --flag=value arg, keeps a non-secret one', () => {
    expect(redactArg('DB_PASSWORD=s3cr3t')).toBe(`DB_PASSWORD=${REDACTED}`)
    expect(redactArg('--api-token=tok-abc')).toBe(`--api-token=${REDACTED}`)
    expect(redactArg('--port=8080')).toBe('--port=8080')
    expect(redactArg('-m')).toBe('-m')
  })

  it('masks a credential URL embedded in a positional arg', () => {
    expect(redactArg('postgres://app:hunter2@db/recs')).toBe(`postgres://app:${REDACTED}@db/recs`)
  })
})

describe('process-context builder — valueFrom descriptors (never resolved)', () => {
  it('captures a configMapKeyRef as a reference descriptor with its key', () => {
    expect(describeEnvVar({ name: 'CONFIG_PATH', valueFrom: { configMapKeyRef: { name: 'app-config', key: 'config.yaml' } } })).toBe(
      'CONFIG_PATH=<from configMap app-config key config.yaml>',
    )
  })

  it('captures a secretKeyRef as a reference descriptor WITHOUT its key', () => {
    // The secret's value is never read; the descriptor drops the key so even the
    // key name can't hint at the secret.
    const d = describeEnvVar({ name: 'STRIPE_SECRET', valueFrom: { secretKeyRef: { name: 'stripe-creds', key: 'secret-key' } } })
    expect(d).toBe('STRIPE_SECRET=<from secret stripe-creds>')
    expect(d).not.toContain('secret-key')
  })

  it('captures a downward-API fieldRef descriptor', () => {
    expect(describeEnvVar({ name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } })).toBe(
      'POD_IP=<from field status.podIP>',
    )
  })

  it('redacts a literal value by key through the descriptor path', () => {
    expect(describeEnvVar({ name: 'DB_PASSWORD', value: 's3cr3t' })).toBe(`DB_PASSWORD=${REDACTED}`)
    expect(describeEnvVar({ name: 'FEATURE_FLAG_ENDPOINT', value: 'http://ff:8081' })).toBe('FEATURE_FLAG_ENDPOINT=http://ff:8081')
  })
})

describe('process-context builder — byte / entry caps', () => {
  it('keeps the TAIL of a process log, line-bounded', () => {
    const lines = Array.from({ length: DEFAULT_MAX_LOG_LINES + 20 }, (_, i) => `line-${i}`)
    const out = capProcessLog(lines.join('\n'))
    const outLines = out.split('\n')
    expect(outLines.length).toBe(DEFAULT_MAX_LOG_LINES)
    // The traceback sits at the end, so the last line must survive.
    expect(outLines[outLines.length - 1]).toBe(`line-${DEFAULT_MAX_LOG_LINES + 19}`)
    // ...and the earliest lines are dropped.
    expect(out).not.toContain('line-0\n')
  })

  it('byte-caps a single enormous log line to the tail', () => {
    const out = capProcessLog('x'.repeat(10_000))
    expect(out.length).toBeLessThanOrEqual(2 * 1024)
    expect(out.endsWith('x')).toBe(true)
  })

  it('empty / whitespace-only log yields no processLog', () => {
    expect(capProcessLog('')).toBe('')
    expect(capProcessLog('   \n\n  ')).toBe('')
    expect(buildProcessContext({ log: '   \n' }).processLog).toBeUndefined()
  })

  it('caps the env list to DEFAULT_MAX_ENTRIES', () => {
    const env = Array.from({ length: DEFAULT_MAX_ENTRIES + 25 }, (_, i) => ({ name: `VAR_${i}`, value: String(i) }))
    const ctx = buildProcessContext({ container: { name: 'c', env } as Container })
    expect(ctx.containerEnv!.length).toBe(DEFAULT_MAX_ENTRIES)
  })

  it('caps the args list and redacts across command + args', () => {
    const container: Container = {
      name: 'recommendation',
      command: ['python'],
      args: ['-m', 'svc', '--db=postgres://u:pw@h/db', '--api-token=abc'],
    }
    const ctx = buildProcessContext({ container })
    expect(ctx.containerArgs).toEqual([
      'python',
      '-m',
      'svc',
      `--db=postgres://u:${REDACTED}@h/db`,
      `--api-token=${REDACTED}`,
    ])
  })
})

describe('process-context builder — composition', () => {
  it('omits fields that have no input (log-only, container-only, empty)', () => {
    expect(buildProcessContext({ log: 'boom\nTraceback' })).toEqual({ processLog: 'boom\nTraceback' })
    const containerOnly = buildProcessContext({ container: { name: 'c', env: [{ name: 'PORT', value: '8080' }] } })
    expect(containerOnly.processLog).toBeUndefined()
    expect(containerOnly.containerEnv).toEqual(['PORT=8080'])
    expect(buildProcessContext({})).toEqual({})
  })

  it('a secret value never appears anywhere in the built block', () => {
    const container: Container = {
      name: 'recommendation',
      args: ['--token=SUPERSECRET'],
      env: [
        { name: 'DB_PASSWORD', value: 'pg-pw-xyz' },
        { name: 'DATABASE_URL', value: 'postgres://app:hunter2@db/recs' },
      ],
    }
    const ctx = buildProcessContext({ log: 'connecting to postgres://app:hunter2@db/recs', container })
    const serialized = JSON.stringify(ctx)
    expect(serialized).not.toContain('SUPERSECRET')
    expect(serialized).not.toContain('pg-pw-xyz')
    expect(serialized).not.toContain('hunter2')
  })
})

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { spawn, execSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { applyNeatEnv, endpointFromDaemonRecord } from '../src/env.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

beforeAll(() => {
  if (!existsSync(path.join(PKG_ROOT, 'dist', 'index.cjs'))) {
    execSync('npm run build', { cwd: PKG_ROOT, stdio: 'ignore' })
  }
}, 60000)

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function projectWithRecord(record: Record<string, unknown>): { root: string; nested: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'neat-otel-env-'))
  dirs.push(root)
  mkdirSync(path.join(root, 'neat-out'))
  writeFileSync(path.join(root, 'neat-out', 'daemon.json'), JSON.stringify(record))
  const nested = path.join(root, 'packages', 'api')
  mkdirSync(nested, { recursive: true })
  return { root, nested }
}

describe('endpointFromDaemonRecord', () => {
  it("reads the project daemon's OTLP port and project from the nearest record", () => {
    const { nested } = projectWithRecord({ project: 'shop', ports: { otlp: 4320 } })
    expect(endpointFromDaemonRecord(nested)).toBe('http://localhost:4320/projects/shop/v1/traces')
  })

  it('returns nothing when no record is found', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'neat-otel-norec-'))
    dirs.push(dir)
    expect(endpointFromDaemonRecord(dir)).toBeUndefined()
  })
})

describe('applyNeatEnv', () => {
  it('resolves the endpoint from the record and sets protocol and auth like the generated init', () => {
    const { nested } = projectWithRecord({ project: 'shop', ports: { otlp: 4321 } })
    const env: Record<string, string | undefined> = { NEAT_OTEL_TOKEN: 'secret' }
    applyNeatEnv(env, nested)
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('http://localhost:4321/projects/shop/v1/traces')
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/json')
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=Bearer secret')
  })

  it('leaves an explicit endpoint, protocol and headers alone', () => {
    const { nested } = projectWithRecord({ project: 'shop', ports: { otlp: 4321 } })
    const env: Record<string, string | undefined> = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=1',
      NEAT_OTEL_TOKEN: 'secret',
    }
    applyNeatEnv(env, nested)
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined()
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf')
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe('x-api-key=1')
  })

  it("falls back to the canonical route for the project .env.neat names", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'neat-otel-fallback-'))
    dirs.push(dir)
    const env: Record<string, string | undefined> = { NEAT_PROJECT: 'shop' }
    applyNeatEnv(env, dir)
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('http://localhost:4318/projects/shop/v1/traces')
  })
})

describe('attached app exports to its own project daemon', () => {
  let sink: Server | undefined
  afterEach(() => new Promise<void>((r) => (sink ? sink.close(() => r()) : r())))

  it('sends spans to the port and project in daemon.json, not a fixed 4318', async () => {
    const hits: string[] = []
    sink = createServer((req, res) => {
      hits.push(req.url ?? '')
      req.resume()
      req.on('end', () => res.end('{}'))
    })
    await new Promise<void>((r) => sink!.listen(0, '127.0.0.1', () => r()))
    const port = (sink.address() as { port: number }).port
    const { root } = projectWithRecord({ project: 'second-project', ports: { otlp: port } })

    const child = spawn(
      process.execPath,
      ['--require', path.join(PKG_ROOT, 'register.cjs'), path.join(FIXTURES, 'app.cjs')],
      {
        cwd: root,
        env: {
          ...process.env,
          OTEL_SERVICE_NAME: 'second-api',
          OTEL_BSP_SCHEDULE_DELAY: '100',
          OTEL_EXPORTER_OTLP_ENDPOINT: '',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
          OTEL_TRACES_EXPORTER: '',
        },
        stdio: 'ignore',
      },
    )
    await new Promise((r) => child.on('exit', r))
    expect(hits).toContain('/projects/second-project/v1/traces')
  }, 30000)
})

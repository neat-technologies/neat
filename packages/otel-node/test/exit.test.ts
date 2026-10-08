import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { spawn, execSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// #1353 — a process that exits on its own must still export its spans, and a
// hung exporter must not hold it open past the bounded flush.

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

beforeAll(() => {
  if (!existsSync(path.join(PKG_ROOT, 'dist', 'index.cjs'))) {
    execSync('npm run build', { cwd: PKG_ROOT, stdio: 'ignore' })
  }
}, 60000)

const servers: Server[] = []
afterEach(async () => {
  while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()))
})

async function listen(handler: Parameters<typeof createServer>[0]): Promise<number> {
  const s = createServer(handler)
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return (s.address() as { port: number }).port
}

function runShort(
  otlpPort: number,
  targetPort: number,
  fixture = 'short.cjs',
): Promise<{ code: number | null; ms: number; out: string }> {
  const t0 = Date.now()
  const child = spawn(process.execPath, ['--require', path.join(PKG_ROOT, 'register.cjs'), path.join(FIXTURES, fixture)], {
    env: {
      ...process.env,
      FIXTURE_TARGET: `http://127.0.0.1:${targetPort}/x`,
      OTEL_SERVICE_NAME: 'short-script',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${otlpPort}/projects/p/v1/traces`,
      OTEL_TRACES_EXPORTER: '',
      // Far longer than the script lives, so only the exit flush can export.
      OTEL_BSP_SCHEDULE_DELAY: '60000',
      OTEL_EXPORTER_OTLP_TIMEOUT: '30000',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let out = ''
  child.stdout!.on('data', (d) => (out += String(d)))
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, ms: Date.now() - t0, out })))
}

describe('flush on exit (#1353)', () => {
  it('a script that exits on its own exports its spans', async () => {
    const hits: string[] = []
    const otlp = await listen((req, res) => {
      hits.push(req.url ?? '')
      req.resume()
      req.on('end', () => res.end('{}'))
    })
    const target = await listen((_req, res) => res.end('ok'))
    const { code } = await runShort(otlp, target)
    expect(code).toBe(0)
    expect(hits).toContain('/projects/p/v1/traces')
  }, 30000)

  it('a hung exporter does not hold the process open past the bounded flush', async () => {
    // Accepts the export and never answers.
    const otlp = await listen((req) => req.resume())
    const target = await listen((_req, res) => res.end('ok'))
    const { ms } = await runShort(otlp, target)
    expect(ms).toBeLessThan(8000)
  }, 30000)

  it("lets an app's own beforeExit cleanup finish", async () => {
    const otlp = await listen((req, res) => {
      req.resume()
      req.on('end', () => res.end('{}'))
    })
    const target = await listen((_req, res) => res.end('ok'))
    const { code, out } = await runShort(otlp, target, 'cleanup.cjs')
    expect(code).toBe(0)
    expect(out).toContain('app-cleanup-done')
  }, 30000)
})

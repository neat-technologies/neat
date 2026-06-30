import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'

// NEAT's `--apply` writes `.env.neat` and `otel-init.{ext}` into the user's
// tree (ADR-069). Extraction must skip both — ingesting them records NEAT's own
// instrumentation as if the user had declared it (self-pollution). This mirrors
// the existing `.env.template` exclusion in the static-extraction contract.

describe('self-pollution: NEAT-authored files are excluded from extraction', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-self-pollution-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('walkConfigFiles skips .env.neat but keeps a real .env', async () => {
    await fs.writeFile(path.join(dir, '.env'), 'DATABASE_URL=postgres://x\n')
    await fs.writeFile(path.join(dir, '.env.neat'), 'OTEL_SERVICE_NAME=app\n')

    const { walkConfigFiles } = await import('../src/extract/configs.js')
    const files = (await walkConfigFiles(dir)).map((p) => path.basename(p))

    expect(files).toContain('.env')
    expect(files).not.toContain('.env.neat')
  })

  it('walkSourceFiles skips the generated otel-init but keeps real source', async () => {
    await fs.writeFile(path.join(dir, 'index.js'), 'console.log("app")\n')
    await fs.writeFile(path.join(dir, 'otel-init.cjs'), 'require("@neat.is/otel")\n')
    await fs.writeFile(path.join(dir, 'otel-init.ts'), 'import "@neat.is/otel"\n')

    const { walkSourceFiles } = await import('../src/extract/calls/shared.js')
    const files = (await walkSourceFiles(dir)).map((p) => path.basename(p))

    expect(files).toContain('index.js')
    expect(files).not.toContain('otel-init.cjs')
    expect(files).not.toContain('otel-init.ts')
  })

  it('predicates classify NEAT-authored artifacts directly', async () => {
    const { isNeatAuthoredEnvFile, isNeatAuthoredSourceFile, isConfigFile } =
      await import('../src/extract/shared.js')

    expect(isNeatAuthoredEnvFile('.env.neat')).toBe(true)
    expect(isNeatAuthoredEnvFile('.env')).toBe(false)
    expect(isNeatAuthoredEnvFile('.env.local')).toBe(false)

    expect(isNeatAuthoredSourceFile('otel-init.cjs')).toBe(true)
    expect(isNeatAuthoredSourceFile('otel-init.mjs')).toBe(true)
    expect(isNeatAuthoredSourceFile('otel-init.js')).toBe(true)
    expect(isNeatAuthoredSourceFile('otel-init.ts')).toBe(true)
    expect(isNeatAuthoredSourceFile('index.js')).toBe(false)
    expect(isNeatAuthoredSourceFile('my-otel-init.js')).toBe(false)

    // isConfigFile delegates — .env.neat is not config, a real env file is.
    expect(isConfigFile('.env.neat').match).toBe(false)
    expect(isConfigFile('.env').match).toBe(true)
    expect(isConfigFile('.env.local').match).toBe(true)
  })
})

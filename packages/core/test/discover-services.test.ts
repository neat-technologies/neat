import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverServices } from '../src/extract/services.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures')

describe('discoverServices', () => {
  const originalScanDepth = process.env.NEAT_SCAN_DEPTH

  beforeEach(() => {
    delete process.env.NEAT_SCAN_DEPTH
  })

  afterEach(() => {
    if (originalScanDepth === undefined) delete process.env.NEAT_SCAN_DEPTH
    else process.env.NEAT_SCAN_DEPTH = originalScanDepth
    vi.restoreAllMocks()
  })

  it('walks the tree recursively and finds nested package.jsons', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'monorepo'))
    const names = services.map((s) => s.node.name).sort()
    expect(names).toEqual(['fixture-app-a', 'fixture-lib', 'fixture-service-b'])
  })

  it('records repoPath relative to scan path', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'monorepo'))
    const byName = new Map(services.map((s) => [s.node.name, s.node.repoPath]))
    expect(byName.get('fixture-app-a')).toBe(path.join('apps', 'a'))
    expect(byName.get('fixture-service-b')).toBe(path.join('services', 'b'))
    expect(byName.get('fixture-lib')).toBe(path.join('packages', 'lib'))
  })

  it('honours package.json#workspaces globs and ignores paths outside them', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'monorepo-workspaces'))
    const names = services.map((s) => s.node.name).sort()
    expect(names).toEqual(['fixture-ws-lib'])
  })

  it('warns on duplicate package names and keeps only the first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = await discoverServices(path.join(FIXTURES, 'monorepo-duplicates'))
    expect(services).toHaveLength(1)
    expect(services[0]!.node.name).toBe('fixture-dup')
    expect(warn).toHaveBeenCalledOnce()
    const message = warn.mock.calls[0]![0] as string
    expect(message).toContain('fixture-dup')
    expect(message).toContain(path.join('apps', 'a'))
    expect(message).toContain(path.join('services', 'a'))
  })

  it('skips directories matched by the root .gitignore', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'monorepo-gitignore'))
    const names = services.map((s) => s.node.name).sort()
    expect(names).toEqual(['fixture-included'])
  })

  it('respects NEAT_SCAN_DEPTH=0 (root only)', async () => {
    process.env.NEAT_SCAN_DEPTH = '0'
    const services = await discoverServices(path.join(FIXTURES, 'monorepo'))
    expect(services).toEqual([])
  })

  it('marks a service with a tsconfig.json as typescript', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'service-language'))
    const byName = new Map(services.map((s) => [s.node.name, s.node.language]))
    expect(byName.get('fixture-ts-tsconfig')).toBe('typescript')
  })

  it('marks a service depending on typescript as typescript', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'service-language'))
    const byName = new Map(services.map((s) => [s.node.name, s.node.language]))
    expect(byName.get('fixture-ts-dep')).toBe('typescript')
  })

  it('marks a plain JS service (no tsconfig, no typescript dep) as javascript', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'service-language'))
    const byName = new Map(services.map((s) => [s.node.name, s.node.language]))
    expect(byName.get('fixture-plain-js')).toBe('javascript')
  })

  describe('root manifest, no package.json', () => {
    let tmp: string

    afterEach(async () => {
      if (tmp) await fs.rm(tmp, { recursive: true, force: true })
    })

    it('discovers a Python project whose pyproject.toml sits at the root', async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-py-root-'))
      await fs.writeFile(
        path.join(tmp, 'pyproject.toml'),
        '[tool.poetry]\nname = "fixture-py-root"\nversion = "1.2.3"\n',
      )
      await fs.mkdir(path.join(tmp, 'app'))
      await fs.writeFile(path.join(tmp, 'app', 'main.py'), 'def handler():\n    return 1\n')

      const services = await discoverServices(tmp)
      expect(services).toHaveLength(1)
      expect(services[0]!.node.name).toBe('fixture-py-root')
      expect(services[0]!.node.language).toBe('python')
    })

    it('still discovers a JS project from its root package.json', async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-js-root-'))
      await fs.writeFile(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'fixture-js-root', version: '0.1.0' }),
      )

      const services = await discoverServices(tmp)
      expect(services).toHaveLength(1)
      expect(services[0]!.node.name).toBe('fixture-js-root')
      expect(services[0]!.node.language).toBe('javascript')
    })
  })
})

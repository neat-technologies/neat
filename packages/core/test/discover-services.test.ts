import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServiceNode, SymbolNode } from '@neat.is/types'
import { NodeType, serviceId, symbolId } from '@neat.is/types'
import { discoverServices } from '../src/extract/services.js'
import { extractFromDirectory } from '../src/extract.js'
import { getGraph, resetGraph } from '../src/graph.js'

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

// ADR-194 — a directory with a Dockerfile plus source but no language manifest is
// discovered as a service, language inferred from the primary top-level source.
// The `dockerfile-service` fixture holds the load-generator shape and three
// file-based negatives under one scan root; the ignored-dir negative is built in
// a tmp tree so it can use a real `node_modules` boundary.
describe('Dockerfile-declared service discovery (ADR-194)', () => {
  const ROOT = path.join(FIXTURES, 'dockerfile-service')
  let tmp: string | undefined

  beforeEach(() => {
    delete process.env.NEAT_SCAN_DEPTH
    tmp = undefined
  })

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  })

  it('mints exactly one JS ServiceNode for a Dockerfile + source dir with no manifest', async () => {
    const services = await discoverServices(ROOT)
    const lg = services.filter((s) => s.node.name === 'load-generator')
    expect(lg, 'exactly one load-generator service').toHaveLength(1)
    expect(lg[0]!.node.language).toBe('javascript')
    expect(lg[0]!.node.repoPath).toBe('load-generator')
    expect(lg[0]!.node.dependencies).toEqual({})
    expect(lg[0]!.node.id).toBe(serviceId('load-generator'))
  })

  it('mints nothing for a Dockerfile alone (no source)', async () => {
    const names = (await discoverServices(ROOT)).map((s) => s.node.name)
    expect(names).not.toContain('dockerfile-only')
  })

  it('mints nothing for source alone (no Dockerfile, no manifest)', async () => {
    const names = (await discoverServices(ROOT)).map((s) => s.node.name)
    expect(names).not.toContain('source-only')
  })

  it('lets the manifest win, without double-minting, when a dir has both', async () => {
    const services = await discoverServices(ROOT)
    // Discovered under its package.json name, never the basename `with-manifest`.
    expect(services.some((s) => s.node.name === 'with-manifest')).toBe(false)
    const wm = services.filter((s) => s.node.name === 'fixture-with-manifest')
    expect(wm, 'exactly one node for the manifest dir').toHaveLength(1)
    expect(wm[0]!.node.language).toBe('javascript')
    expect(wm[0]!.dir.endsWith(path.join('dockerfile-service', 'with-manifest'))).toBe(true)
  })

  it('discovers exactly the two real services under the scan root', async () => {
    const names = (await discoverServices(ROOT)).map((s) => s.node.name).sort()
    expect(names).toEqual(['fixture-with-manifest', 'load-generator'])
  })

  it('mints nothing inside an ignored (vendored) directory', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-docker-ignored-'))
    const svc = path.join(tmp, 'node_modules', 'vendored-svc')
    await fs.mkdir(svc, { recursive: true })
    await fs.writeFile(
      path.join(svc, 'Dockerfile'),
      'FROM node:20-alpine\nCMD ["node", "script.js"]\n',
    )
    await fs.writeFile(
      path.join(svc, 'script.js'),
      'function handler() {\n  return 1\n}\nmodule.exports = { handler }\n',
    )

    const services = await discoverServices(tmp)
    expect(services).toEqual([])
  })

  it('symbol-grains the discovered JS service — script.js becomes SymbolNodes', async () => {
    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, ROOT)

    // The service exists as a real static node.
    const svcId = serviceId('load-generator')
    expect(graph.hasNode(svcId)).toBe(true)
    expect((graph.getNodeAttributes(svcId) as ServiceNode).language).toBe('javascript')

    // And script.js grained into symbols (JS is a symbol grammar, ADR-158/192),
    // so the manifest-less service reaches symbol grain with no extra wiring.
    for (const qualname of ['setup', 'loadTest', 'placeOrder']) {
      const sid = symbolId('load-generator', 'script.js', qualname)
      expect(graph.hasNode(sid), `missing symbol ${qualname}`).toBe(true)
      expect((graph.getNodeAttributes(sid) as SymbolNode).type).toBe(NodeType.SymbolNode)
    }
  })
})

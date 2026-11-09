import { afterEach, describe, expect, it } from 'vitest'
import zlib from 'node:zlib'
import { Buffer } from 'node:buffer'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFixDiff } from '../src/advisories/release-fetch.js'
import { loadAdvisorySnapshot } from '../src/advisories/source.js'
import type { Advisory, AffectedPackage } from '../src/advisories/normalize.js'
import type { InventoryItem } from '../src/advisories/match.js'

// Release fetch + fix-diff population (ADR-274, advisory-cache.md §4). The
// registries are stood in for by a URL-routing fake fetch serving in-memory
// archives, so the test is deterministic and hits no network.

const MAX_UNPACKED = 64 * 1024 * 1024 // mirrors the module's decompression cap

// --- minimal archive writers (the reader ignores CRCs, so these round-trip) ---

function tarEntry(name: string, data: Buffer): Buffer {
  const h = Buffer.alloc(512)
  h.write(name.slice(0, 100), 0, 'utf8')
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(data.length.toString(8).padStart(11, '0') + ' ', 124)
  h.write('00000000000 ', 136)
  for (let i = 148; i < 156; i++) h[i] = 0x20 // checksum field spaces during calc
  h.write('0', 156) // regular file
  h.write('ustar\0', 257)
  h.write('00', 263)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += h[i]!
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  const pad = Math.ceil(data.length / 512) * 512 - data.length
  return Buffer.concat([h, data, Buffer.alloc(pad)])
}
function tar(files: Record<string, string>): Buffer {
  const parts = Object.entries(files).map(([n, c]) => tarEntry(n, Buffer.from(c, 'utf8')))
  return Buffer.concat([...parts, Buffer.alloc(1024)])
}
const tarGz = (files: Record<string, string>) => zlib.gzipSync(tar(files))

function zip(files: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const names = Object.keys(files)
  for (const name of names) {
    const raw = Buffer.isBuffer(files[name]) ? (files[name] as Buffer) : Buffer.from(files[name] as string, 'utf8')
    const comp = zlib.deflateRawSync(raw)
    const nameBuf = Buffer.from(name, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(8, 8) // method: deflate
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    locals.push(Buffer.concat([lh, nameBuf, comp]))
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(8, 10) // method: deflate
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([ch, nameBuf]))
    offset += locals[locals.length - 1]!.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(names.length, 8)
  eocd.writeUInt16LE(names.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

// --- advisory + registry fixtures -------------------------------------------

const advisory = (over: Partial<Advisory>): Advisory => ({
  id: 'GHSA-test',
  aliases: [],
  summary: '',
  details: '',
  severity: { label: 'high' },
  cwe: [],
  modified: '2026-01-01T00:00:00Z',
  affected: [],
  fixRefs: [],
  ...over,
})
const affected = (
  ecosystem: string,
  name: string,
  events: AffectedPackage['ranges'][number]['events'],
): AffectedPackage => ({ ecosystem, name, ranges: [{ type: ecosystem === 'PyPI' ? 'ECOSYSTEM' : 'SEMVER', events }] })

// A fake fetch that answers from an exact-URL table. Values are JSON (served as
// application/json), a Buffer (served as bytes), a string (served as text), or a
// status number (served as an error).
type Route = Buffer | string | number | Record<string, unknown> | unknown[]
function fakeFetch(routes: Record<string, Route>): typeof fetch {
  return (async (url: string) => {
    const r = routes[url]
    if (r === undefined) return new Response('not found', { status: 404 })
    if (typeof r === 'number') return new Response('err', { status: r })
    if (Buffer.isBuffer(r)) return new Response(r)
    if (typeof r === 'string') return new Response(r)
    return new Response(JSON.stringify(r))
  }) as typeof fetch
}

const packument = (name: string, versions: string[]): Record<string, unknown> => ({
  versions: Object.fromEntries(
    versions.map((v) => [v, { dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${v}.tgz` } }]),
  ),
})

describe('buildFixDiff: release fetch and fix-diff population', () => {
  it('npm: diffs the fix release, strips the package/ prefix', async () => {
    const adv = advisory({ affected: [affected('npm', 'widget', [{ introduced: '0' }, { fixed: '1.0.1' }])] })
    const fetchImpl = fakeFetch({
      'https://registry.npmjs.org/widget': packument('widget', ['1.0.0', '1.0.1']),
      'https://registry.npmjs.org/widget/-/widget-1.0.0.tgz': tarGz({ 'package/index.js': 'function run(x) { return x }' }),
      'https://registry.npmjs.org/widget/-/widget-1.0.1.tgz': tarGz({ 'package/index.js': 'function run(x) { return sanitize(x) }' }),
    })
    const diff = await buildFixDiff(adv, { ecosystem: 'npm', name: 'widget' }, { fetchImpl })
    expect(diff).toEqual({
      from: '1.0.0',
      to: '1.0.1',
      changed: [{ symbol: 'run', file: 'index.js', kind: 'function', status: 'modified', namedInAdvisory: false }],
    })
  })

  it('PyPI: prefers the wheel (already import-rooted), ignores dist-info', async () => {
    const adv = advisory({
      summary: 'handle is unsafe',
      affected: [affected('PyPI', 'acme', [{ introduced: '0' }, { fixed: '2.0.1' }])],
    })
    const whl = (body: string) =>
      zip({ 'acme/core.py': `def handle(r):\n    ${body}\n`, 'acme-2.0.0.dist-info/METADATA': 'Name: acme' })
    const fetchImpl = fakeFetch({
      'https://pypi.org/pypi/acme/json': {
        releases: {
          '2.0.0': [{ packagetype: 'bdist_wheel', filename: 'acme-2.0.0-py3-none-any.whl', url: 'https://files/acme-2.0.0.whl' }],
          '2.0.1': [{ packagetype: 'bdist_wheel', filename: 'acme-2.0.1-py3-none-any.whl', url: 'https://files/acme-2.0.1.whl' }],
        },
      },
      'https://files/acme-2.0.0.whl': zip({ 'acme/core.py': 'def handle(r):\n    return r\n', 'acme-2.0.0.dist-info/METADATA': 'Name: acme' }),
      'https://files/acme-2.0.1.whl': whl('return clean(r)'),
    })
    const diff = await buildFixDiff(adv, { ecosystem: 'PyPI', name: 'acme' }, { fetchImpl })
    expect(diff?.changed.map((c) => `${c.file}#${c.symbol}`)).toEqual(['acme/core.py#handle'])
    expect(diff?.changed[0]!.namedInAdvisory).toBe(true)
  })

  it('PyPI: falls back to the sdist and strips <name>-<version>/ and src/', async () => {
    const adv = advisory({ affected: [affected('PyPI', 'acme', [{ introduced: '0' }, { fixed: '3.0.1' }])] })
    const sdist = (ver: string, body: string) =>
      tarGz({ [`acme-${ver}/setup.py`]: 'setup()', [`acme-${ver}/src/acme/core.py`]: `def handle(r):\n    ${body}\n` })
    const fetchImpl = fakeFetch({
      'https://pypi.org/pypi/acme/json': {
        releases: {
          '3.0.0': [{ packagetype: 'sdist', filename: 'acme-3.0.0.tar.gz', url: 'https://files/acme-3.0.0.tar.gz' }],
          '3.0.1': [{ packagetype: 'sdist', filename: 'acme-3.0.1.tar.gz', url: 'https://files/acme-3.0.1.tar.gz' }],
        },
      },
      'https://files/acme-3.0.0.tar.gz': sdist('3.0.0', 'return r'),
      'https://files/acme-3.0.1.tar.gz': sdist('3.0.1', 'return clean(r)'),
    })
    const diff = await buildFixDiff(adv, { ecosystem: 'PyPI', name: 'acme' }, { fetchImpl })
    expect(diff?.from).toBe('3.0.0')
    expect(diff?.changed.map((c) => `${c.file}#${c.symbol}`)).toEqual(['acme/core.py#handle'])
  })

  it('Go: v-prefixes the fixed version, strips <module>@<version>/, escapes the proxy path', async () => {
    const adv = advisory({ affected: [affected('Go', 'github.com/Acme/widget', [{ introduced: '0' }, { fixed: '1.2.0' }])] })
    const mod = 'github.com/Acme/widget'
    const goZip = (ver: string, body: string) => zip({ [`${mod}@${ver}/w.go`]: `package w\nfunc Run(x int) int { ${body} }\n` })
    const fetchImpl = fakeFetch({
      // uppercase A in the module path escapes to !a for the proxy URL
      'https://proxy.golang.org/github.com/!acme/widget/@v/list': 'v1.1.0\nv1.2.0\n',
      'https://proxy.golang.org/github.com/!acme/widget/@v/v1.1.0.zip': goZip('v1.1.0', 'return x'),
      'https://proxy.golang.org/github.com/!acme/widget/@v/v1.2.0.zip': goZip('v1.2.0', 'return x + 1'),
    })
    const diff = await buildFixDiff(adv, { ecosystem: 'Go', name: 'github.com/Acme/widget' }, { fetchImpl })
    expect(diff?.from).toBe('v1.1.0')
    expect(diff?.to).toBe('v1.2.0')
    expect(diff?.changed.map((c) => `${c.file}#${c.symbol}`)).toEqual(['w.go#Run'])
  })

  it('diffs around the FIRST fixed version when a later range re-affects', async () => {
    const adv = advisory({
      affected: [affected('npm', 'widget', [{ introduced: '0' }, { fixed: '1.0.1' }, { introduced: '1.5.0' }, { fixed: '1.5.2' }])],
    })
    const fetchImpl = fakeFetch({
      'https://registry.npmjs.org/widget': packument('widget', ['1.0.0', '1.0.1', '1.5.0', '1.5.1', '1.5.2']),
      'https://registry.npmjs.org/widget/-/widget-1.0.0.tgz': tarGz({ 'package/i.js': 'function run(x) { return x }' }),
      'https://registry.npmjs.org/widget/-/widget-1.0.1.tgz': tarGz({ 'package/i.js': 'function run(x) { return fix(x) }' }),
    })
    const diff = await buildFixDiff(adv, { ecosystem: 'npm', name: 'widget' }, { fetchImpl })
    expect(diff?.to).toBe('1.0.1') // not 1.5.2
  })

  it('unions fix events across folded affected entries for one package', async () => {
    // Folding can leave the same package in two affected entries; the earliest
    // fix (here in the second entry) is the one to diff around.
    const adv = advisory({
      affected: [
        affected('npm', 'widget', [{ introduced: '2.0.0' }, { fixed: '2.4.0' }]),
        affected('npm', 'widget', [{ introduced: '0' }, { fixed: '1.0.1' }]),
      ],
    })
    const fetchImpl = fakeFetch({
      'https://registry.npmjs.org/widget': packument('widget', ['1.0.0', '1.0.1', '2.0.0', '2.4.0']),
      'https://registry.npmjs.org/widget/-/widget-1.0.0.tgz': tarGz({ 'package/i.js': 'function run(x) { return x }' }),
      'https://registry.npmjs.org/widget/-/widget-1.0.1.tgz': tarGz({ 'package/i.js': 'function run(x) { return fix(x) }' }),
    })
    const diff = await buildFixDiff(adv, { ecosystem: 'npm', name: 'widget' }, { fetchImpl })
    expect(diff?.to).toBe('1.0.1') // earliest across both entries, not 2.4.0
  })

  it('falls open to no fix-diff: no fixed version, a 404, and an unsupported ecosystem', async () => {
    const unfixed = advisory({ affected: [affected('npm', 'widget', [{ introduced: '0' }])] })
    const fetchImpl = fakeFetch({ 'https://registry.npmjs.org/widget': packument('widget', ['1.0.0']) })
    expect(await buildFixDiff(unfixed, { ecosystem: 'npm', name: 'widget' }, { fetchImpl })).toBeUndefined()

    const adv = advisory({ affected: [affected('npm', 'ghost', [{ introduced: '0' }, { fixed: '1.0.1' }])] })
    expect(await buildFixDiff(adv, { ecosystem: 'npm', name: 'ghost' }, { fetchImpl: fakeFetch({}) })).toBeUndefined()

    const rb = advisory({ affected: [affected('RubyGems', 'rack', [{ introduced: '0' }, { fixed: '2.0.1' }])] })
    expect(await buildFixDiff(rb, { ecosystem: 'RubyGems', name: 'rack' }, { fetchImpl })).toBeUndefined()
  })

  it('caps decompression: a gzip bomb raises past maxOutputLength and falls open', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(MAX_UNPACKED + 1)) // expands past the cap
    const adv = advisory({ affected: [affected('npm', 'widget', [{ introduced: '0' }, { fixed: '1.0.1' }])] })
    const fetchImpl = fakeFetch({
      'https://registry.npmjs.org/widget': packument('widget', ['1.0.0', '1.0.1']),
      'https://registry.npmjs.org/widget/-/widget-1.0.0.tgz': bomb,
      'https://registry.npmjs.org/widget/-/widget-1.0.1.tgz': bomb,
    })
    expect(await buildFixDiff(adv, { ecosystem: 'npm', name: 'widget' }, { fetchImpl })).toBeUndefined()
  })

  it('caps zip inflation: an oversized deflate entry raises and falls open', async () => {
    const whlBomb = zip({ 'acme/core.py': Buffer.alloc(MAX_UNPACKED + 1) })
    const adv = advisory({ affected: [affected('PyPI', 'acme', [{ introduced: '0' }, { fixed: '2.0.1' }])] })
    const fetchImpl = fakeFetch({
      'https://pypi.org/pypi/acme/json': {
        releases: {
          '2.0.0': [{ packagetype: 'bdist_wheel', filename: 'acme-2.0.0-py3-none-any.whl', url: 'https://files/a-2.0.0.whl' }],
          '2.0.1': [{ packagetype: 'bdist_wheel', filename: 'acme-2.0.1-py3-none-any.whl', url: 'https://files/a-2.0.1.whl' }],
        },
      },
      'https://files/a-2.0.0.whl': whlBomb,
      'https://files/a-2.0.1.whl': whlBomb,
    })
    expect(await buildFixDiff(adv, { ecosystem: 'PyPI', name: 'acme' }, { fetchImpl })).toBeUndefined()
  })
})

describe('loadAdvisorySnapshot populates and caches advisory.fixDiff', () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true })
  })
  const item = (ecosystem: string, name: string, version: string): InventoryItem => ({
    dependencyId: `dep:${ecosystem}:${name}@${version}`,
    ecosystem,
    name,
    version,
  })

  it('attaches the fix-diff to the snapshot advisory, then serves it from the cache', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-rf-'))
    dirs.push(home)
    const osvRecord = {
      id: 'GHSA-widget',
      modified: '2026-01-01T00:00:00Z',
      summary: 'XSS in widget',
      affected: [{ package: { ecosystem: 'npm', name: 'widget' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }] }],
    }
    let registryHits = 0
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/querybatch')) {
        const body = JSON.parse(String(init?.body)) as { queries: Array<{ package: { name: string } }> }
        return new Response(JSON.stringify({ results: body.queries.map((q) => ({ vulns: q.package.name === 'widget' ? [{ id: 'GHSA-widget' }] : [] })) }))
      }
      if (url.includes('/v1/vulns/')) return new Response(JSON.stringify(osvRecord))
      if (url === 'https://registry.npmjs.org/widget') {
        registryHits++
        return new Response(JSON.stringify(packument('widget', ['1.0.0', '1.0.1'])))
      }
      if (url.endsWith('widget-1.0.0.tgz')) return new Response(tarGz({ 'package/index.js': 'function run(x) { return x }' }))
      if (url.endsWith('widget-1.0.1.tgz')) return new Response(tarGz({ 'package/index.js': 'function run(x) { return sanitize(x) }' }))
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const inv = [item('npm', 'widget', '1.0.0')]
    const env = { NEAT_HOME: home }
    const now = () => Date.parse('2026-11-05T12:00:00Z')
    const first = await loadAdvisorySnapshot(inv, { fetchImpl, env, now })
    const adv = first.snapshot!.advisories.find((a) => a.id === 'GHSA-widget')!
    expect(adv.fixDiff?.changed.map((c) => c.symbol)).toEqual(['run'])
    expect(registryHits).toBe(1)

    // Within the TTL the second scan reads the cache: no new registry fetch, and
    // the fix-diff survives the JSON round-trip through the cache file.
    const second = await loadAdvisorySnapshot(inv, { fetchImpl, env, now })
    expect(registryHits).toBe(1)
    expect(second.snapshot!.advisories.find((a) => a.id === 'GHSA-widget')!.fixDiff?.changed[0]!.symbol).toBe('run')
  })
})

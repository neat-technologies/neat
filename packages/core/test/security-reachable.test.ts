import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import {
  SecurityCardSchema,
  dependencyId,
  dependencySymbolId,
  fileId,
  serviceId,
  symbolId,
  type GraphEdge,
  type GraphNode,
} from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { discoverServices } from '../src/extract/services.js'
import { extractDependencyCode } from '../src/extract/dependency-symbols/index.js'
import type { Advisory, AdvisorySnapshot } from '../src/advisories/index.js'
import type { FixDiff } from '../src/advisories/fixdiff.js'
import { buildSecurityCard } from '../src/security-card.js'
import { isReachable } from '../src/security-scan.js'

// security-card.md §2: `reachable-static` is an EXTRACTED CALLS path from the
// service's code, into the package's export, through its own calls, to a symbol
// the fix changed. Strict: the path ends exactly on a changed symbol.

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

const V = '1.0.0'
const DEP = dependencyId('npm', 'semverish', V)
const dsym = (file: string, q: string) => dependencySymbolId('npm', 'semverish', V, file, q)

// A small package shaped like semver: satisfies() builds a Range and calls a
// method on it; the Range constructor parses with a module function.
const pkgFiles: Record<string, unknown> = {
  'node_modules/semverish/package.json': { name: 'semverish', version: V, main: 'index.js' },
  'node_modules/semverish/index.js': "module.exports = { satisfies: require('./satisfies'), clean: require('./clean') }\n",
  'node_modules/semverish/satisfies.js': [
    "const Range = require('./range')",
    'function satisfies(v, r) {',
    '  const range = new Range(r)',
    '  return range.test(v)',
    '}',
    'module.exports = satisfies',
    '',
  ].join('\n'),
  'node_modules/semverish/range.js': [
    "const { parseComparator } = require('./parse')",
    'class Range {',
    '  constructor(r) { this.set = parseComparator(r) }',
    '  test(v) { return this.set === v }',
    '}',
    'module.exports = Range',
    '',
  ].join('\n'),
  'node_modules/semverish/parse.js': 'exports.parseComparator = function parseComparator(r) { return r }\n',
  'node_modules/semverish/clean.js': 'module.exports = function clean(v) { return v.trim() }\n',
}

async function setup(app: string): Promise<{ g: NeatGraph; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-reach-'))
  dirs.push(root)
  const files: Record<string, unknown> = {
    ...pkgFiles,
    'package.json': { name: 'shop', main: 'app.js', dependencies: { semverish: V } },
    'package-lock.json': {
      name: 'shop',
      lockfileVersion: 3,
      packages: { '': { name: 'shop', dependencies: { semverish: V } }, 'node_modules/semverish': { version: V } },
    },
    'app.js': app,
  }
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel)
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, typeof body === 'string' ? body : JSON.stringify(body))
  }
  const g = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
  await extractFromDirectory(g, root, { announce: false })
  await extractDependencyCode(g, await discoverServices(root), root, [DEP])
  return { g, root }
}

const APP = "const semver = require('semverish')\nfunction check(v) { return semver.satisfies(v, '^1') }\nmodule.exports = check\n"

function snapshot(fixDiff?: FixDiff): AdvisorySnapshot {
  const advisory: Advisory = {
    id: 'GHSA-test-0001',
    aliases: ['CVE-2099-0001'],
    summary: 'ReDoS in parseComparator',
    details: 'parseComparator backtracks on crafted input',
    severity: { label: 'high' },
    cwe: ['CWE-1333'],
    modified: '2099-01-01T00:00:00Z',
    affected: [{ ecosystem: 'npm', name: 'semverish', ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }] }],
    fixRefs: [],
    ...(fixDiff ? { fixDiff } : {}),
  } as Advisory
  return { asOf: '2099-01-02T00:00:00Z', advisories: [advisory] }
}
const match = { advisoryId: 'GHSA-test-0001', dependencyId: DEP, fixedIn: ['1.0.1'], asOf: '2099-01-02T00:00:00Z' }
const diff = (...changed: Array<[string, string, 'modified' | 'new' | 'removed']>): FixDiff => ({
  from: '1.0.0',
  to: '1.0.1',
  changed: changed.map(([file, symbol, status]) => ({ file, symbol, kind: 'function', status, namedInAdvisory: symbol === 'parseComparator' })),
})

describe('reachable-static (security-card.md §2)', () => {
  it('finds the path through the export, the constructor and the package calls to the changed symbol', async () => {
    const { g } = await setup(APP)
    const card = buildSecurityCard(g, match, snapshot(diff(['parse.js', 'exports.parseComparator', 'modified'])), serviceId('shop'))!
    expect(SecurityCardSchema.parse(card)).toEqual(card)
    expect(card.reachability.level).toBe('reachable-static')
    expect(card.reachability).toMatchObject({ grain: 'symbol', grainSource: 'fix-diff' })
    expect(card.reachability.path!.map((h) => [h.from, h.to])).toEqual([
      [symbolId('shop', 'app.js', 'check'), dsym('satisfies.js', 'satisfies')],
      [dsym('satisfies.js', 'satisfies'), dsym('range.js', 'Range')],
      [dsym('range.js', 'Range'), dsym('range.js', 'Range.constructor')],
      [dsym('range.js', 'Range.constructor'), dsym('parse.js', 'exports.parseComparator')],
    ])
    expect(card.reachability.path!.every((h) => h.provenance === 'EXTRACTED')).toBe(true)
    expect(card.reachability.changedInFix).toEqual([{ symbol: 'exports.parseComparator', file: 'parse.js', namedInAdvisory: false }])
    expect(card.reachability.limits).toEqual([])
    expect(card.headline).toContain('is reachable from shop: check (app.js) calls satisfies (satisfies.js), which reaches exports.parseComparator (parse.js), changed in the fix release')
  })

  it('stays imported when the only route is a method call on an object (strict)', async () => {
    const { g } = await setup(APP)
    // Range.test is called as range.test(): method dispatch on a value, not resolved
    const card = buildSecurityCard(g, match, snapshot(diff(['range.js', 'Range.test', 'modified'])), serviceId('shop'))!
    expect(card.reachability.level).toBe('imported')
    expect(card.reachability.path).toBeNull()
    expect(card.reachability.grainSource).toBe('fix-diff')
    expect(card.reachability.limits[0]).toContain('No call path from first-party code to code changed in the fix was found')
    expect(card.headline).toContain('but no call path to code changed in the fix was found')
  })

  it('ignores symbols new in the fix, and says when nothing changed maps onto the installed version', async () => {
    const { g } = await setup(APP)
    const card = buildSecurityCard(g, match, snapshot(diff(['parse.js', 'safeParse', 'new'], ['gone.js', 'old', 'modified'])), serviceId('shop'))!
    expect(card.reachability.level).toBe('imported')
    expect(card.reachability.limits[0]).toContain('None of the code the fix changed exists under the same file and name')
  })

  it('without a fix-diff, stays at imported and package grain', async () => {
    const { g } = await setup(APP)
    const card = buildSecurityCard(g, match, snapshot(), serviceId('shop'))!
    expect(card.reachability).toMatchObject({ level: 'imported', grain: 'package', grainSource: 'package', changedInFix: [], path: null })
    expect(card.reachability.limits[0]).toContain('has not been diffed')
  })

  it('a call at module level is a path from the file', async () => {
    const { g } = await setup("const { clean } = require('semverish')\nclean(' 1.0.0 ')\n")
    const card = buildSecurityCard(g, match, snapshot(diff(['clean.js', 'clean', 'modified'])), serviceId('shop'))!
    expect(card.reachability.level).toBe('reachable-static')
    expect(card.reachability.path!.map((h) => [h.from, h.to])).toEqual([[fileId('shop', 'app.js'), dsym('clean.js', 'clean')]])
  })

  it('is deterministic and leaves the graph untouched', async () => {
    const { g } = await setup(APP)
    const before = JSON.stringify(g.export())
    const snap = snapshot(diff(['parse.js', 'exports.parseComparator', 'modified']))
    const a = buildSecurityCard(g, match, snap, serviceId('shop'))
    expect(JSON.stringify(buildSecurityCard(g, match, snap, serviceId('shop')))).toBe(JSON.stringify(a))
    expect(JSON.stringify(g.export())).toBe(before)
  })
})

describe('is_reachable at symbol grain', () => {
  const offline = { env: { NEAT_ADVISORIES: 'off' } }
  it('returns the path to a named function, and false with a reason otherwise', async () => {
    const { g } = await setup(APP)
    const yes = await isReachable(g, { package: 'semverish', symbol: 'parseComparator' }, offline)
    expect(yes).toMatchObject({ grain: 'symbol', symbol: 'parseComparator', reachable: true })
    expect(yes.path!.at(-1)!.to).toBe(dsym('parse.js', 'exports.parseComparator'))

    const viaMethod = await isReachable(g, { package: 'semverish', symbol: 'test' }, offline)
    expect(viaMethod).toMatchObject({ grain: 'symbol', reachable: false })
    expect(viaMethod.limits![0]).toContain('No EXTRACTED call path')
  })

  it("says so when the package's code isn't in the graph", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-reach-'))
    dirs.push(root)
    for (const [rel, body] of Object.entries({
      'package.json': { name: 'shop', main: 'app.js', dependencies: { semverish: V } },
      'package-lock.json': { name: 'shop', lockfileVersion: 3, packages: { '': { name: 'shop' }, 'node_modules/semverish': { version: V } } },
      'app.js': APP,
    })) await fs.writeFile(path.join(root, rel), JSON.stringify(body))
    await fs.writeFile(path.join(root, 'app.js'), APP)
    const g = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
    await extractFromDirectory(g, root, { announce: false })
    const r = await isReachable(g, { package: 'semverish', symbol: 'parseComparator' }, offline)
    expect(r).toMatchObject({ grain: 'symbol', reachable: false })
    expect(r.limits![0]).toContain('is not in the graph')
  })
})

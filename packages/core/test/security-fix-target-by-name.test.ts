import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode, SecurityCard, SecurityScanResult, DependencyNode } from '@neat.is/types'
import { dependencySymbolId } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import { normalizeOsv, type OsvRecord } from '../src/advisories/index.js'
import type { FixDiff } from '../src/advisories/fixdiff.js'
import { runSecurityCommand } from '../src/security-cli.js'
import { baseSymbolName, changedTargets } from '../src/security/fix-diff-targets.js'

// The fix-diff is taken over the release pair around the fix (1.12.0 -> 1.12.1
// for underscore), and an installed 1.9.1 is laid out differently: its
// underscore.js is one IIFE assigning `_.template = function`, where the fix
// pair's rollup build declares `function template` twice (`template~0`). An
// advisory-named changed symbol with no exact node resolves by base name in
// the same file (security-card.md §2b, #1768).

const ADVISORY = 'GHSA-cf4h-3jhx-xvhq'
const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})
async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}
const noNetwork = (async (url: string) => {
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof fetch

const osv: OsvRecord = {
  id: ADVISORY,
  summary: 'Arbitrary Code Execution in underscore',
  details: 'The package `underscore` from 1.13.0-0 and before 1.13.0-2, from 1.3.2 and before 1.12.1 are vulnerable to Arbitrary Code Injection via the template function.',
  aliases: ['CVE-2021-23358'],
  modified: '2026-10-17T00:00:00Z',
  published: '2021-05-06T16:09:43Z',
  database_specific: { cwe_ids: ['CWE-94'], severity: 'CRITICAL' },
  affected: [
    {
      package: { name: 'underscore', ecosystem: 'npm', purl: 'pkg:npm/underscore' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '1.3.2' }, { fixed: '1.12.1' }] }],
    },
  ],
} as unknown as OsvRecord

// What the 1.12.0 -> 1.12.1 diff names, cut down: the bundled copy in
// underscore.js (`template~0`, the outer of two `function template`s), the
// modular copy, and a restructured helper the advisory doesn't name.
const fixDiff: FixDiff = {
  from: '1.12.0',
  to: '1.12.1',
  changed: [
    { file: 'modules/template.js', symbol: 'template', kind: 'function', status: 'modified', namedInAdvisory: true },
    { file: 'underscore.js', symbol: 'template~0', kind: 'function', status: 'modified', namedInAdvisory: true },
    { file: 'underscore.js', symbol: 'escaper', kind: 'function', status: 'modified', namedInAdvisory: false },
  ],
}

const underscoreJs = [
  '(function() {',
  '  var root = this',
  '  var _ = function(obj) { return obj }',
  "  if (typeof exports != 'undefined' && !exports.nodeType) {",
  "    if (typeof module != 'undefined' && !module.nodeType && module.exports) {",
  '      exports = module.exports = _',
  '    }',
  '    exports._ = _',
  '  } else {',
  '    root._ = _',
  '  }',
  '  var escaper = function(match) { return match }',
  '  _.pick = function(obj) { return obj }',
  '  _.template = function(text, settings) {',
  '    var render = new Function(settings, text)',
  '    var template = function(data) { return render.call(this, data, _) }',
  '    return template',
  '  }',
  '}())',
  '',
].join('\n')

async function project(app: string): Promise<string> {
  const root = await tmp('neat-1768-')
  const files: Record<string, unknown> = {
    'node_modules/underscore/package.json': { name: 'underscore', version: '1.9.1', main: 'underscore.js' },
    'node_modules/underscore/underscore.js': underscoreJs,
    'package.json': { name: 'shop', type: 'module', main: 'index.mjs', dependencies: { underscore: '1.9.1' } },
    'package-lock.json': {
      name: 'shop',
      lockfileVersion: 3,
      packages: { '': { name: 'shop', dependencies: { underscore: '1.9.1' } }, 'node_modules/underscore': { version: '1.9.1' } },
    },
    'index.mjs': app,
  }
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel)
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, typeof body === 'string' ? body : JSON.stringify(body))
  }
  return root
}

async function scanCard(root: string): Promise<SecurityCard> {
  const home = await tmp('neat-1768-home-')
  const file = path.join(home, 'advisories', 'npm', 'underscore@1.9.1.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ fetchedAt: new Date().toISOString(), advisories: [{ ...normalizeOsv(osv), fixDiff }] }))
  const out: string[] = []
  const err: string[] = []
  const code = await runSecurityCommand(['scan', root, '--json'], {
    env: { NEAT_HOME: home },
    fetchImpl: noNetwork,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  })
  expect(code, err.join('\n')).toBe(0)
  const result = JSON.parse(out[0]!) as SecurityScanResult
  const card = result.findings.find((c) => c.advisory.id === ADVISORY)
  expect(card).toBeDefined()
  return card!
}

describe('a fix target resolves by name when the installed version is laid out differently (#1768)', () => {
  it('grades a direct call to _.template reachable-static against a template~0 fix target', async () => {
    const card = await scanCard(await project("import u from 'underscore'\nexport function render(s) { return u.template(s)({}) }\n"))
    expect(card.reachability.level).toBe('reachable-static')
    expect(card.reachability.path!.at(-1)!.to).toBe('symbol:dep:npm:underscore@1.9.1:underscore.js#_.template')
  })

  it('leaves a call to an unrelated member at imported', async () => {
    const card = await scanCard(await project("import u from 'underscore'\nexport function pick(o) { return u.pick(o) }\n"))
    expect(card.reachability.level).toBe('imported')
  })
})

describe('changedTargets', () => {
  const dep = { ecosystem: 'npm', name: 'underscore', version: '1.9.1' } as DependencyNode
  const graphWith = (ids: string[]): NeatGraph => {
    const g = new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false }) as NeatGraph
    for (const id of ids) g.addNode(id, { id } as unknown as GraphNode)
    return g
  }
  const sym = (file: string, q: string, d?: number) => dependencySymbolId('npm', 'underscore', '1.9.1', file, q, d)

  it('takes base names without the disambiguator or the object qualifier', () => {
    expect(baseSymbolName('template~0')).toBe('template')
    expect(baseSymbolName('_.template')).toBe('template')
    expect(baseSymbolName('Parser.parse~2')).toBe('parse')
  })

  it('prefers the exact node and falls back by name only for advisory-named symbols', () => {
    const g = graphWith([sym('underscore.js', '_.template'), sym('underscore.js', 'template'), sym('underscore.js', 'escaper~0'), sym('other.js', 'template')])
    expect([...changedTargets(g, dep, fixDiff)].sort()).toEqual([sym('underscore.js', '_.template'), sym('underscore.js', 'template')])
  })

  it('does not fall back when the exact node exists', () => {
    const g = graphWith([sym('underscore.js', 'template', 0), sym('underscore.js', '_.template')])
    expect([...changedTargets(g, dep, fixDiff)]).toEqual([sym('underscore.js', 'template~0')])
  })
})

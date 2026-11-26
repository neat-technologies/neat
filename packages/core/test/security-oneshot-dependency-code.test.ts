import { describe, it, expect, afterEach } from 'vitest'
import nodeFs, { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import git from 'isomorphic-git'
import type { SecurityCard, SecurityScanResult } from '@neat.is/types'
import { normalizeOsv, type OsvRecord } from '../src/advisories/index.js'
import type { FixDiff } from '../src/advisories/fixdiff.js'
import { runSecurityCommand } from '../src/security-cli.js'
import { scanDiffLocal } from '../src/security-diff.js'

// The one-shot `neat security scan` loads the code of the advisory-matched
// dependency versions into its scratch graph before building cards
// (dependency-inventory.md §5), so it grades past `imported` the way the
// daemon's dependency-code loop does (#1763). No network: the advisory cache is
// seeded under a temp NEAT_HOME, and any fetch fails the test.

const ADVISORY = 'GHSA-35jh-r3h4-6jhm'
const FIX = path.join(__dirname, 'fixtures/osv')
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

// What NEAT's fix-diff of 4.17.20 -> 4.17.21 names for this advisory, cut to
// `template`: the modular template.js copy and the one bundled into lodash.js
// (the real changed set lists both, beside the trim/toNumber family).
const fixDiff: FixDiff = {
  from: '4.17.20',
  to: '4.17.21',
  changed: [
    { file: 'lodash.js', symbol: 'template', kind: 'function', status: 'modified', namedInAdvisory: true },
    { file: 'template.js', symbol: 'template', kind: 'function', status: 'modified', namedInAdvisory: true },
  ],
}

// A fresh advisory cache entry for lodash 4.17.15 carrying the real OSV record
// with that fix-diff, so the scan reads it and fetches nothing.
async function seededHome(): Promise<NodeJS.ProcessEnv> {
  const home = await tmp('neat-oneshot-home-')
  const rec = JSON.parse(readFileSync(path.join(FIX, `${ADVISORY}.json`), 'utf8')) as OsvRecord
  const entry = { fetchedAt: new Date().toISOString(), advisories: [{ ...normalizeOsv(rec), fixDiff }] }
  const file = path.join(home, 'advisories', 'npm', 'lodash@4.17.15.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(entry))
  return { NEAT_HOME: home }
}

// lodash 4.17.15 laid out the way it installs: modular files beside the
// single-file build that `main` points at.
const lodashFiles: Record<string, unknown> = {
  'node_modules/lodash/package.json': { name: 'lodash', version: '4.17.15', main: 'lodash.js' },
  'node_modules/lodash/template.js': [
    "var templateSettings = require('./templateSettings')",
    'function template(string, options, guard) {',
    '  var settings = templateSettings.imports',
    '  return compile(string, settings)',
    '}',
    'function compile(source, settings) { return Function(settings, source) }',
    'module.exports = template',
    '',
  ].join('\n'),
  'node_modules/lodash/templateSettings.js': 'var templateSettings = { imports: {} }\nmodule.exports = templateSettings\n',
  'node_modules/lodash/lodash.js': [
    ';(function() {',
    "  var freeModule = typeof module == 'object' && module",
    '  var runInContext = (function runInContext(context) {',
    '    function template(string, options, guard) { return Function(string) }',
    '    function lodash(value) { return value }',
    '    lodash.template = template',
    '    return lodash',
    '  })',
    '  var _ = runInContext()',
    '  if (freeModule) { (freeModule.exports = _)._ = _ }',
    '}.call(this))',
    '',
  ].join('\n'),
}

async function project(app: string, opts: { installed: boolean }): Promise<string> {
  const root = await tmp('neat-oneshot-')
  const files: Record<string, unknown> = {
    ...(opts.installed ? lodashFiles : {}),
    'package.json': { name: 'shop', main: 'app.js', dependencies: { lodash: '4.17.15' } },
    'package-lock.json': {
      name: 'shop',
      lockfileVersion: 3,
      packages: { '': { name: 'shop', dependencies: { lodash: '4.17.15' } }, 'node_modules/lodash': { version: '4.17.15' } },
    },
    'app.js': app,
  }
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel)
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, typeof body === 'string' ? body : JSON.stringify(body))
  }
  return root
}

async function scanCard(root: string): Promise<SecurityCard> {
  const out: string[] = []
  const err: string[] = []
  const code = await runSecurityCommand(['scan', root, '--json'], {
    env: await seededHome(),
    fetchImpl: noNetwork,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  })
  expect(code, err.join('\n')).toBe(0)
  const result = JSON.parse(out[0]!) as SecurityScanResult
  expect(result.errors).toEqual([])
  const card = result.findings.find((c) => c.advisory.id === ADVISORY)
  expect(card).toBeDefined()
  return card!
}

const DEEP = "const template = require('lodash/template')\nfunction render(a, b) { return template(a)(b) }\nmodule.exports = render\n"

describe('one-shot scan grades through installed dependency code', () => {
  it('grades a deep require of the changed file reachable-static, as the daemon does', async () => {
    const card = await scanCard(await project(DEEP, { installed: true }))
    expect(card.reachability.level).toBe('reachable-static')
    expect(card.reachability.path!.at(-1)!.to).toBe('symbol:dep:npm:lodash@4.17.15:template.js#template')
    expect(card.reachability.limits).toEqual([])
  })

  // #1761: the package root's `main` is the single-file build, where
  // `template` is a function inside an IIFE exported as `lodash.template`.
  for (const [style, app] of [
    ['a named import', "import { template } from 'lodash'\nexport function render(a, b) { return template(a)(b) }\n"],
    ['a default import', "import _ from 'lodash'\nexport function render(a, b) { return _.template(a)(b) }\n"],
    ['a member of the required module', "const _ = require('lodash')\nfunction render(a, b) { return _.template(a)(b) }\nmodule.exports = render\n"],
  ] as const) {
    it(`grades ${style} from the package root reachable-static, through the bundled main entry`, async () => {
      const card = await scanCard(await project(app, { installed: true }))
      expect(card.reachability.level).toBe('reachable-static')
      expect(card.reachability.path!.map((h) => h.to)).toEqual(['symbol:dep:npm:lodash@4.17.15:lodash.js#template'])
    })
  }

  it('stays imported, and says the package is not installed, when no installed copy is found', async () => {
    const card = await scanCard(await project(DEEP, { installed: false }))
    expect(card.reachability.level).toBe('imported')
    expect(card.reachability.limits).toHaveLength(1)
    expect(card.reachability.limits[0]).toMatch(/^No installed copy of lodash 4\.17\.15 was found under the scanned directory/)
  })

  it('diff loads each side from its own tree: the working tree has the install, the base from git does not', async () => {
    const root = await project(DEEP, { installed: true })
    await git.init({ fs: nodeFs, dir: root, defaultBranch: 'main' })
    for (const f of ['package.json', 'package-lock.json', 'app.js']) await git.add({ fs: nodeFs, dir: root, filepath: f })
    await git.commit({ fs: nodeFs, dir: root, message: 'base', author: { name: 't', email: 't@example.com', timestamp: 1700000000, timezoneOffset: 0 } })
    const d = await scanDiffLocal(root, { base: 'main' }, { fetchImpl: noNetwork, env: await seededHome() })
    expect(d.errors).toEqual([])
    const e = d.stillPresent.find((x) => x.advisoryId === ADVISORY)!
    expect(e.after!.reachability.level).toBe('reachable-static')
    expect(e.before!.reachability.level).toBe('imported')
    expect(e.before!.reachability.limits[0]).toMatch(/^No installed copy of lodash 4\.17\.15/)
  })
})

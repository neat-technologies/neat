import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { renderSecurity, securityGateFails, cardLine, SECURITY_MARKER } from '../src/security.mjs'

// Cards and results in the engine's own shapes (@neat.is/types security-card.ts):
// SecurityScanResult from get_reachable_cves, SecurityDiff from scan_diff.

function card(over = {}) {
  const { advisory = {}, dependency = {}, reachability = {}, fix, service = 'shop' } = over
  return {
    kind: 'security',
    id: `sec:${advisory.id ?? 'GHSA-aaaa-bbbb-cccc'}:${dependency.name ?? 'lodash'}`,
    service,
    advisory: {
      id: 'GHSA-aaaa-bbbb-cccc',
      aliases: ['CVE-2021-23337'],
      summary: 'Command injection in template.',
      severity: { label: 'high' },
      cwe: ['CWE-77'],
      modified: '2026-10-01T00:00:00Z',
      asOf: '2026-11-09T00:00:00Z',
      ...advisory,
    },
    dependency: {
      id: 'dep:npm:lodash@4.17.20',
      ecosystem: 'npm',
      name: 'lodash',
      version: '4.17.20',
      scope: 'direct',
      dev: false,
      introducedBy: [],
      manifest: { file: 'package.json' },
      ...dependency,
    },
    fix: fix ?? { fixedIn: ['4.17.21'] },
    reachability: {
      level: 'imported',
      grain: 'package',
      grainSource: 'package',
      changedInFix: [],
      importers: [{ file: 'src/render.ts', line: 3, provenance: 'EXTRACTED' }],
      path: null,
      observed: [],
      supporting: [],
      method: 'call-graph, no dataflow',
      limits: [],
      ...reachability,
    },
    coverage: { instrumented: 'unknown' },
    headline: '',
  }
}

const entry = (before, after) => {
  const c = after ?? before
  return { advisoryId: c.advisory.id, ecosystem: c.dependency.ecosystem, package: c.dependency.name, service: c.service, before, after }
}

function diff(over = {}) {
  return {
    advisories: 'osv',
    asOf: '2026-11-09T00:00:00Z',
    stale: 0,
    errors: [],
    base: { ref: 'aaa', inventory: 10 },
    head: { ref: 'bbb', inventory: 11 },
    introduced: [],
    removed: [],
    stillPresent: [],
    context: { introduced: [], removed: [] },
    ...over,
  }
}

test('a PR that introduces a reachable CVE leads with it and names the fix and the importing line', () => {
  const intro = card()
  const r = renderSecurity(diff({ introduced: [entry(null, intro)] }))
  assert.ok(r.body.startsWith(SECURITY_MARKER))
  assert.match(r.body, /this PR introduces 1 reachable known vulnerability/)
  assert.match(r.body, /\*\*Introduced by this PR\*\*/)
  assert.match(r.body, /GHSA-aaaa-bbbb-cccc \(CVE-2021-23337\)/)
  assert.match(r.body, /`lodash@4\.17\.20`/)
  assert.match(r.body, /Fix: upgrade `lodash` to `4\.17\.21`/)
  assert.match(r.body, /`src\/render\.ts:3`/)
  assert.equal(r.introduced, 1)
  assert.doesNotMatch(r.body, /—/, 'no em-dashes in product copy')
})

test('what the PR leaves and removes are reported apart from what it introduces', () => {
  const left = card({ advisory: { id: 'GHSA-left', aliases: [] } })
  const gone = card({ advisory: { id: 'GHSA-gone', aliases: [] } })
  const r = renderSecurity(diff({ stillPresent: [entry(left, left)], removed: [entry(gone, null)] }))
  assert.match(r.body, /no new reachable vulnerabilities/)
  assert.match(r.body, /\*\*Removed by this PR\*\*\n- \*\*high\*\* GHSA-gone/)
  assert.match(r.body, /Already present before this PR \(1\)/)
  assert.equal(r.introduced, 0)
  assert.equal(r.present, 1)
})

test('lockfile-only matches are context, never findings', () => {
  const ctx = card({ reachability: { level: 'present', importers: [] } })
  const r = renderSecurity(diff({ context: { introduced: [entry(null, ctx)], removed: [] } }))
  assert.match(r.body, /no reachable known vulnerabilities/)
  assert.match(r.body, /1 more matched advisory is new in the lockfile but not imported/)
  assert.equal(r.introduced, 0)
})

test('introduced findings list critical before high, keeping the engine order within a tier', () => {
  const a = card({ advisory: { id: 'GHSA-high-1', aliases: [] } })
  const b = card({ advisory: { id: 'GHSA-crit', aliases: [], severity: { label: 'critical' } } })
  const c = card({ advisory: { id: 'GHSA-high-2', aliases: [] } })
  const r = renderSecurity(diff({ introduced: [a, b, c].map((x) => entry(null, x)) }))
  const order = ['GHSA-crit', 'GHSA-high-1', 'GHSA-high-2'].map((id) => r.body.indexOf(id))
  assert.deepEqual([...order].sort((x, y) => x - y), order)
})

test('no published fix is said plainly', () => {
  assert.match(cardLine(card({ fix: { fixedIn: null } })), /Fix: no fixed version published yet\./)
})

test('disabled advisories never read as a clean bill', () => {
  const r = renderSecurity({ ...diff(), advisories: 'disabled', asOf: null })
  assert.match(r.body, /advisories disabled/)
  assert.match(r.body, /not the same as having none/)
  assert.equal(r.checked, false)
  assert.equal(securityGateFails(r, 'fail'), false)
})

test('stale caches and lookup errors are surfaced, not hidden', () => {
  const r = renderSecurity(diff({ stale: 2, errors: ['osv timeout'] }))
  assert.match(r.body, /2 package\(s\) served from a stale cache/)
  assert.match(r.body, /1 advisory lookup error\(s\), so this may be incomplete/)
})

test('a head-only scan lists what the code pulls in without calling it introduced', () => {
  const r = renderSecurity({ advisories: 'osv', asOf: null, stale: 0, errors: [], inventory: 5, findings: [card()], context: [] })
  assert.match(r.body, /1 reachable known vulnerability at this PR's head/)
  assert.match(r.body, /without separating what the PR introduced/)
  assert.doesNotMatch(r.body, /Introduced by this PR/)
  assert.equal(r.introduced, null)
})

test('the gate fails only in fail mode, only on introduced findings, and never on a head-only scan', () => {
  const introduced = renderSecurity(diff({ introduced: [entry(null, card())] }))
  const leftOnly = renderSecurity(diff({ stillPresent: [entry(card(), card())] }))
  const headOnly = renderSecurity({ advisories: 'osv', asOf: null, stale: 0, errors: [], inventory: 5, findings: [card()], context: [] })
  assert.equal(securityGateFails(introduced, 'report'), false)
  assert.equal(securityGateFails(introduced, 'fail'), true)
  assert.equal(securityGateFails(leftOnly, 'fail'), false)
  assert.equal(securityGateFails(headOnly, 'fail'), false)
})

// ── the scan runner: engine diff, then engine scan, then the connected host ──

const { runSecurityScan } = await import('../src/main.mjs')

test('the engine diff is used when the engine has it', async () => {
  const calls = []
  const out = await runSecurityScan({
    target: '/repo',
    baseSha: 'aaa',
    headSha: 'bbb',
    run: (args) => (calls.push(args), args[1] === 'diff' ? diff() : null),
    fetchImpl: () => assert.fail('no host call when the engine answers'),
  })
  assert.equal(out.via, 'engine-diff')
  assert.deepEqual(calls[0], ['security', 'diff', '/repo', '--base', 'aaa', '--head', 'bbb', '--json'])
})

test('an engine without the diff falls back to its head scan', async () => {
  const scan = { advisories: 'osv', asOf: null, stale: 0, errors: [], inventory: 1, findings: [], context: [] }
  const out = await runSecurityScan({ target: '/repo', baseSha: 'a', headSha: 'b', run: (args) => (args[1] === 'scan' ? scan : null) })
  assert.equal(out.via, 'engine-scan')
})

test('an engine without either falls back to the connected host over HTTP', async () => {
  const scan = { advisories: 'osv', asOf: '2026-11-09T00:00:00Z', stale: 0, errors: [], inventory: 3, findings: [card()], context: [] }
  let seen = null
  const server = http.createServer((req, res) => {
    seen = { url: req.url, auth: req.headers.authorization }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(scan))
  })
  server.listen(0)
  await once(server, 'listening')
  process.env.INPUT_NEAT_API_URL = `http://127.0.0.1:${server.address().port}/`
  process.env.INPUT_NEAT_API_TOKEN = 'tok'
  try {
    const out = await runSecurityScan({ target: '/repo', baseSha: 'a', headSha: 'b', run: () => null })
    assert.equal(out.via, 'host')
    assert.equal(out.result.findings.length, 1)
    assert.equal(seen.url, '/graph/security/reachable-cves')
    assert.equal(seen.auth, 'Bearer tok')
  } finally {
    delete process.env.INPUT_NEAT_API_URL
    delete process.env.INPUT_NEAT_API_TOKEN
    server.close()
  }
})

test('nothing available means no comment, not a failure', async () => {
  const out = await runSecurityScan({ target: '/repo', baseSha: 'a', headSha: 'b', run: () => null })
  assert.equal(out, null)
})

// ── one fix per package ──

import { packageFixes, compareVersions } from '../src/security.mjs'

test('versions order numerically, with a pre-release before its release', () => {
  assert.equal(compareVersions('4.17.21', '4.17.3'), 1)
  assert.equal(compareVersions('4.18.0', '4.17.23'), 1)
  assert.equal(compareVersions('2.0.0-rc.1', '2.0.0'), -1)
  assert.equal(compareVersions('v1.2', '1.2.0'), 0)
})

test('a package with several findings gets one upgrade that clears them all', () => {
  const a = card({ advisory: { id: 'GHSA-a' }, fix: { fixedIn: ['4.17.21'] } })
  const b = card({ advisory: { id: 'GHSA-b' }, fix: { fixedIn: ['4.18.0'] } })
  const c = card({ advisory: { id: 'GHSA-c' }, fix: { fixedIn: ['4.17.23'] } })
  const [f] = packageFixes([a, b, c])
  assert.deepEqual(
    { target: f.target, findings: f.findings, unfixed: f.unfixed, major: f.major },
    { target: '4.18.0', findings: 3, unfixed: 0, major: false },
  )
  const r = renderSecurity(diff({ introduced: [entry(null, a), entry(null, b)], stillPresent: [entry(c, c)] }))
  assert.match(r.body, /\*\*How to fix\*\*\n- Upgrade `lodash` from `4\.17\.20` to `4\.18\.0`: clears all 3 of its findings\./)
})

test('the same major is preferred over a breaking upgrade when an advisory offers both', () => {
  const a = card({ fix: { fixedIn: ['5.0.0', '4.17.21', '3.10.2'] } })
  assert.equal(packageFixes([a])[0].target, '4.17.21')
  const b = card({ fix: { fixedIn: ['5.0.0'] } })
  const [f] = packageFixes([b])
  assert.equal(f.major, true)
  assert.match(renderSecurity(diff({ introduced: [entry(null, b)] })).body, /to `5\.0\.0` \(a major version bump\): clears its finding\./)
})

test('findings with no published fix are counted, not folded into the upgrade', () => {
  const a = card({ advisory: { id: 'GHSA-a' }, fix: { fixedIn: ['4.17.21'] } })
  const b = card({ advisory: { id: 'GHSA-b' }, fix: { fixedIn: null } })
  const r = renderSecurity(diff({ introduced: [entry(null, a), entry(null, b)] }))
  assert.match(r.body, /to `4\.17\.21`: clears 1 of its 2 findings; 1 has no published fix yet\./)
  const none = renderSecurity(diff({ introduced: [entry(null, b)] }))
  assert.match(none.body, /- `lodash@4\.17\.20`: no fixed version published for its finding yet\./)
})

test('different packages each get their own line', () => {
  const a = card()
  const b = card({ advisory: { id: 'GHSA-m' }, dependency: { name: 'minimist', version: '1.2.5', id: 'dep:npm:minimist@1.2.5' }, fix: { fixedIn: ['1.2.6'] } })
  const fixes = packageFixes([a, b])
  assert.deepEqual(fixes.map((f) => `${f.name}->${f.target}`), ['lodash->4.17.21', 'minimist->1.2.6'])
})

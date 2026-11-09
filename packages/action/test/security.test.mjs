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

// ── one fix per package, from the engine's fix.action ──

import { packageFixes } from '../src/security.mjs'

const bump = (to, via = []) => ({ fixedIn: [to], action: { kind: 'bump-to-fixedIn', to, via } })

test('a package with several findings gets the one upgrade the engine chose', () => {
  const a = card({ advisory: { id: 'GHSA-a' }, fix: bump('4.18.0') })
  const b = card({ advisory: { id: 'GHSA-b' }, fix: bump('4.18.0') })
  const c = card({ advisory: { id: 'GHSA-c' }, fix: bump('4.18.0') })
  const r = renderSecurity(diff({ introduced: [entry(null, a), entry(null, b)], stillPresent: [entry(c, c)] }))
  assert.match(r.body, /\*\*How to fix\*\*\n- Upgrade `lodash` from `4\.17\.20` to `4\.18\.0`: clears all 3 of its findings\./)
})

test('the engine target is used as given, never re-derived from fixedIn', () => {
  // A Go pseudo-version the action could not order; the line must match the card.
  const pseudo = 'v0.0.0-20231201000000-abcdef123456'
  const a = card({ dependency: { ecosystem: 'Go', name: 'golang.org/x/net', version: 'v0.0.0-20220101000000-000000000000' }, fix: { fixedIn: ['v0.17.0', pseudo], action: { kind: 'bump-to-fixedIn', to: pseudo, via: [] } } })
  assert.equal(packageFixes([a])[0].action.to, pseudo)
  assert.match(renderSecurity(diff({ introduced: [entry(null, a)] })).body, new RegExp('to `' + pseudo + '`: clears its finding'))
})

test('a transitive package names the direct parent to bump, or an override', () => {
  const a = card({ dependency: { scope: 'transitive' }, fix: bump('4.17.21', ['express', 'async']) })
  assert.match(
    renderSecurity(diff({ introduced: [entry(null, a)] })).body,
    /- Bump `express` or `async`, or add an override, so `lodash` resolves to `4\.17\.21` or later: clears its finding\./,
  )
})

test('remove-or-replace offers the breaking fix when one exists, else the reason', () => {
  const major = card({ fix: { fixedIn: ['5.0.0'], action: { kind: 'remove-or-replace', reason: 'no 4.x release is fixed', majorTo: '5.0.0' } } })
  assert.match(
    renderSecurity(diff({ introduced: [entry(null, major)] })).body,
    /- Upgrade `lodash` from `4\.17\.20` to `5\.0\.0` \(a major version bump\): no non-breaking version clears its finding\./,
  )
  const none = card({ fix: { fixedIn: null, action: { kind: 'remove-or-replace', reason: 'No fixed version is published.' } } })
  assert.match(renderSecurity(diff({ introduced: [entry(null, none)] })).body, /- Remove or replace `lodash@4\.17\.20`: No fixed version is published\./)
})

test('an engine without fix.action gets no How to fix line, only the per-finding fixes', () => {
  const r = renderSecurity(diff({ introduced: [entry(null, card())] }))
  assert.doesNotMatch(r.body, /How to fix/)
  assert.match(r.body, /Fix: upgrade `lodash` to `4\.17\.21`/)
})

test('different packages each get their own line', () => {
  const a = card({ fix: bump('4.17.21') })
  const b = card({ advisory: { id: 'GHSA-m' }, dependency: { name: 'minimist', version: '1.2.5', id: 'dep:npm:minimist@1.2.5' }, fix: bump('1.2.6') })
  assert.deepEqual(packageFixes([a, b]).map((f) => `${f.name}->${f.action.to}`), ['lodash->4.17.21', 'minimist->1.2.6'])
})

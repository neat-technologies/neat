import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderGate, mapTestsResult, GATE_MARKER } from '../src/gate.mjs'

// The no-regression gate comment and input mapping (ADR-277,
// docs/contracts/no-regression-gate.md). renderGate and mapTestsResult are pure;
// gate-step.mjs runs the engine verb and posts the result.

const verdict = (over = {}) => ({
  conditions: [
    { name: 'blast-radius', status: 'pass', detail: '2 file(s), 1 service(s) (ceiling 50/10)' },
    { name: 'tests', status: 'pass', detail: 'test suite: pass' },
    { name: 'no-new-divergence', status: 'pass', detail: 'no new divergence' },
    { name: 'security', status: 'pass', detail: 'no known vulnerability introduced' },
  ],
  findings: [],
  passed: true,
  ...over,
})

test('mapTestsResult maps a GitHub job result to the gate vocabulary', () => {
  assert.equal(mapTestsResult('success'), 'pass')
  assert.equal(mapTestsResult('failure'), 'fail')
  assert.equal(mapTestsResult('pass'), 'pass')
  assert.equal(mapTestsResult('fail'), 'fail')
  // Neither green nor red: omit, so the gate's tests condition is unknown.
  assert.equal(mapTestsResult('cancelled'), '')
  assert.equal(mapTestsResult('skipped'), '')
  assert.equal(mapTestsResult(''), '')
  assert.equal(mapTestsResult(undefined), '')
})

test('a passing verdict renders all four conditions and does not block', () => {
  const r = renderGate(verdict(), 'fail')
  assert.ok(r.body.startsWith(GATE_MARKER))
  assert.match(r.body, /passed/)
  for (const label of ['Blast radius bounded', 'Test suite green', 'No new divergence', 'Security scan clear']) {
    assert.ok(r.body.includes(label), `renders ${label}`)
  }
  assert.equal(r.blocks, false)
})

test('a verdict that did not pass blocks and shows all four conditions', () => {
  const r = renderGate(
    verdict({
      conditions: [
        { name: 'blast-radius', status: 'pass', detail: 'within ceiling' },
        { name: 'tests', status: 'unknown', detail: 'no test outcome provided' },
        { name: 'no-new-divergence', status: 'fail', detail: '1 new divergence(s)' },
        { name: 'security', status: 'pass', detail: 'clear' },
      ],
      findings: [{ kind: 'divergence' }],
      passed: false,
    }),
    'fail',
  )
  assert.match(r.body, /did not pass/)
  assert.match(r.body, /No new divergence/)
  assert.match(r.body, /1 finding a NEAT Sniper run can target/)
  assert.equal(r.blocks, true)
})

test('report mode says it is not blocking', () => {
  const r = renderGate(verdict(), 'report')
  assert.match(r.body, /Reporting only/)
})

test('a null verdict is a fail-closed block and explains why', () => {
  const r = renderGate(null, 'fail')
  assert.match(r.body, /could not evaluate/)
  assert.match(r.body, /fails closed/)
  assert.equal(r.blocks, true)
})

test('a null verdict in report mode still renders but the step will not block', () => {
  const r = renderGate(null, 'report')
  assert.match(r.body, /could not evaluate/)
  // renderGate reports blocks=true, but noRegressionGateStep only fails in 'fail' mode.
  assert.equal(r.blocks, true)
})

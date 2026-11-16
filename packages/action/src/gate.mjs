// The pre-merge no-regression gate on a pull request (ADR-277,
// docs/contracts/no-regression-gate.md). Pure rendering and input mapping;
// gate-step.mjs runs the engine's hidden `gate` verb and posts the comment.
//
// The verdict is a NoRegressionGateVerdict from @neat.is/types: four tri-state
// conditions (blast-radius, tests, no-new-divergence, security) and a parallel
// findings list. `passed` is true only when all four pass (fail-closed); an
// unevaluable condition is `unknown` and never a pass.

export const GATE_MARKER = '<!-- neat-action:no-regression-gate -->'

const STATUS_ICON = { pass: '✅', fail: '❌', unknown: '⚠️' }

const CONDITION_LABEL = {
  'blast-radius': 'Blast radius bounded',
  tests: 'Test suite green',
  'no-new-divergence': 'No new divergence',
  security: 'Security scan clear',
}

/**
 * The workflow's test-job result, mapped to what the gate's `--tests` flag takes.
 * `success` is a green suite; `failure` is a red one. Anything else (a cancelled
 * or skipped job, or no value) maps to '' (omit the flag), which leaves the tests
 * condition `unknown` and fails the gate closed when it blocks.
 */
export function mapTestsResult(raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (v === 'success' || v === 'pass' || v === 'passed') return 'pass'
  if (v === 'failure' || v === 'fail' || v === 'failed') return 'fail'
  return ''
}

/**
 * The gate comment. Always lists all four conditions, whatever the verdict (so a repo
 * sees the answers before it opts in to blocking). Returns the sticky marker, the body
 * and whether this verdict blocks a merge (true when it did not pass, or could not be
 * evaluated at all, since a null verdict fails closed).
 */
export function renderGate(verdict, mode) {
  const L = [GATE_MARKER]
  if (!verdict || !Array.isArray(verdict.conditions)) {
    L.push('### NEAT no-regression gate: could not evaluate')
    L.push('')
    L.push(
      'NEAT could not build the base and head graphs for this pull request, so none of the four conditions could be checked. A full checkout (`fetch-depth: 0`) lets the gate read the base commit.',
    )
    if (mode === 'fail') L.push('\nThe gate is set to **fail**, and a gate it cannot evaluate fails closed.')
    return { marker: GATE_MARKER, body: L.join('\n'), blocks: true }
  }

  const passed = verdict.passed === true
  L.push(`### NEAT no-regression gate: ${passed ? 'passed' : 'did not pass'}`)
  L.push('')
  L.push('|  | Condition | Result |')
  L.push('| --- | --- | --- |')
  for (const c of verdict.conditions) {
    L.push(`| ${STATUS_ICON[c.status] ?? '•'} | ${CONDITION_LABEL[c.name] ?? c.name} | ${c.detail} |`)
  }

  const findings = Array.isArray(verdict.findings) ? verdict.findings : []
  if (findings.length) {
    L.push('')
    L.push(`${findings.length} finding${findings.length === 1 ? '' : 's'} a NEAT Sniper run can target.`)
  }

  L.push('')
  if (mode === 'report') {
    L.push(
      '_Reporting only. This gate is not set to block. Set `no-regression-gate: fail` to block a merge when it does not pass._',
    )
  } else if (!passed) {
    L.push(
      '_This gate is set to **fail**; a condition that is not a pass (including one NEAT could not evaluate) blocks the merge._',
    )
  }

  return { marker: GATE_MARKER, body: L.join('\n'), blocks: !passed }
}

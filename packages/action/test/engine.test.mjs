import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// runEngineJson against a stand-in engine: a script that prints what it is told
// to and exits with the code it is told to. The gate verb exits 1 for a verdict
// that did not pass and prints it anyway (no-regression-gate.md), so that exit
// has to reach the caller as a verdict, not as "no result".

const dir = mkdtempSync(path.join(tmpdir(), 'neat-action-engine-'))
const engine = path.join(dir, 'engine.cjs')
writeFileSync(engine, 'process.stdout.write(process.argv[3] ?? "")\nprocess.exit(Number(process.argv[2]))\n')
process.env.INPUT_ENGINE = engine

let runEngineJson
let runGate
before(async () => {
  ;({ runEngineJson } = await import('../src/engine.mjs'))
  ;({ runGate } = await import('../src/gate-step.mjs'))
})
after(() => rmSync(dir, { recursive: true, force: true }))

const failing = JSON.stringify({ passed: false, conditions: [{ name: 'tests', status: 'fail' }], findings: [] })

test('a clean exit is parsed', () => {
  assert.deepEqual(runEngineJson(['0', '{"passed":true}'], dir), { passed: true })
})

test('a non-zero exit is no result by default', () => {
  assert.equal(runEngineJson(['1', failing], dir), null)
})

test('exit 1 carries a result when the verb says so', () => {
  assert.deepEqual(runEngineJson(['1', failing], dir, { resultOnExit1: true }), JSON.parse(failing))
})

test('exit 1 with nothing parseable, and any other exit, stay no result', () => {
  assert.equal(runEngineJson(['1', ''], dir, { resultOnExit1: true }), null)
  assert.equal(runEngineJson(['1', 'not json'], dir, { resultOnExit1: true }), null)
  assert.equal(runEngineJson(['2', failing], dir, { resultOnExit1: true }), null)
})

test('the gate step asks for the failing verdict', () => {
  let seen
  const verdict = runGate('HEAD', {
    // stands in for `git worktree add`: the base checkout only has to exist
    git: (_cmd, args) => {
      if (args[0] === 'worktree' && args[1] === 'add') mkdirSync(args[3], { recursive: true })
      return ''
    },
    run: (args, cwd, opts) => {
      seen = { verb: args[0], opts }
      return JSON.parse(failing)
    },
  })
  assert.deepEqual(seen, { verb: 'gate', opts: { resultOnExit1: true } })
  assert.equal(verdict.passed, false)
})

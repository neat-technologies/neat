import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// A runner evaluates `${{ }}` everywhere in an action manifest, descriptions
// included, and fails to load the action when an expression names a context a
// manifest doesn't have (`needs`, `steps`, `matrix`). Nothing else in CI loads
// the manifest the way a runner does, so this holds the line: prose never
// carries a live expression.

const manifest = readFileSync(new URL('../action.yml', import.meta.url), 'utf8')

test('no description in action.yml carries a workflow expression', () => {
  const offenders = manifest
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /^\s*description:/.test(line) && line.includes('${{'))
  assert.deepEqual(offenders.map((o) => o.n), [])
})

test('every expression in action.yml reads a context a composite action has', () => {
  const contexts = [...manifest.matchAll(/\$\{\{\s*([a-z]+)[.\s]/g)].map((m) => m[1])
  assert.ok(contexts.length > 0)
  for (const c of contexts) assert.ok(['github', 'inputs', 'runner', 'env', 'steps'].includes(c), `unexpected context: ${c}`)
})

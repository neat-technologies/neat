import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SecurityDiff } from '@neat.is/types'
import { runGateCommand } from '../src/gate-cli.js'
import { gateFromCheckouts, type GateCheckoutsDeps } from '../src/pr-verdict.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The hidden `neat gate` verb (docs/contracts/no-regression-gate.md). It shells the
// no-regression gate (ADR-277) from two checkouts and is kept off every public
// surface, exactly like `assess`.

const cleanDiff = (over: Partial<SecurityDiff> = {}): SecurityDiff =>
  ({
    advisories: 'mirror',
    asOf: '2026-11-16T00:00:00Z',
    stale: 0,
    errors: [],
    base: { ref: 'base', inventory: 0 },
    head: { ref: 'head', inventory: 0 },
    introduced: [],
    removed: [],
    stillPresent: [],
    context: { introduced: [], removed: [] },
    ...over,
  }) as SecurityDiff

// An extractor that writes nothing: the scratch graphs stay empty, so the gate's
// graph-derived conditions (blast radius, no-new-divergence) are clean and the test
// drives tests/security through the inputs.
const emptyExtract: GateCheckoutsDeps['extract'] = async () => ({ extractionErrors: 0, skippedFiles: 0 })

describe('neat gate stays hidden', () => {
  it('is in neither usage() nor QUERY_VERBS', async () => {
    const cli = await fs.readFile(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf8')
    const usageBody = cli.match(/function usage\(\)[\s\S]*?\n\}/)?.[0] ?? ''
    expect(usageBody.length).toBeGreaterThan(0)
    // `gate` is not listed as a command. ("gate" still appears as the hooks `--gate`
    // flag and in "hard gate" prose, so match the command-listing shape, not the word.)
    expect(usageBody).not.toMatch(/console\.log\('\s*gate\b/)
    const { QUERY_VERBS } = await import('../src/cli.js')
    expect([...QUERY_VERBS]).not.toContain('gate')
  })

  it('is not among the verbs cli-surface.md lists', async () => {
    const surface = await fs.readFile(
      path.join(__dirname, '..', '..', '..', 'docs', 'contracts', 'cli-surface.md'),
      'utf8',
    )
    expect(surface).not.toMatch(/\bneat gate\b/)
  })
})

describe('runGateCommand usage', () => {
  it('exits 2 on a missing required flag', async () => {
    expect(await runGateCommand(['--base', '/tmp', '--head', '/tmp', '--max-files', '10'])).toBe(2)
  })

  it('exits 2 on a non-integer ceiling', async () => {
    expect(
      await runGateCommand(['--base', '/tmp', '--head', '/tmp', '--max-files', 'lots', '--max-services', '10']),
    ).toBe(2)
  })

  it('exits 2 on a ceiling below one', async () => {
    expect(
      await runGateCommand(['--base', '/tmp', '--head', '/tmp', '--max-files', '0', '--max-services', '10']),
    ).toBe(2)
  })

  it('exits 2 on a --tests value other than pass or fail', async () => {
    expect(
      await runGateCommand([
        '--base', '/tmp', '--head', '/tmp', '--max-files', '10', '--max-services', '10', '--tests', 'maybe',
      ]),
    ).toBe(2)
  })

  it('exits 2 when a checkout is not a directory', async () => {
    expect(
      await runGateCommand([
        '--base', '/nope/does/not/exist', '--head', '/nope/either', '--max-files', '10', '--max-services', '10',
      ]),
    ).toBe(2)
  })
})

describe('gateFromCheckouts (ADR-277, CI path)', () => {
  let baseDir: string
  let headDir: string

  beforeAll(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-cli-test-'))
    baseDir = path.join(root, 'repo-base')
    headDir = path.join(root, 'repo-head')
    await fs.mkdir(baseDir, { recursive: true })
    await fs.mkdir(headDir, { recursive: true })
    await fs.writeFile(path.join(headDir, 'added.ts'), 'export const x = 1\n')
  })

  afterAll(async () => {
    await fs.rm(path.dirname(baseDir), { recursive: true, force: true })
  })

  it('passes when all four conditions pass, with empty findings and no observed breaks', async () => {
    const verdict = await gateFromCheckouts({
      baseDir,
      headDir,
      gate: { tests: 'pass', blastRadius: { maxFiles: 50, maxServices: 10 } },
      deps: { extract: emptyExtract, scanDiff: async () => cleanDiff() },
    })
    expect(verdict.conditions.map((c) => c.name)).toEqual(['blast-radius', 'tests', 'no-new-divergence', 'security'])
    expect(verdict.conditions.every((c) => c.status === 'pass')).toBe(true)
    expect(verdict.findings).toHaveLength(0)
    expect(verdict.passed).toBe(true)
  })

  it('fails closed when the advisory lookup is unavailable (security unknown)', async () => {
    const verdict = await gateFromCheckouts({
      baseDir,
      headDir,
      gate: { tests: 'pass', blastRadius: { maxFiles: 50, maxServices: 10 } },
      deps: { extract: emptyExtract, scanDiff: async () => cleanDiff({ asOf: null, advisories: 'disabled' }) },
    })
    expect(verdict.conditions.find((c) => c.name === 'security')!.status).toBe('unknown')
    expect(verdict.passed).toBe(false)
  })

  it('fails closed when the scan throws', async () => {
    const verdict = await gateFromCheckouts({
      baseDir,
      headDir,
      gate: { tests: 'pass', blastRadius: { maxFiles: 50, maxServices: 10 } },
      deps: {
        extract: emptyExtract,
        scanDiff: async () => {
          throw new Error('offline')
        },
      },
    })
    expect(verdict.conditions.find((c) => c.name === 'security')!.status).toBe('unknown')
    expect(verdict.passed).toBe(false)
  })

  it('leaves the tests condition unknown when no outcome is supplied', async () => {
    const verdict = await gateFromCheckouts({
      baseDir,
      headDir,
      gate: { blastRadius: { maxFiles: 50, maxServices: 10 } },
      deps: { extract: emptyExtract, scanDiff: async () => cleanDiff() },
    })
    expect(verdict.conditions.find((c) => c.name === 'tests')!.status).toBe('unknown')
    expect(verdict.passed).toBe(false)
  })
})

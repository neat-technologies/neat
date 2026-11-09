import { describe, expect, it } from 'vitest'
import type { SecurityDiff, SecurityFixAction, SecurityScanResult } from '@neat.is/types'
import type { DepApplyResult } from '../src/security-apply.js'
import { runSecurityCommand } from '../src/security-cli.js'

// The `neat security` CLI, driven through injected out/err sinks and injected
// engine seams (mirroring project-cli.test.ts): parsing, the JSON emission, the
// stdout/stderr split and the exit codes are exercised without an extraction pass
// or a network advisory fetch. The engine itself is covered by security-scan /
// security-diff tests.

function sinks() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, write: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}

const scanResult = (over: Partial<SecurityScanResult> = {}): SecurityScanResult => ({
  advisories: 'mirror',
  asOf: '2026-11-09T00:00:00.000Z',
  stale: 0,
  errors: [],
  inventory: 3,
  findings: [],
  context: [],
  ...over,
})

const diffResult = (over: Partial<SecurityDiff> = {}): SecurityDiff => ({
  advisories: 'mirror',
  asOf: '2026-11-09T00:00:00.000Z',
  stale: 0,
  errors: [],
  base: { ref: 'base', inventory: 3 },
  head: { ref: 'head', inventory: 3 },
  introduced: [],
  removed: [],
  stillPresent: [],
  context: { introduced: [], removed: [] },
  ...over,
})

// The CLI only reads `.headline` off a card and JSON-stringifies the rest.
const card = (headline: string) => ({ headline }) as unknown as SecurityScanResult['findings'][number]
const entry = (headline: string) =>
  ({ advisoryId: 'GHSA-x', ecosystem: 'npm', package: 'p', service: 's', before: null, after: card(headline) }) as unknown as SecurityDiff['introduced'][number]

describe('neat security', () => {
  it('scan --json prints the SecurityScanResult on stdout and nothing else, exit 0', async () => {
    const s = sinks()
    const code = await runSecurityCommand(['scan', '.', '--json'], {
      scan: async () => scanResult({ findings: [card('CVE in p')] }),
      ...s.write,
    })
    expect(code).toBe(0)
    expect(s.out).toHaveLength(1)
    const parsed = JSON.parse(s.out[0]!)
    expect(Array.isArray(parsed.findings)).toBe(true)
    expect(parsed.findings).toHaveLength(1)
    expect(s.err).toEqual([])
  })

  it('exits 0 even with findings (the gate decides pass/fail from the JSON)', async () => {
    const s = sinks()
    const code = await runSecurityCommand(['scan', '--json'], {
      scan: async () => scanResult({ findings: [card('a'), card('b')] }),
      ...s.write,
    })
    expect(code).toBe(0)
  })

  it('diff --json emits a SecurityDiff whose introduced is an array, exit 0', async () => {
    const s = sinks()
    const code = await runSecurityCommand(['diff', '.', '--base', 'HEAD~1', '--head', 'HEAD', '--json'], {
      diff: async (_t, refs) => diffResult({ base: { ref: refs.base, inventory: 3 }, introduced: [entry('vuln p')] }),
      ...s.write,
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(s.out[0]!)
    expect(Array.isArray(parsed.introduced)).toBe(true)
    expect(parsed.introduced).toHaveLength(1)
    expect(parsed.base.ref).toBe('HEAD~1')
    expect(s.err).toEqual([])
  })

  it('diff defaults head to the working tree when --head is omitted', async () => {
    const s = sinks()
    let sawHead: string | undefined = 'unset'
    const code = await runSecurityCommand(['diff', '--base', 'main', '--json'], {
      diff: async (_t, refs) => {
        sawHead = refs.head
        return diffResult()
      },
      ...s.write,
    })
    expect(code).toBe(0)
    expect(sawHead).toBeUndefined()
  })

  it('diff without --base is misuse (exit 2), nothing on stdout', async () => {
    const s = sinks()
    const code = await runSecurityCommand(['diff', '.'], { diff: async () => diffResult(), ...s.write })
    expect(code).toBe(2)
    expect(s.out).toEqual([])
    expect(s.err.join('\n')).toMatch(/--base/)
  })

  it('advisories disabled returns a valid result (exit 0) the consumer renders, never a false all-clear', async () => {
    const s = sinks()
    const code = await runSecurityCommand(['scan', '--json'], {
      scan: async () => scanResult({ advisories: 'disabled', asOf: null }),
      ...s.write,
    })
    // exit 0 so the action parses the JSON and renders "not checked" rather than
    // falling through to a silent PR that reads as clean
    expect(code).toBe(0)
    expect(JSON.parse(s.out[0]!).advisories).toBe('disabled')
    // a stderr note makes the state explicit, and never says "no vulnerabilities"
    expect(s.err.join('\n')).toMatch(/disabled/)
    expect(s.err.join('\n')).not.toMatch(/no vulnerabilities/)
  })

  it('-h prints usage to stdout and exits 0 before any work', async () => {
    const s = sinks()
    const code = await runSecurityCommand(['-h'], { ...s.write })
    expect(code).toBe(0)
    expect(s.out.join('\n')).toMatch(/neat security scan/)
    expect(s.err).toEqual([])
  })

  it('an unknown subcommand is misuse (exit 2)', async () => {
    const s = sinks()
    const code = await runSecurityCommand(['frobnicate'], { ...s.write })
    expect(code).toBe(2)
    expect(s.err.join('\n')).toMatch(/unknown subcommand/)
  })

  it('scan without --json prints a human summary to stdout', async () => {
    const s = sinks()
    const code = await runSecurityCommand(['scan'], {
      scan: async () => scanResult({ findings: [card('CVE in p')] }),
      ...s.write,
    })
    expect(code).toBe(0)
    expect(s.out.join('\n')).toMatch(/1 finding/)
    expect(s.out.join('\n')).toMatch(/CVE in p/)
  })

  it('forwards --service and env to the engine', async () => {
    const s = sinks()
    let seen: { service?: string; env?: NodeJS.ProcessEnv } = {}
    const code = await runSecurityCommand(['scan', '--service', 'checkout', '--json'], {
      env: { NEAT_ADVISORIES: 'off' },
      scan: async (_t, opts) => {
        seen = { ...(opts.service ? { service: opts.service } : {}), ...(opts.env ? { env: opts.env } : {}) }
        return scanResult()
      },
      ...s.write,
    })
    expect(code).toBe(0)
    expect(seen.service).toBe('checkout')
    expect(seen.env?.NEAT_ADVISORIES).toBe('off')
  })

  // ── fix ──────────────────────────────────────────────────────────────────
  const bump = (to: string): SecurityFixAction => ({ kind: 'bump-to-fixedIn', to, via: [] })
  const fixCard = (name: string, version: string, action: SecurityFixAction | null, advisory = 'GHSA-a') =>
    ({
      kind: 'security',
      service: 'shop',
      dependency: { id: `dep:npm:${name}@${version}`, ecosystem: 'npm', name, version },
      advisory: { id: advisory },
      fix: { fixedIn: ['x'], ...(action ? { action } : {}) },
      headline: `${name} ${advisory}`,
    }) as unknown as SecurityScanResult['findings'][number]
  const depApplied = (id: string): DepApplyResult => ({
    dependencyId: id,
    manifest: 'package-lock.json',
    outcome: { applied: true, action: bump('4.17.21'), edits: [{ file: 'package.json', change: 'manifest-spec', dependency: id, from: '1', to: '2' }] },
  })

  it('fix plans by default: fixable vs not-auto-fixable, and writes nothing', async () => {
    const s = sinks()
    let applyCalled = false
    const code = await runSecurityCommand(['fix', '--json'], {
      scan: async () => scanResult({ findings: [fixCard('lodash', '4.17.15', bump('4.17.21')), fixCard('swig', '1.4.2', { kind: 'remove-or-replace', reason: 'no fix' })] }),
      apply: async () => { applyCalled = true; return [] },
      ...s.write,
    })
    expect(code).toBe(0)
    expect(applyCalled).toBe(false)
    const plan = JSON.parse(s.out[0]!)
    expect(plan.mode).toBe('plan')
    expect(plan.fixable.map((f: { dependency: { name: string } }) => f.dependency.name)).toEqual(['lodash'])
    expect(plan.fixable[0].to).toBe('4.17.21')
    expect(plan.skipped.map((x: { dependency: { name: string } }) => x.dependency.name)).toEqual(['swig'])
  })

  it('fix --apply applies the fixes and re-verifies with scan_diff', async () => {
    const s = sinks()
    let appliedCards = 0
    let reverifiedBase: string | undefined
    const code = await runSecurityCommand(['fix', '--apply', '--json'], {
      scan: async () => scanResult({ findings: [fixCard('lodash', '4.17.15', bump('4.17.21'))] }),
      apply: async (_t, cards) => { appliedCards = cards.length; return [depApplied('dep:npm:lodash@4.17.15')] },
      diff: async (_t, refs) => { reverifiedBase = refs.base; return diffResult({ removed: [entry('lodash GHSA-a')] }) },
      ...s.write,
    })
    expect(code).toBe(0)
    expect(appliedCards).toBe(1)
    expect(reverifiedBase).toBe('HEAD')
    const r = JSON.parse(s.out[0]!)
    expect(r.mode).toBe('apply')
    expect(r.applied).toHaveLength(1)
    expect(r.reverify).toEqual({ removed: 1, introduced: 0, stillPresent: 0, cleared: true })
  })

  it('fix exits 1 when advisories are disabled (cannot remediate without them)', async () => {
    const s = sinks()
    const code = await runSecurityCommand(['fix', '--json'], {
      scan: async () => scanResult({ advisories: 'disabled', asOf: null }),
      ...s.write,
    })
    expect(code).toBe(1)
    expect(s.err.join('\n')).toMatch(/disabled/)
  })

  it('fix plan without --json prints a human summary', async () => {
    const s = sinks()
    const code = await runSecurityCommand(['fix'], {
      scan: async () => scanResult({ findings: [fixCard('lodash', '4.17.15', bump('4.17.21'))] }),
      ...s.write,
    })
    expect(code).toBe(0)
    expect(s.out.join('\n')).toMatch(/fixable/)
    expect(s.out.join('\n')).toMatch(/lodash/)
  })
})

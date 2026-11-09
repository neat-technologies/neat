// `neat security scan/diff/fix`: the daemon-less security surface (ADR-274,
// cli-surface.md §neat security).
//
// A config-style command family alongside `neat doctor` / `neat connector`. It is
// not a query verb, so it stays off the locked query allowlist and parses its own
// argv. It is the one surface that runs the security engine (security-card.md)
// IN-PROCESS: no daemon, no REST round-trip, so the neat-action PR gate and any CI
// run it self-contained on a fresh checkout.
//
//   neat security scan [path] [--service <name>] [--json]
//   neat security diff [path] --base <ref> [--head <ref>] [--service <name>] [--json]
//   neat security fix  [path] [--apply] [--service <name>] [--json]
//
// `scan` and `diff` are read-only. `fix` is the one verb that writes: it plans by
// default (what it would bump, what it cannot auto-fix) and `--apply` edits the
// manifest and regenerates the lockfile, then re-verifies with scan_diff that the
// fixes cleared the vulnerabilities and introduced none.
//
// stdout carries the result (one JSON value under --json, else a short human
// summary); stderr carries every diagnostic, so a consumer parses stdout as one
// value. Exit 0 whenever the verb completed; advisories disabled
// (NEAT_ADVISORIES=off) returns a valid scan/diff that reports
// `advisories: 'disabled'` (never "no vulnerabilities"), while `fix` cannot
// remediate without advisories and exits 1. 1 when the engine could not produce a
// result; 2 on misuse. It reaches no daemon, so it never exits 3.
//
// The engine calls are injected (`scan` / `diff` / `apply`) so the parsing, output
// split and exit codes are unit-tested without extraction, npm, or a network
// advisory fetch; the defaults run the real engine.

import { statSync } from 'node:fs'
import path from 'node:path'
import type { SecurityCard, SecurityDiff, SecurityScanResult } from '@neat.is/types'
import { extractFromDirectory } from './extract.js'
import { makeGraph } from './graph.js'
import { scanProjectCves, type ScanOptions } from './security-scan.js'
import { scanDiffLocal } from './security-diff.js'
import { applyFixes, type DepApplyResult } from './security-apply.js'
import { advisoryDisclosure } from './advisories/source.js'

export interface SecurityEngineOptions {
  service?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}

export type SecurityScanFn = (target: string, opts: SecurityEngineOptions) => Promise<SecurityScanResult>
export type SecurityDiffFn = (
  target: string,
  refs: { base: string; head?: string },
  opts: SecurityEngineOptions,
) => Promise<SecurityDiff>
export type SecurityApplyFn = (target: string, cards: SecurityCard[]) => Promise<DepApplyResult[]>

export interface SecurityCliDeps {
  cwd?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  out?: (line: string) => void
  err?: (line: string) => void
  // Engine seams, defaulting to the real engine. Injected so a unit test drives
  // the verbs without an extraction pass, npm, or a network advisory fetch.
  scan?: SecurityScanFn
  diff?: SecurityDiffFn
  apply?: SecurityApplyFn
}

const USAGE = [
  'usage: neat security scan [path] [--service <name>] [--json]',
  '       neat security diff [path] --base <ref> [--head <ref>] [--service <name>] [--json]',
  '       neat security fix  [path] [--apply] [--service <name>] [--json]',
  '',
  'Run the security engine in-process, with no daemon and no NEAT server, so it',
  'works self-contained in CI. Advisories come from the NEAT mirror or OSV.',
  '',
  '  scan   the known-vulnerability findings (imported or above) and the lockfile-only',
  '         context for [path] (the checkout root or a subdirectory; default the cwd).',
  '  diff   what a change did: the findings it introduced, removed and left in place,',
  '         comparing --base against --head (--head defaults to the working tree).',
  '  fix    remediate: plan the fixes by default, --apply to edit the manifest and',
  '         regenerate the lockfile, then re-verify with scan_diff.',
  '',
  'Flags:',
  '  --apply            (fix) write the fixes; without it, fix only plans',
  '  --json             print the result on stdout',
  '  --base <ref>       (diff) the ref or commit to compare against (required)',
  '  --head <ref>       (diff) the ref or commit to compare (default: the working tree)',
  '  --service <name>   scope to one service',
  '',
  'Results go to stdout, diagnostics to stderr. Exit: 0 completed; 1 the engine',
  'could not produce a result (fix also exits 1 when advisories are disabled); 2 misuse.',
]

function toScanOpts(o: SecurityEngineOptions): ScanOptions {
  return {
    ...(o.service ? { service: o.service } : {}),
    ...(o.env ? { env: o.env } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  }
}

const realScan: SecurityScanFn = async (target, opts) => {
  const graph = makeGraph()
  await extractFromDirectory(graph, target, { announce: false })
  return scanProjectCves(graph, toScanOpts(opts))
}
const realDiff: SecurityDiffFn = (target, refs, opts) => scanDiffLocal(target, refs, toScanOpts(opts))
const realApply: SecurityApplyFn = (target, cards) => applyFixes(target, cards)

interface ParsedArgs {
  verb?: string
  target?: string
  base?: string
  head?: string
  service?: string
  json: boolean
  apply: boolean
  help: boolean
  unknown?: string
}

function parse(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, apply: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-h' || a === '--help') out.help = true
    else if (a === '--json') out.json = true
    else if (a === '--apply') out.apply = true
    else if (a === '--base') out.base = argv[++i]
    else if (a.startsWith('--base=')) out.base = a.slice('--base='.length)
    else if (a === '--head') out.head = argv[++i]
    else if (a.startsWith('--head=')) out.head = a.slice('--head='.length)
    else if (a === '--service') out.service = argv[++i]
    else if (a.startsWith('--service=')) out.service = a.slice('--service='.length)
    else if (!out.verb && !a.startsWith('-')) out.verb = a
    else if (out.target === undefined && !a.startsWith('-')) out.target = a
    else out.unknown ??= a
  }
  return out
}

// A stderr note for a disabled run. The result is valid and carries
// `advisories: 'disabled'`, so scan/diff stay 0 and the consumer renders it; this
// line makes the state explicit to a human, and never reads as "no vulnerabilities".
// Where this run's dependency list went (advisory-cache.md §2), on stderr so
// stdout stays the result. Only when it left for OSV: a mirror and a disabled
// run have nothing to disclose (a disabled run gets its own note).
function disclose(source: string, err: (l: string) => void): void {
  if (source === 'osv') err(advisoryDisclosure('osv').line)
}

function disabledNote(verb: string): string {
  return `neat security ${verb}: advisories disabled (NEAT_ADVISORIES=off); this run did not check for vulnerabilities, which is not the same as finding none`
}

function humanScan(r: SecurityScanResult): string[] {
  const asOf = r.asOf ? `, as of ${r.asOf}` : ''
  const lines = [
    `neat security: ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}, ` +
      `${r.context.length} in context, across ${r.inventory} ` +
      `director${r.inventory === 1 ? 'y' : 'ies'} of dependencies (advisories: ${r.advisories}${asOf}).`,
  ]
  for (const c of r.findings.slice(0, 10)) lines.push(`  • ${c.headline}`)
  if (r.findings.length > 10) lines.push(`  … and ${r.findings.length - 10} more`)
  if (r.stale > 0) lines.push(`  (${r.stale} advisory cache${r.stale === 1 ? '' : 's'} served past refresh)`)
  return lines
}

function humanDiff(r: SecurityDiff): string[] {
  const asOf = r.asOf ? `, as of ${r.asOf}` : ''
  const lines = [
    `neat security: ${r.introduced.length} introduced, ${r.removed.length} removed, ` +
      `${r.stillPresent.length} still present (base ${r.base.ref} to head ${r.head.ref}; ` +
      `advisories: ${r.advisories}${asOf}).`,
  ]
  for (const e of r.introduced.slice(0, 10)) lines.push(`  + ${e.after?.headline ?? `${e.advisoryId} ${e.package}`}`)
  if (r.introduced.length > 10) lines.push(`  … and ${r.introduced.length - 10} more introduced`)
  return lines
}

interface FixDep {
  ecosystem: string
  name: string
  version: string
}
interface FixPlanItem {
  dependency: FixDep
  to: string
  advisories: string[]
}
interface FixSkip {
  dependency: FixDep
  reason: string
}

// Classify the findings (deduped per dependency) into what one bump can fix and
// what it cannot, the same split the applier makes.
function classify(findings: SecurityCard[]): { fixable: FixPlanItem[]; skipped: FixSkip[] } {
  const byDep = new Map<string, SecurityCard[]>()
  for (const c of findings) {
    const list = byDep.get(c.dependency.id) ?? []
    list.push(c)
    byDep.set(c.dependency.id, list)
  }
  const fixable: FixPlanItem[] = []
  const skipped: FixSkip[] = []
  for (const cards of byDep.values()) {
    const c = cards[0]!
    const dependency: FixDep = { ecosystem: c.dependency.ecosystem, name: c.dependency.name, version: c.dependency.version }
    const advisories = [...new Set(cards.map((x) => x.advisory.id))].sort()
    const action = c.fix.action
    if (action?.kind === 'bump-to-fixedIn') fixable.push({ dependency, to: action.to, advisories })
    else if (action?.kind === 'remove-or-replace') skipped.push({ dependency, reason: action.majorTo ? `needs ${action.majorTo}, a breaking bump` : action.reason })
    else skipped.push({ dependency, reason: 'no fix action on the card' })
  }
  const key = (d: FixDep) => `${d.name}@${d.version}`
  fixable.sort((a, b) => key(a.dependency).localeCompare(key(b.dependency)))
  skipped.sort((a, b) => key(a.dependency).localeCompare(key(b.dependency)))
  return { fixable, skipped }
}

function humanPlan(fixable: FixPlanItem[], skipped: FixSkip[]): string[] {
  const lines = [`neat security fix: ${fixable.length} fixable, ${skipped.length} not auto-fixable.`]
  for (const f of fixable) lines.push(`  bump ${f.dependency.name} ${f.dependency.version} -> ${f.to}  (${f.advisories.join(', ')})`)
  for (const s of skipped.slice(0, 10)) lines.push(`  skip ${s.dependency.name} ${s.dependency.version}  (${s.reason})`)
  if (fixable.length > 0) lines.push('Run with --apply to write the fixes.')
  return lines
}

export async function runSecurityCommand(argv: string[], deps: SecurityCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l))
  const err = deps.err ?? ((l: string) => console.error(l))
  const cwd = deps.cwd ?? process.cwd()
  const scan = deps.scan ?? realScan
  const diff = deps.diff ?? realDiff
  const apply = deps.apply ?? realApply

  const args = parse(argv)
  if (args.help || !args.verb) {
    for (const l of USAGE) (args.help ? out : err)(l)
    return args.help ? 0 : 2
  }
  if (args.verb !== 'scan' && args.verb !== 'diff' && args.verb !== 'fix') {
    err(`neat security: unknown subcommand \`${args.verb}\``)
    for (const l of USAGE) err(l)
    return 2
  }
  if (args.unknown !== undefined) {
    err(`neat security: unexpected argument \`${args.unknown}\``)
    return 2
  }

  const target = path.resolve(cwd, args.target ?? '.')
  try {
    if (!statSync(target).isDirectory()) {
      err(`neat security: ${target} is not a directory`)
      return 2
    }
  } catch {
    err(`neat security: ${target} does not exist`)
    return 2
  }

  const engineOpts: SecurityEngineOptions = {
    ...(args.service ? { service: args.service } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  }

  if (args.verb === 'diff') {
    if (!args.base) {
      err('neat security diff: --base <ref> is required, the commit to compare against')
      return 2
    }
    let result: SecurityDiff
    try {
      result = await diff(target, { base: args.base, ...(args.head ? { head: args.head } : {}) }, engineOpts)
    } catch (e) {
      err(`neat security diff: ${(e as Error).message}`)
      return 1
    }
    if (args.json) out(JSON.stringify(result))
    else for (const l of humanDiff(result)) out(l)
    if (result.advisories === 'disabled') err(disabledNote('diff'))
    disclose(result.advisories, err)
    return 0
  }

  if (args.verb === 'fix') {
    let scanResult: SecurityScanResult
    try {
      scanResult = await scan(target, engineOpts)
    } catch (e) {
      err(`neat security fix: ${(e as Error).message}`)
      return 1
    }
    disclose(scanResult.advisories, err)
    if (scanResult.advisories === 'disabled') {
      if (args.json) out(JSON.stringify({ mode: args.apply ? 'apply' : 'plan', advisories: 'disabled', fixable: [], skipped: [] }))
      err(disabledNote('fix'))
      return 1
    }
    const { fixable, skipped } = classify(scanResult.findings)
    if (!args.apply) {
      if (args.json) out(JSON.stringify({ mode: 'plan', advisories: scanResult.advisories, asOf: scanResult.asOf, fixable, skipped }))
      else for (const l of humanPlan(fixable, skipped)) out(l)
      return 0
    }
    let applied: DepApplyResult[]
    try {
      applied = await apply(target, scanResult.findings)
    } catch (e) {
      err(`neat security fix: ${(e as Error).message}`)
      return 1
    }
    const appliedOut = applied.flatMap((a) => (a.outcome.applied ? [{ dependencyId: a.dependencyId, edits: a.outcome.edits }] : []))
    // Re-verify against HEAD; a project that is not a git checkout cannot be
    // diffed, which is a reported limit, not a failed fix.
    let reverify: { removed: number; introduced: number; stillPresent: number; cleared: boolean } | undefined
    try {
      const d = await diff(target, { base: 'HEAD' }, engineOpts)
      reverify = { removed: d.removed.length, introduced: d.introduced.length, stillPresent: d.stillPresent.length, cleared: d.introduced.length === 0 && d.removed.length > 0 }
    } catch (e) {
      err(`neat security fix: applied ${appliedOut.length}, but could not re-verify: ${(e as Error).message}`)
    }
    if (args.json) out(JSON.stringify({ mode: 'apply', advisories: scanResult.advisories, asOf: scanResult.asOf, applied: appliedOut, skipped, ...(reverify ? { reverify } : {}) }))
    else {
      out(`neat security fix: applied ${appliedOut.length} fix${appliedOut.length === 1 ? '' : 'es'}, ${skipped.length} not auto-fixable.`)
      for (const a of appliedOut) out(`  fixed ${a.dependencyId}`)
      if (reverify) out(`  re-verify: ${reverify.removed} removed, ${reverify.introduced} introduced, ${reverify.stillPresent} still present`)
    }
    return 0
  }

  let result: SecurityScanResult
  try {
    result = await scan(target, engineOpts)
  } catch (e) {
    err(`neat security scan: ${(e as Error).message}`)
    return 1
  }
  if (args.json) out(JSON.stringify(result))
  else for (const l of humanScan(result)) out(l)
  if (result.advisories === 'disabled') err(disabledNote('scan'))
  disclose(result.advisories, err)
  return 0
}

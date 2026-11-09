// `neat security scan/diff`: the daemon-less security surface (ADR-274,
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
//
// stdout carries the result (one JSON value under --json, else a short human
// summary); stderr carries every diagnostic, so a consumer parses stdout as one
// value. Exit 0 whenever a scan or diff completed: findings never change the code,
// and advisories disabled (NEAT_ADVISORIES=off) still returns a valid result that
// reports `advisories: 'disabled'`, which a surface renders as "not checked",
// never as "no vulnerabilities". Exit 1 only when the engine could not produce a
// result at all; 2 on misuse. It reaches no daemon, so it never exits 3.
//
// The engine calls are injected (`scan` / `diff`) so the parsing, output split and
// exit codes are unit-tested without extraction or a network advisory fetch; the
// defaults extract the target and run the real engine, and `env` / `fetchImpl`
// pass straight through to it (a fake OSV and NEAT_HOME in tests, the process
// environment in CI).

import { statSync } from 'node:fs'
import path from 'node:path'
import type { SecurityDiff, SecurityScanResult } from '@neat.is/types'
import { extractFromDirectory } from './extract.js'
import { makeGraph } from './graph.js'
import { scanProjectCves, type ScanOptions } from './security-scan.js'
import { scanDiffLocal } from './security-diff.js'

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

export interface SecurityCliDeps {
  cwd?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  out?: (line: string) => void
  err?: (line: string) => void
  // Engine seams, defaulting to the real engine. Injected so a unit test drives
  // the verbs without an extraction pass or a network advisory fetch.
  scan?: SecurityScanFn
  diff?: SecurityDiffFn
}

const USAGE = [
  'usage: neat security scan [path] [--service <name>] [--json]',
  '       neat security diff [path] --base <ref> [--head <ref>] [--service <name>] [--json]',
  '',
  'Run the security engine in-process, with no daemon and no NEAT server, so it',
  'works self-contained in CI. Advisories come from the NEAT mirror or OSV.',
  '',
  '  scan   the known-vulnerability findings (imported or above) and the lockfile-only',
  '         context for [path] (the checkout root or a subdirectory; default the cwd).',
  '  diff   what a change did: the findings it introduced, removed and left in place,',
  '         comparing --base against --head (--head defaults to the working tree).',
  '',
  'Flags:',
  '  --json             print the SecurityScanResult / SecurityDiff on stdout',
  '  --base <ref>       (diff) the ref or commit to compare against (required)',
  '  --head <ref>       (diff) the ref or commit to compare (default: the working tree)',
  '  --service <name>   scope to one service',
  '',
  'Results go to stdout, diagnostics to stderr. Exit: 0 completed (findings, and',
  'advisories disabled, do not change this); 1 the engine could not produce a result;',
  '2 misuse.',
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

interface ParsedArgs {
  verb?: string
  target?: string
  base?: string
  head?: string
  service?: string
  json: boolean
  help: boolean
  unknown?: string
}

function parse(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-h' || a === '--help') out.help = true
    else if (a === '--json') out.json = true
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
// `advisories: 'disabled'`, so the exit stays 0 and the consumer renders it; this
// line makes the state explicit to a human, and never reads as "no vulnerabilities".
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

export async function runSecurityCommand(argv: string[], deps: SecurityCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l))
  const err = deps.err ?? ((l: string) => console.error(l))
  const cwd = deps.cwd ?? process.cwd()
  const scan = deps.scan ?? realScan
  const diff = deps.diff ?? realDiff

  const args = parse(argv)
  if (args.help || !args.verb) {
    for (const l of USAGE) (args.help ? out : err)(l)
    return args.help ? 0 : 2
  }
  if (args.verb !== 'scan' && args.verb !== 'diff') {
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
  return 0
}

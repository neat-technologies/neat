// Security family: known vulnerabilities by exposure (ADR-274, security-card.md).
// get_reachable_cves ranks the security cards; is_reachable answers the
// dependency- or symbol-grain reachability of one package; scan_diff reports what
// a change did to them.
//
// Compact by default (#1550): the whole-project tools return a ranked rollup —
// one actionable line per finding (advisory, package@version, exposure, fix),
// capped with "N more" — and an `advisory` arg fetches one finding's full card
// (importers, limits, summary). A full dump of every card ran to ~100k chars on
// uptime-kuma and tripled agent cost; the rollup keeps the common answer small
// while the fix line stays on every row.

import type {
  ReachabilityAnswer,
  SecurityCard,
  SecurityDiff,
  SecurityDiffEntry,
  SecurityScanResult,
} from '@neat.is/types'
import { Provenance } from '@neat.is/types'
import type { HttpClient } from '../client.js'
import { formatErrorResponse, formatToolResponse, type ToolResponse } from '../format.js'
import { projectPath } from './shared.js'
import { z } from 'zod'
import { defineTool, projectField } from './registry.js'

// How many finding lines a rollup shows before collapsing the rest into "N more".
// The cap bounds the answer on a project with hundreds of transitive advisories;
// each line is ~120 chars, so the shown set stays a few KB. Narrow by service or
// drill in by advisory for the rest. This is the knob the cost eval tunes.
const MAX_FINDINGS = 40

export interface ReachableCvesInput {
  service?: string
  advisory?: string
  project?: string
}

export interface IsReachableInput {
  package: string
  version?: string
  ecosystem?: string
  service?: string
  symbol?: string
  project?: string
}

// Where the advisories came from and how fresh, so the osv.dev disclosure is
// visible (advisory-cache.md §2).
function advisorySourceLine(r: SecurityScanResult): string {
  const from = r.advisories === 'osv' ? 'osv.dev (package names and versions were sent there)' : 'the NEAT advisory mirror'
  const stale = r.stale > 0 ? `; ${r.stale} package(s) served from an expired cache after a failed refresh` : ''
  const errs = r.errors.length ? `; refresh error: ${r.errors[0]}` : ''
  return `Advisories from ${from}, as of ${r.asOf ?? 'unknown'}${stale}${errs}.`
}

// The remediation an agent (or the neat-action gate) applies: a direct bump, a
// parent bump / override for a transitive dep, or an app-layer mitigation.
function formatFixAction(
  action: NonNullable<SecurityCard['fix']['action']>,
  scope: 'direct' | 'transitive',
  name: string,
): string {
  if (action.kind === 'remove-or-replace') {
    return action.majorTo
      ? `no non-breaking bump; a breaking fix exists at ${name}@${action.majorTo}, else remove or replace (${action.reason})`
      : `remove or replace ${name}: ${action.reason}`
  }
  if (scope === 'direct') return `bump ${name} to ${action.to}`
  // A transitive dep can't be bumped at its own version; bumping the parent only
  // helps if the parent's range admits the fix, which the graph doesn't know.
  if (action.via.length) {
    return `bump ${action.via.join(', ')} if its range admits ${name}@${action.to}, else add a lockfile override/resolution for ${name}@${action.to}`
  }
  return `transitive, parent unknown: add an override/resolution for ${name}@${action.to}`
}

// The actionable part of a fix, for the compact line: the fix action if there is
// one, else the fixed releases, else a note that none exists.
function fixClause(c: SecurityCard): string {
  if (c.fix.action) return `fix: ${formatFixAction(c.fix.action, c.dependency.scope, c.dependency.name)}`
  if (c.fix.fixedIn?.length) return `fixed in ${c.fix.fixedIn.join(', ')}`
  return 'no fixed release'
}

// One finding on one line: exposure, advisory, package@version, where, and how to
// fix. Everything an agent needs to act; the importers, limits and summary are in
// the full card, behind the advisory arg.
function formatFindingLine(c: SecurityCard): string {
  const aliases = c.advisory.aliases.length ? ` (${c.advisory.aliases.join(', ')})` : ''
  const dev = c.dependency.dev ? ', dev' : ''
  return `  • [${c.reachability.level}] ${c.advisory.id}${aliases} ${c.advisory.severity.label}: ${c.dependency.name}@${c.dependency.version} in ${c.service} (${c.dependency.scope}${dev}) — ${fixClause(c)}`
}

// One finding, full: the fields an agent acts on first plus the importing files,
// transitive origin, summary and reachability limits. Returned by the advisory
// drill-in.
function formatSecurityFinding(c: SecurityCard): string {
  const aliases = c.advisory.aliases.length ? ` (${c.advisory.aliases.join(', ')})` : ''
  const dev = c.dependency.dev ? ', dev' : ''
  const lines = [
    `  • [${c.reachability.level}] ${c.advisory.id}${aliases} ${c.advisory.severity.label}: ${c.dependency.name}@${c.dependency.version} in ${c.service} (${c.dependency.scope}${dev})`,
    `    fixed in: ${c.fix.fixedIn?.join(', ') ?? 'no fixed release'}`,
  ]
  if (c.fix.action) lines.push(`    fix: ${formatFixAction(c.fix.action, c.dependency.scope, c.dependency.name)}`)
  if (c.reachability.importers.length) {
    const files = c.reachability.importers.map((i) => `${i.file}:${i.line}${i.bindings?.length ? ` {${i.bindings.join(', ')}}` : ''}`)
    lines.push(`    imported at: ${files.join('; ')}`)
  }
  if (c.dependency.scope === 'transitive' && c.dependency.introducedBy.length) {
    lines.push(`    pulled in by: ${c.dependency.introducedBy.join(', ')}`)
  }
  lines.push(`    summary: ${c.advisory.summary}`)
  for (const l of c.reachability.limits) lines.push(`    limit: ${l}`)
  return lines.join('\n')
}

function matchesAdvisory(c: SecurityCard, advisory: string): boolean {
  return c.advisory.id === advisory || c.advisory.aliases.includes(advisory)
}

// Count by severity, most severe first, for the rollup summary.
function severityCounts(findings: SecurityCard[]): string {
  const by = new Map<string, number>()
  for (const c of findings) by.set(c.advisory.severity.label, (by.get(c.advisory.severity.label) ?? 0) + 1)
  const order = ['critical', 'high', 'moderate', 'medium', 'low']
  return [...by.entries()]
    .sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99))
    .map(([label, n]) => `${n} ${label}`)
    .join(', ')
}

// Append the "N more" line pointing at the drill-in, when a list was capped.
function withMore(lines: string[], total: number, hint: string): string[] {
  const more = total - lines.length
  return more > 0 ? [...lines, `  … and ${more} more. ${hint}`] : lines
}

const DISABLED = 'Advisories are disabled (NEAT_ADVISORIES=off), so no vulnerability check ran. This is not a clean result.'

export async function getReachableCves(client: HttpClient, input: ReachableCvesInput): Promise<ToolResponse> {
  try {
    const params = new URLSearchParams()
    if (input.service) params.set('service', input.service)
    const qs = params.size > 0 ? `?${params.toString()}` : ''
    const r = await client.get<SecurityScanResult>(projectPath(input.project, `/graph/security/reachable-cves${qs}`))
    if (r.advisories === 'disabled') return formatToolResponse({ summary: DISABLED })
    const source = advisorySourceLine(r)

    // Drill-in: one advisory's full card(s), from findings or context.
    if (input.advisory) {
      const matches = [...r.findings, ...r.context].filter((c) => matchesAdvisory(c, input.advisory!))
      if (matches.length === 0) {
        return formatToolResponse({
          summary: `No finding for ${input.advisory}${input.service ? ` in ${input.service}` : ''}. Call get_reachable_cves without advisory for the ranked list. ${source}`,
        })
      }
      return formatToolResponse({
        summary: `${matches.length === 1 ? matches[0]!.headline : `${matches.length} findings match ${input.advisory}.`} ${source}`,
        block: matches.map(formatSecurityFinding).join('\n'),
        confidence: 1,
        provenance: Provenance.EXTRACTED,
      })
    }

    const context = r.context.length
      ? ` ${r.context.length} more matched advisor${r.context.length === 1 ? 'y is' : 'ies are'} in dependencies nothing imports (context, not findings).`
      : ''
    if (r.findings.length === 0) {
      return formatToolResponse({
        summary: `No known-vulnerable dependency is imported by first-party code across ${r.inventory} resolved packages.${context} ${source}`,
      })
    }
    const lines = withMore(
      r.findings.slice(0, MAX_FINDINGS).map(formatFindingLine),
      r.findings.length,
      "Call get_reachable_cves with advisory=<id> for a finding's full card (importers, limits, summary), or service=<name> to narrow.",
    )
    const summary =
      `${r.findings.length} known vulnerabilit${r.findings.length === 1 ? 'y' : 'ies'} in imported dependencies (${severityCounts(r.findings)}), most exposed first. ` +
      `Top: ${r.findings[0]!.headline}${context} ${source}`
    return formatToolResponse({
      summary,
      block: lines.join('\n'),
      confidence: 1,
      provenance: Provenance.EXTRACTED,
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export async function isReachableTool(client: HttpClient, input: IsReachableInput): Promise<ToolResponse> {
  try {
    const params = new URLSearchParams({ package: input.package })
    if (input.symbol) params.set('symbol', input.symbol)
    if (input.version) params.set('version', input.version)
    if (input.ecosystem) params.set('ecosystem', input.ecosystem)
    if (input.service) params.set('service', input.service)
    const r = await client.get<ReachabilityAnswer>(projectPath(input.project, `/graph/security/is-reachable?${params.toString()}`))
    if (r.advisories === 'disabled') return formatToolResponse({ summary: DISABLED })
    const source = advisorySourceLine(r)
    if (r.grain === 'symbol') {
      const target = `${input.package} ${r.symbol}`
      if (!r.reachable) {
        return formatToolResponse({
          summary: `reachable: false (symbol grain) for ${target}. ${(r.limits ?? []).join(' ')}`.trim(),
        })
      }
      const hops = (r.path ?? []).map((h) => `  ${h.from} → ${h.to}  [${h.provenance}]`)
      return formatToolResponse({
        summary: `reachable: true (symbol grain). First-party code reaches ${target} through ${hops.length} EXTRACTED call${hops.length === 1 ? '' : 's'}. This is a call path, not a dataflow claim: it doesn't show that untrusted input gets there.`,
        block: hops.join('\n'),
        confidence: 1,
        provenance: Provenance.EXTRACTED,
      })
    }
    if (r.inventory === 0) {
      return formatToolResponse({
        summary: `reachable: false. ${input.package}${input.version ? `@${input.version}` : ''} is not among this project's resolved dependencies.`,
      })
    }
    if (r.level === null) {
      return formatToolResponse({
        summary: `reachable: false. No known advisory matches the resolved version(s) of ${input.package}. ${source}`,
      })
    }
    const verdict = r.reachable
      ? `reachable: true (dependency grain). A known-vulnerable version of ${input.package} is imported by first-party code; whether the vulnerable function itself is called is not analysed yet.`
      : `reachable: false (dependency grain). A known-vulnerable version of ${input.package} is resolved, but no first-party file imports it.`
    const cards = [...r.findings, ...r.context]
    const lines = withMore(
      cards.slice(0, MAX_FINDINGS).map(formatFindingLine),
      cards.length,
      'Call get_reachable_cves with advisory=<id> for a finding\'s full card.',
    )
    return formatToolResponse({
      summary: `${verdict} ${source}`,
      block: lines.join('\n'),
      confidence: 1,
      provenance: Provenance.EXTRACTED,
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export interface ScanDiffInput {
  base: string
  head?: string
  service?: string
  advisory?: string
  project?: string
}

function diffEntryMatches(e: SecurityDiffEntry, advisory: string): boolean {
  if (e.advisoryId === advisory) return true
  return (
    (e.before != null && matchesAdvisory(e.before, advisory)) ||
    (e.after != null && matchesAdvisory(e.after, advisory))
  )
}

// The version change an entry carries, as " (before → after)", when it moved.
function diffVersionWas(e: SecurityDiffEntry): string {
  return e.before && e.after && e.before.dependency.version !== e.after.dependency.version
    ? ` (${e.before.dependency.version} → ${e.after.dependency.version})`
    : ''
}

function diffLevel(e: SecurityDiffEntry, card: SecurityCard): string {
  return e.before && e.after && e.before.reachability.level !== e.after.reachability.level
    ? `${e.before.reachability.level} → ${e.after.reachability.level}`
    : card.reachability.level
}

// One diff entry, compact: the finding line, with the version change and any
// level change folded in.
function formatDiffLine(e: SecurityDiffEntry, side: 'before' | 'after'): string {
  const card = (side === 'after' ? (e.after ?? e.before) : (e.before ?? e.after))!
  return formatFindingLine(card)
    .replace(/^ {2}• \[[^\]]+\]/, `  • [${diffLevel(e, card)}]`)
    .replace(`${card.dependency.name}@${card.dependency.version}`, `${card.dependency.name}@${card.dependency.version}${diffVersionWas(e)}`)
}

// One diff entry, full: the full card with the same version/level annotations.
function formatDiffEntry(e: SecurityDiffEntry, side: 'before' | 'after'): string {
  const card = (side === 'after' ? (e.after ?? e.before) : (e.before ?? e.after))!
  return formatSecurityFinding(card)
    .replace(/^ {2}• \[[^\]]+\]/, `  • [${diffLevel(e, card)}]`)
    .replace(`${card.dependency.name}@${card.dependency.version}`, `${card.dependency.name}@${card.dependency.version}${diffVersionWas(e)}`)
}

export async function scanDiff(client: HttpClient, input: ScanDiffInput): Promise<ToolResponse> {
  try {
    const params = new URLSearchParams({ base: input.base })
    if (input.head) params.set('head', input.head)
    if (input.service) params.set('service', input.service)
    const r = await client.get<SecurityDiff>(projectPath(input.project, `/graph/security/scan-diff?${params.toString()}`))
    if (r.advisories === 'disabled') return formatToolResponse({ summary: DISABLED })
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
    const sections: ReadonlyArray<readonly [string, SecurityDiffEntry[], 'before' | 'after']> = [
      ['Introduced', r.introduced, 'after'],
      ['Removed', r.removed, 'before'],
      ['Still present', r.stillPresent, 'after'],
    ]

    // Drill-in: one advisory's full before/after card, wherever it sits.
    if (input.advisory) {
      const block: string[] = []
      for (const [title, entries, side] of sections) {
        const hits = entries.filter((e) => diffEntryMatches(e, input.advisory!))
        if (hits.length) {
          block.push(`${title}:`)
          for (const e of hits) block.push(formatDiffEntry(e, side))
        }
      }
      if (block.length === 0) {
        return formatToolResponse({
          summary: `No scan-diff entry for ${input.advisory} between ${r.base.ref} and ${r.head.ref}. ${advisorySourceLine(r as unknown as SecurityScanResult)}`,
        })
      }
      return formatToolResponse({ summary: `scan-diff for ${input.advisory}.`, block: block.join('\n'), confidence: 1, provenance: Provenance.EXTRACTED })
    }

    const verdict =
      r.introduced.length === 0
        ? `${r.head.ref} introduces no known vulnerability in imported dependencies`
        : `${r.head.ref} introduces ${n(r.introduced.length, 'known vulnerability', 'known vulnerabilities')} in imported dependencies`
    const summary =
      `${verdict}, removes ${r.removed.length} and leaves ${r.stillPresent.length} in place, against ${r.base.ref}.` +
      (r.context.introduced.length ? ` ${n(r.context.introduced.length, 'new match is', 'new matches are')} only in the lockfile (context).` : '') +
      ` ${advisorySourceLine(r as unknown as SecurityScanResult)} Both sides were judged against the same advisories.`
    const block: string[] = []
    for (const [title, entries, side] of sections) {
      if (!entries.length) continue
      block.push(`${title}:`)
      const lines = withMore(
        entries.slice(0, MAX_FINDINGS).map((e) => formatDiffLine(e, side)),
        entries.length,
        'Call scan_diff with advisory=<id> for the full before/after card.',
      )
      for (const l of lines) block.push(l)
    }
    return formatToolResponse({
      summary,
      block: block.join('\n'),
      ...(block.length ? { confidence: 1, provenance: Provenance.EXTRACTED } : {}),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export const securityTools = [
  defineTool({
    name: 'get_reachable_cves',
    description:
      'Which known vulnerabilities in this project\'s dependencies does its own code actually pull in? Returns a compact ranked rollup by exposure (imported by first-party code first; a package only sitting in the lockfile is context, not a finding), then severity, then direct before transitive: one line per finding with its advisory, package@version, exposure level and the fix to apply, capped with "N more". Pass advisory=<GHSA/CVE id> for that one finding\'s full card (importing files and lines, transitive origin, summary, reachability limits), or service=<name> to narrow. Says where the advisories came from and how fresh they are.',
    schema: {
      service: z.string().optional().describe('Only this service (its name or service: node id). Omit for the whole project.'),
      advisory: z
        .string()
        .optional()
        .describe('An advisory id or alias (GHSA-..., CVE-...): return that finding\'s full card instead of the ranked rollup.'),
      project: projectField,
    },
    build: (ctx) => async (input) => getReachableCves(ctx.client, { ...input, project: ctx.projectFor(input) }),
  }),
  defineTool({
    name: 'is_reachable',
    description:
      'Is a known-vulnerable version of this package reached by the project\'s own code? Without symbol it answers at dependency grain: reachable is true when an affected version is imported by a first-party file, with a compact line per matching advisory and its fix. With symbol it answers at symbol grain: reachable is true when an EXTRACTED call path runs from the project\'s code to that function in the package, and returns the path. Use it to check a fix: after upgrading, the package should read reachable: false. For a finding\'s full card, call get_reachable_cves with its advisory.',
    schema: {
      package: z.string().describe('Package name as the ecosystem spells it (lodash, @scope/pkg, jinja2, github.com/x/y).'),
      version: z.string().optional().describe('Only this resolved version. Omit for every version the project resolves.'),
      ecosystem: z.string().optional().describe('npm, PyPI or Go: disambiguates a name used in more than one ecosystem.'),
      service: z.string().optional().describe('Only this service (its name or service: node id).'),
      symbol: z.string().optional().describe('A function in the package (template, Range.test) for a symbol-grain answer. Needs the package\'s code in the graph, which NEAT extracts for versions with a known advisory.'),
      project: projectField,
    },
    build: (ctx) => async (input) => isReachableTool(ctx.client, { ...input, project: ctx.projectFor(input) }),
  }),
  defineTool({
    name: 'scan_diff',
    description:
      'Did a change fix the vulnerability, and add none? Compares the known vulnerabilities of two revisions of the project (base against head, or against the working tree): which ones the change introduced, removed and left in place, each as a compact line with the package versions on both sides and the fix, capped with "N more". Both sides are judged against the same advisories, so a difference comes from the change. Pass advisory=<GHSA/CVE id> for the full before/after card. Use it to verify a dependency upgrade before calling it done.',
    schema: {
      base: z.string().describe('The revision to compare against: a branch, tag or commit (main, HEAD~1, a sha).'),
      head: z.string().optional().describe('The revision with the change. Omit to use the working tree as it is now.'),
      service: z.string().optional().describe('Only this service (its name or service: node id).'),
      advisory: z
        .string()
        .optional()
        .describe('An advisory id or alias: return that finding\'s full before/after card instead of the compact buckets.'),
      project: projectField,
    },
    build: (ctx) => async (input) => scanDiff(ctx.client, { ...input, project: ctx.projectFor(input) }),
  }),
]

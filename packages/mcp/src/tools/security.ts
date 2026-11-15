// Security family: known vulnerabilities by exposure (ADR-274, security-card.md).
// get_reachable_cves ranks the vulnerable dependencies; is_reachable answers the
// dependency- or symbol-grain reachability of one package; scan_diff reports what
// a change did to them; security_fix_plan gives the upgrade plan to clear them (the
// read-only side of the ADR-274 fix loop, applied from the CLI).
//
// Compact by default (#1550). get_reachable_cves returns one line per vulnerable
// DEPENDENCY, not per advisory: a package bump is the unit an agent acts on and
// one bump clears several CVEs, so the line carries package@version, the highest
// exposure among its advisories, how many advisories (ids listed), and the
// reconciled fix. The list is paged (offset) and a package or advisory arg drills
// in, so a "fix everything reachable" task can still enumerate every finding. A
// full dump of every card ran to ~100k chars on a large project and drove agent
// cost well above a bare model; the rollup keeps the common answer small while the
// fix stays on every row.

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

// How many dependency lines one page of the rollup shows before "N more". The cap
// bounds the answer on a project with hundreds of vulnerable packages; the rest
// are reached by paging (offset) or by drilling into one package. This is the knob
// the cost eval tunes.
const PAGE = 40
// How many advisory ids a dependency line lists inline before collapsing to a count.
const MAX_IDS = 4

export interface ReachableCvesInput {
  service?: string
  advisory?: string
  package?: string
  offset?: number
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
// parent bump or override for a transitive dep, or an app-layer mitigation.
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

// The actionable remediation for a card, for the compact line: the fix action if
// there is one, else the fixed releases, else a note that none exists.
function fixClause(c: SecurityCard): string {
  if (c.fix.action) return formatFixAction(c.fix.action, c.dependency.scope, c.dependency.name)
  if (c.fix.fixedIn?.length) return `fixed in ${c.fix.fixedIn.join(', ')}`
  return 'no fixed release'
}

// One advisory on one line: exposure, advisory, package@version, where, and how to
// fix. Used by is_reachable and scan_diff, which are already scoped to one package
// or one change. get_reachable_cves groups by dependency instead (formatDependencyLine).
function formatFindingLine(c: SecurityCard): string {
  const aliases = c.advisory.aliases.length ? ` (${c.advisory.aliases.join(', ')})` : ''
  const dev = c.dependency.dev ? ', dev' : ''
  return `  • [${c.reachability.level}] ${c.advisory.id}${aliases} ${c.advisory.severity.label}: ${c.dependency.name}@${c.dependency.version} in ${c.service} (${c.dependency.scope}${dev}); fix: ${fixClause(c)}`
}

// One vulnerable dependency on one line: its highest exposure, package@version,
// where, how many advisories hit it (ids listed, truncated with a count), and the
// one reconciled fix that clears them. The advisories' full cards are behind the
// package or advisory arg.
function formatDependencyLine(group: SecurityCard[]): string {
  const rep = group[0]! // core ranks by exposure, so the first card is the most exposed
  const dev = rep.dependency.dev ? ', dev' : ''
  const ids = group.map((c) => c.advisory.id)
  const idList = ids.length <= MAX_IDS ? ids.join(', ') : `${ids.slice(0, MAX_IDS).join(', ')}, +${ids.length - MAX_IDS} more`
  const count = `${group.length} advisor${group.length === 1 ? 'y' : 'ies'} (${idList})`
  return `  • [${rep.reachability.level}] ${rep.dependency.name}@${rep.dependency.version} in ${rep.service} (${rep.dependency.scope}${dev}); ${count}; fix: ${fixClause(rep)}`
}

// One finding, full: the fields an agent acts on first plus the importing files,
// transitive origin, summary and reachability limits. Returned by the package or
// advisory drill-in.
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

// Group findings by dependency-in-service, preserving core's exposure ranking: the
// groups come out in first-seen order, and each group keeps its cards in order so
// the first is the most exposed.
function groupByDependency(findings: SecurityCard[]): SecurityCard[][] {
  const groups = new Map<string, SecurityCard[]>()
  for (const c of findings) {
    const key = `${c.service}|${c.dependency.id}`
    const g = groups.get(key)
    if (g) g.push(c)
    else groups.set(key, [c])
  }
  return [...groups.values()]
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

    // Drill-in by advisory: one advisory's full card(s), from findings or context.
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

    // Drill-in by package: every advisory on one dependency, as full cards.
    if (input.package) {
      const matches = [...r.findings, ...r.context].filter((c) => c.dependency.name === input.package)
      if (matches.length === 0) {
        return formatToolResponse({
          summary: `No vulnerable dependency named ${input.package}${input.service ? ` in ${input.service}` : ''}. Call get_reachable_cves without package for the ranked list. ${source}`,
        })
      }
      return formatToolResponse({
        summary: `${matches.length} advisor${matches.length === 1 ? 'y' : 'ies'} on ${input.package}. ${source}`,
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

    const deps = groupByDependency(r.findings)
    const offset = Math.max(0, Math.trunc(input.offset ?? 0))
    const page = deps.slice(offset, offset + PAGE)
    const lines = page.map(formatDependencyLine)
    const nextOffset = offset + page.length
    if (nextOffset < deps.length) {
      lines.push(
        `  … and ${deps.length - nextOffset} more vulnerable dependenc${deps.length - nextOffset === 1 ? 'y' : 'ies'}. Call get_reachable_cves with offset=${nextOffset} for the next page, package=<name> for one dependency's advisories, or advisory=<id> for one finding's full card.`,
      )
    }
    const range = deps.length > PAGE ? ` Showing dependencies ${offset + 1} to ${nextOffset} of ${deps.length}.` : ''
    const summary =
      `${r.findings.length} known vulnerabilit${r.findings.length === 1 ? 'y' : 'ies'} across ${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'} imported by first-party code (${severityCounts(r.findings)}), most exposed first.${range} ` +
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
    // One package, so one line per advisory on it, with the fix.
    const cards = [...r.findings, ...r.context]
    return formatToolResponse({
      summary: `${verdict} ${source}`,
      block: cards.map(formatFindingLine).join('\n'),
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

// The version change an entry carries, as " (before -> after)", when it moved.
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

// One diff entry, compact: the advisory line, with the version change and any
// level change folded in.
function formatDiffLine(e: SecurityDiffEntry, side: 'before' | 'after'): string {
  const card = (side === 'after' ? (e.after ?? e.before) : (e.before ?? e.after))!
  return formatFindingLine(card)
    .replace(/^ {2}• \[[^\]]+\]/, `  • [${diffLevel(e, card)}]`)
    .replace(`${card.dependency.name}@${card.dependency.version}`, `${card.dependency.name}@${card.dependency.version}${diffVersionWas(e)}`)
}

// One diff entry, full: the full card with the same version and level annotations.
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
      const shown = entries.slice(0, PAGE).map((e) => formatDiffLine(e, side))
      if (entries.length > shown.length) {
        shown.push(`  … and ${entries.length - shown.length} more. Call scan_diff with advisory=<id> for the full before/after card.`)
      }
      for (const l of shown) block.push(l)
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

// The security fix plan (ADR-274 fix loop). Per dependency, the one upgrade that
// clears its findings, or why a single bump cannot. Read-only: it proposes the
// plan, it never applies it; applying stays in the CLI (`neat security fix`) and
// the PR action. The FixPlan shapes mirror GET /graph/security/fix-plan and are
// inlined here (not imported from core's security/fix-plan.ts) so the mcp package
// keeps to @neat.is/types and core's public modules (#1690).
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
  // The breaking (major) release that would clear the findings when one exists but
  // is not a same-major bump; absent when no fixed release clears it at all.
  breakingTo?: string
}
interface FixPlanResponse {
  advisories: 'mirror' | 'osv' | 'disabled'
  fixable: FixPlanItem[]
  skipped: FixSkip[]
}

export interface FixPlanInput {
  service?: string
  package?: string
  project?: string
}

// Where the advisories came from, for the plan's source note. The fix-plan route
// returns only the source (no asOf/stale/errors), so this is the short form of
// advisorySourceLine.
function fixPlanSource(advisories: FixPlanResponse['advisories']): string {
  return advisories === 'osv'
    ? 'Advisories from osv.dev (package names and versions were sent there).'
    : 'Advisories from the NEAT advisory mirror.'
}

function advisoryIdList(ids: string[]): string {
  return ids.length <= MAX_IDS ? ids.join(', ') : `${ids.slice(0, MAX_IDS).join(', ')}, +${ids.length - MAX_IDS} more`
}

// One fixable dependency: the single bump that clears its findings.
function formatFixableLine(f: FixPlanItem): string {
  return `  • bump ${f.dependency.name} ${f.dependency.version} → ${f.to}  (clears ${f.advisories.length}: ${advisoryIdList(f.advisories)})`
}

// One dependency a single bump cannot fix: the reason, with the breaking release
// that would clear it when there is one.
function formatSkipLine(s: FixSkip): string {
  const breaking = s.breakingTo ? ` [breaking fix at ${s.breakingTo}]` : ''
  return `  • ${s.dependency.name} ${s.dependency.version}: ${s.reason}${breaking}`
}

export async function securityFixPlan(client: HttpClient, input: FixPlanInput): Promise<ToolResponse> {
  try {
    const params = new URLSearchParams()
    if (input.service) params.set('service', input.service)
    const qs = params.size > 0 ? `?${params.toString()}` : ''
    const r = await client.get<FixPlanResponse>(projectPath(input.project, `/graph/security/fix-plan${qs}`))
    if (r.advisories === 'disabled') return formatToolResponse({ summary: DISABLED })
    const source = fixPlanSource(r.advisories)
    const where = input.service ? ` in ${input.service}` : ''

    // Drill-in by package: one dependency's plan entry, wherever it sits.
    if (input.package) {
      const fix = r.fixable.find((f) => f.dependency.name === input.package)
      if (fix) {
        return formatToolResponse({
          summary: `${input.package} is fixable: bump ${fix.dependency.version} → ${fix.to}, which clears ${fix.advisories.length} advisor${fix.advisories.length === 1 ? 'y' : 'ies'} (${fix.advisories.join(', ')}). Apply with \`neat security fix --apply\` in the CLI. ${source}`,
          confidence: 1,
          provenance: Provenance.EXTRACTED,
        })
      }
      const skip = r.skipped.find((s) => s.dependency.name === input.package)
      if (skip) {
        return formatToolResponse({
          summary: `${input.package} is not auto-fixable: ${skip.reason}${skip.breakingTo ? ` (a breaking fix exists at ${skip.breakingTo})` : ''}. For its full finding cards call get_reachable_cves with package=${input.package}. ${source}`,
        })
      }
      return formatToolResponse({
        summary: `${input.package} is not in the fix plan${where}: no known-vulnerable version of it is imported, so there is nothing to fix. ${source}`,
      })
    }

    if (r.fixable.length === 0 && r.skipped.length === 0) {
      return formatToolResponse({
        summary: `Nothing to fix${where}: no imported dependency has a known advisory. ${source}`,
      })
    }

    const block: string[] = []
    if (r.fixable.length) {
      block.push(`Fixable by a bump (${r.fixable.length}):`)
      const shown = r.fixable.slice(0, PAGE).map(formatFixableLine)
      if (r.fixable.length > shown.length) {
        shown.push(`  … and ${r.fixable.length - shown.length} more fixable. Narrow with service=<name>, or call get_reachable_cves for the ranked findings.`)
      }
      block.push(...shown)
    }
    if (r.skipped.length) {
      block.push(`Not auto-fixable (${r.skipped.length}):`)
      const shown = r.skipped.slice(0, PAGE).map(formatSkipLine)
      if (r.skipped.length > shown.length) {
        shown.push(`  … and ${r.skipped.length - shown.length} more. Pass package=<name> for one, or call get_reachable_cves for the full cards.`)
      }
      block.push(...shown)
    }

    const summary =
      `${r.fixable.length} dependenc${r.fixable.length === 1 ? 'y' : 'ies'} can be fixed by a bump, ${r.skipped.length} need${r.skipped.length === 1 ? 's' : ''} a decision (a breaking bump, a removal, or there is no fixed release)${where}. ` +
      `This is a plan: apply it with \`neat security fix --apply\` in the CLI, not over MCP. ${source}`
    return formatToolResponse({
      summary,
      block: block.join('\n'),
      confidence: 1,
      provenance: Provenance.EXTRACTED,
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

export const securityTools = [
  defineTool({
    name: 'get_reachable_cves',
    description:
      'Which known vulnerabilities in this project\'s dependencies does its own code actually pull in? Returns one line per vulnerable dependency, ranked by exposure (imported by first-party code first; a package only in the lockfile is context, not a finding): package@version, its highest exposure level, how many advisories hit it (ids listed), and the one reconciled fix that clears them (a single bump often clears several CVEs). The list is paged: when it is truncated the last line says the exact call for the next page (offset=<n>). Pass package=<name> for every advisory on one dependency as full cards, or advisory=<GHSA/CVE id> for one finding\'s full card (importers, limits, summary), or service=<name> to narrow. Says where the advisories came from and how fresh they are.',
    schema: {
      service: z.string().optional().describe('Only this service (its name or service: node id). Omit for the whole project.'),
      advisory: z
        .string()
        .optional()
        .describe('An advisory id or alias (GHSA-..., CVE-...): return that finding\'s full card instead of the rollup.'),
      package: z
        .string()
        .optional()
        .describe('A package name: return every advisory on that one dependency, as full cards, instead of the rollup.'),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Skip this many dependencies before the page. Use the offset the "N more" line names to read the rest.'),
      project: projectField,
    },
    build: (ctx) => async (input) => getReachableCves(ctx.client, { ...input, project: ctx.projectFor(input) }),
  }),
  defineTool({
    name: 'is_reachable',
    description:
      'Is a known-vulnerable version of this package reached by the project\'s own code? Without symbol it answers at dependency grain: reachable is true when an affected version is imported by a first-party file, with one line per advisory on the package and its fix. With symbol it answers at symbol grain: reachable is true when an EXTRACTED call path runs from the project\'s code to that function in the package, and returns the path. Use it to check a fix: after upgrading, the package should read reachable: false. For a finding\'s full card, call get_reachable_cves with its advisory.',
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
      'Did a change fix the vulnerability, and add none? Compares the known vulnerabilities of two revisions of the project (base against head, or against the working tree): which ones the change introduced, removed and left in place, each as a compact line with the package versions on both sides and the fix, capped per bucket with "N more". Both sides are judged against the same advisories, so a difference comes from the change. Pass advisory=<GHSA/CVE id> for the full before/after card. Use it to verify a dependency upgrade before calling it done.',
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
  defineTool({
    name: 'security_fix_plan',
    description:
      'What is the upgrade plan to clear this project\'s known vulnerabilities? Returns, per dependency, the ones a single version bump fixes (fixable: package, current version, the version to move to, and the advisories that bump clears) and the ones a bump cannot fix (skipped: the reason, plus the breaking release that would clear it when one exists). Read-only; it proposes the plan and does not apply it. Run `neat security fix --apply` in the CLI to write the fixes. Both lists are capped with "N more"; pass package=<name> for one dependency\'s entry, or service=<name> to narrow. For a finding\'s full card call get_reachable_cves.',
    schema: {
      service: z.string().optional().describe('Only this service (its name or service: node id). Omit for the whole project.'),
      package: z
        .string()
        .optional()
        .describe('A package name: return just that dependency\'s plan entry (fixable or not) instead of the whole plan.'),
      project: projectField,
    },
    build: (ctx) => async (input) => securityFixPlan(ctx.client, { ...input, project: ctx.projectFor(input) }),
  }),
]

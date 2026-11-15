// Security family: known vulnerabilities by exposure (ADR-274, security-card.md).
// get_reachable_cves ranks the security cards; is_reachable answers the
// dependency- or symbol-grain reachability of one package; scan_diff reports what
// a change did to them. Kept its own module so the compact-output change the bench
// calls for (rollup first, detail by id, a token cap) lands in one file.

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

export interface ReachableCvesInput {
  service?: string
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

// One finding, the fields an agent acts on first: advisory, package@version,
// fix, level, and the importing files that are its locus.
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

const DISABLED = 'Advisories are disabled (NEAT_ADVISORIES=off), so no vulnerability check ran. This is not a clean result.'

export async function getReachableCves(client: HttpClient, input: ReachableCvesInput): Promise<ToolResponse> {
  try {
    const params = new URLSearchParams()
    if (input.service) params.set('service', input.service)
    const qs = params.size > 0 ? `?${params.toString()}` : ''
    const r = await client.get<SecurityScanResult>(projectPath(input.project, `/graph/security/reachable-cves${qs}`))
    if (r.advisories === 'disabled') return formatToolResponse({ summary: DISABLED })
    const source = advisorySourceLine(r)
    const context = r.context.length
      ? ` ${r.context.length} more matched advisor${r.context.length === 1 ? 'y is' : 'ies are'} in dependencies nothing imports (context, not findings).`
      : ''
    if (r.findings.length === 0) {
      return formatToolResponse({
        summary: `No known-vulnerable dependency is imported by first-party code across ${r.inventory} resolved packages.${context} ${source}`,
      })
    }
    const top = r.findings[0]!
    const summary =
      `${r.findings.length} known vulnerabilit${r.findings.length === 1 ? 'y' : 'ies'} in imported dependencies, most exposed first. ` +
      `Top: ${top.headline}${context} ${source}`
    return formatToolResponse({
      summary,
      block: r.findings.map(formatSecurityFinding).join('\n'),
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
    return formatToolResponse({
      summary: `${verdict} ${source}`,
      block: cards.map(formatSecurityFinding).join('\n'),
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
  project?: string
}

function formatDiffEntry(e: SecurityDiffEntry, side: 'before' | 'after'): string {
  const card = (side === 'after' ? (e.after ?? e.before) : (e.before ?? e.after))!
  const ver = (c: SecurityCard | null) => (c ? c.dependency.version : 'none')
  const was = e.before && e.after && e.before.dependency.version !== e.after.dependency.version
    ? ` (${ver(e.before)} → ${ver(e.after)})`
    : ''
  const level =
    e.before && e.after && e.before.reachability.level !== e.after.reachability.level
      ? `${e.before.reachability.level} → ${e.after.reachability.level}`
      : card.reachability.level
  return formatSecurityFinding(card)
    .replace(/^ {2}• \[[^\]]+\]/, `  • [${level}]`)
    .replace(`${card.dependency.name}@${card.dependency.version}`, `${card.dependency.name}@${card.dependency.version}${was}`)
}

export async function scanDiff(client: HttpClient, input: ScanDiffInput): Promise<ToolResponse> {
  try {
    const params = new URLSearchParams({ base: input.base })
    if (input.head) params.set('head', input.head)
    if (input.service) params.set('service', input.service)
    const r = await client.get<SecurityDiff>(projectPath(input.project, `/graph/security/scan-diff?${params.toString()}`))
    if (r.advisories === 'disabled') return formatToolResponse({ summary: DISABLED })
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
    const verdict =
      r.introduced.length === 0
        ? `${r.head.ref} introduces no known vulnerability in imported dependencies`
        : `${r.head.ref} introduces ${n(r.introduced.length, 'known vulnerability', 'known vulnerabilities')} in imported dependencies`
    const summary =
      `${verdict}, removes ${r.removed.length} and leaves ${r.stillPresent.length} in place, against ${r.base.ref}.` +
      (r.context.introduced.length ? ` ${n(r.context.introduced.length, 'new match is', 'new matches are')} only in the lockfile (context).` : '') +
      ` ${advisorySourceLine(r as unknown as SecurityScanResult)} Both sides were judged against the same advisories.`
    const block: string[] = []
    const section = (title: string, entries: SecurityDiffEntry[], side: 'before' | 'after') => {
      if (!entries.length) return
      block.push(`${title}:`)
      for (const e of entries) block.push(formatDiffEntry(e, side))
    }
    section('Introduced', r.introduced, 'after')
    section('Removed', r.removed, 'before')
    section('Still present', r.stillPresent, 'after')
    return formatToolResponse({
      summary,
      block: block.join('\n'),
      ...(block.length ? { confidence: 1, provenance: Provenance.EXTRACTED } : {}),
    })
  } catch (err) {
    return formatErrorResponse(`Error talking to neat-core: ${(err as Error).message}`)
  }
}

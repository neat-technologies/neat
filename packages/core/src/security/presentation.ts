import type { SecurityCard, SecurityFixAction } from '@neat.is/types'
import { parseDependencySymbolId, parseSymbolId } from '@neat.is/types'

// The card's human-readable headline and the ranking of findings
// (security-card.md §5). Pure string and ordering functions over a composed card.

function shortName(id: string): string {
  const dep = parseDependencySymbolId(id)
  if (dep) return `${dep.qualname} (${dep.relPath})`
  const sym = parseSymbolId(id)
  if (sym) return `${sym.qualname} (${sym.relPath})`
  return id.replace(/^file:[^:]+:/, '')
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function describeFixAction(
  action: SecurityFixAction | undefined,
  scope: 'direct' | 'transitive',
  name: string,
  fixedIn: string[] | null,
): string {
  if (!action) return ''
  if (action.kind === 'remove-or-replace') {
    return action.majorTo
      ? ` No non-breaking bump: a breaking fix exists at ${action.majorTo}, else remove or replace.`
      : ' No safe bump: remove or replace.'
  }
  // The action is the dependency's shared target, reconciled across all of its
  // advisories. When that is not one of this advisory's own fixed releases, say
  // why, so the reader isn't left wondering which of the two versions to take.
  const why = fixedIn?.includes(action.to) ? '' : ` to clear every known advisory on ${name}`
  if (scope === 'direct') return ` Bump to ${action.to}${why}.`
  // A transitive dependency can't be bumped at its own version. Bumping the
  // parent only helps if the parent's range admits the fixed version, which the
  // graph doesn't know, so an override is the reliable move.
  if (action.via.length) return ` Bump ${action.via.join(', ')} if its range allows, else override ${name} to ${action.to}${why}.`
  return ` Override ${name} to ${action.to}${why} (transitive, parent unknown).`
}

// A fix is not done when the scan clears. A bump can clear the advisory and still change behavior (a
// minor that alters an API the service relies on), so the work order names the back half: after
// applying, re-scan to confirm the advisory is gone, then run the tests that exercise the files using
// this dependency. Only for an actionable card (a bump, or a remove-or-replace that carries a target);
// a card with no fix to apply gets no verify step.
function verifyClause(card: Omit<SecurityCard, 'headline'>): string {
  const { dependency: d, reachability: r, fix } = card
  const act = fix.action
  const actionable = !!act && (act.kind === 'bump-to-fixedIn' || (act.kind === 'remove-or-replace' && !!act.majorTo))
  if (!actionable) return ''
  const where = r.importers.length > 0 ? `the ${plural(r.importers.length, 'file', 'files')} that import ${d.name}` : `${d.name}'s use`
  return ` After applying, re-scan to confirm the advisory is cleared and run the tests covering ${where}; a fix can change behavior within the same major, so a cleared scan alone is not done.`
}

export function headlineFor(card: Omit<SecurityCard, 'headline'>): string {
  const { dependency: d, advisory: a, reachability: r, fix, coverage } = card
  const pkg = `${d.name} ${d.version}`
  const adv = `${a.id}, ${a.severity.label}`
  const how = d.scope === 'direct' ? 'direct' : `transitive via ${d.introducedBy.join(', ') || 'an unknown parent'}`
  const dev = d.dev ? ', dev only' : ''
  let exposure: string
  if (r.level === 'reachable-static' && r.path?.length) {
    const first = r.path[0]!
    const last = r.path[r.path.length - 1]!
    exposure =
      `reachable from ${card.service}: ${shortName(first.from)} calls ${shortName(first.to)}` +
      (r.path.length > 1 ? `, which reaches ${shortName(last.to)}` : '') +
      `, changed in the fix release (${plural(r.path.length, 'call', 'calls')}, no dataflow claimed)`
  } else if (r.level === 'imported') {
    exposure =
      r.grainSource === 'fix-diff'
        ? `imported by ${plural(r.importers.length, 'file', 'files')} in ${card.service}, but no call path to code changed in the fix was found`
        : `imported by ${plural(r.importers.length, 'file', 'files')} in ${card.service}; whether the vulnerable code is called is not yet analysed`
  } else exposure = `in ${card.service}'s dependencies (${how}${dev}) but no first-party file imports it`
  const fixed = fix.fixedIn?.length ? `Fixed in ${fix.fixedIn.join(', ')}.` : 'No fixed release.'
  const runtime = coverage.instrumented === 'no' ? ' The service is not instrumented, so runtime use is unknown.' : ''
  return `${pkg} (${adv}) is ${exposure}. ${fixed}${describeFixAction(fix.action, d.scope, d.name, fix.fixedIn)}${verifyClause(card)}${runtime}`
}

const LEVEL_RANK: Record<SecurityCard['reachability']['level'], number> = {
  'reachable-observed': 3,
  'reachable-static': 2,
  imported: 1,
  present: 0,
}
const SEVERITY_RANK: Record<SecurityCard['advisory']['severity']['label'], number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  unknown: 0,
}

/** The highest ladder step among `cards`, or null for none. */
export function highestLevel(cards: SecurityCard[]): SecurityCard['reachability']['level'] | null {
  let best: SecurityCard['reachability']['level'] | null = null
  for (const c of cards) if (best === null || LEVEL_RANK[c.reachability.level] > LEVEL_RANK[best]) best = c.reachability.level
  return best
}

/**
 * Ranking (security-card.md §5): level, then severity, then direct before
 * transitive, then card id so the order is total. A new array; the input is
 * untouched. Callers keep `present` cards out of a findings list.
 */
export function rankSecurityCards(cards: SecurityCard[]): SecurityCard[] {
  return [...cards].sort(
    (a, b) =>
      LEVEL_RANK[b.reachability.level] - LEVEL_RANK[a.reachability.level] ||
      SEVERITY_RANK[b.advisory.severity.label] - SEVERITY_RANK[a.advisory.severity.label] ||
      (a.dependency.scope === b.dependency.scope ? 0 : a.dependency.scope === 'direct' ? -1 : 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

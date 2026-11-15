import type { SecurityCard } from '@neat.is/types'

// The security fix plan (ADR-274 fix loop): classify a scan's security cards into
// the bumps one upgrade can make and the findings it cannot auto-fix, and render
// that plan for the CLI. Pure over SecurityCard[]; both the `neat security fix`
// CLI and GET /graph/security/fix-plan read it. Read-only, it proposes, never
// applies. The per-dependency action is read off the reconciled card.fix.action.

export interface FixDep {
  ecosystem: string
  name: string
  version: string
}
export interface FixPlanItem {
  dependency: FixDep
  to: string
  advisories: string[]
}
export interface FixSkip {
  dependency: FixDep
  reason: string
}
export interface FixPlan {
  fixable: FixPlanItem[]
  skipped: FixSkip[]
}

// Classify the findings (deduped per dependency) into what one bump can fix and
// what it cannot, the same split the applier makes.
export function classify(findings: SecurityCard[]): FixPlan {
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

export function humanPlan(fixable: FixPlanItem[], skipped: FixSkip[]): string[] {
  const lines = [`neat security fix: ${fixable.length} fixable, ${skipped.length} not auto-fixable.`]
  for (const f of fixable) lines.push(`  bump ${f.dependency.name} ${f.dependency.version} -> ${f.to}  (${f.advisories.join(', ')})`)
  for (const s of skipped.slice(0, 10)) lines.push(`  skip ${s.dependency.name} ${s.dependency.version}  (${s.reason})`)
  if (fixable.length > 0) lines.push('Run with --apply to write the fixes.')
  return lines
}

// The fix loop (G2): propose a remediation for a dependency's matched advisories,
// purely from the advisories' fixed releases and the installed version. No I/O,
// no network, no clock. The security card composes this alongside `fixedIn`; G1's
// scan_diff then verifies a proposed bump actually cleared the CVEs and introduced
// none.
//
// The action is PER DEPENDENCY, not per advisory: one dependency can match several
// advisories with different fixed releases (lodash 4.17.19 and 4.17.21), and two
// per-advisory bumps would conflict. So `to` is the lowest version that clears ALL
// of the dependency's advisories (the highest of their minimal fixes), and an
// agent bumps once.
//
// "Non-breaking" means a SAME-MAJOR bump, not "within your declared range": the
// manifest constraint (^1.2.3) isn't on the graph, so the card is honest and says
// "same major". A transitive dependency can't be bumped at its own version, so the
// renderers (security-card.ts, the MCP tool) say to bump the parent only if its
// range admits the fix, else override; `via` names the direct parent(s).

import semver from 'semver'
import type { SecurityFixAction } from '@neat.is/types'
import { comparePep440, parsePep440 } from './pep440.js'

export interface FixActionInput {
  // One fixed-release array per advisory matched on this dependency.
  fixedInByAdvisory: string[][]
  // The installed (vulnerable) version on the DependencyNode.
  installed: string
  // The DependencyNode ecosystem: 'npm', 'PyPI', 'Go', etc.
  ecosystem: string
  // Whether the service declares this dependency directly or pulls it in.
  scope: 'direct' | 'transitive'
  // The direct parent(s) that introduced a transitive dependency. Empty for a
  // direct dependency, and also empty when a transitive parent can't be
  // attributed (the renderers then say "override, parent unknown").
  introducedBy: string[]
}

export function fixActionFor(input: FixActionInput): SecurityFixAction {
  // The lowest fixed release above the installed version, per advisory. A
  // dependency is clear only when every advisory is: if any has no fix above the
  // installed version, no single bump clears it. The target clears all of them:
  // the highest of the per-advisory minimal fixes. Null when there's nothing to
  // clear to (no advisory, or one has no fix above installed), which
  // actionForTarget renders as remove-or-replace.
  const minimals = input.fixedInByAdvisory.map((f) => minimalAbove(f, input.installed, input.ecosystem))
  const target =
    input.fixedInByAdvisory.length === 0 || minimals.some((m) => m === null)
      ? null
      : maxVersion(minimals as string[], input.ecosystem)
  return actionForTarget({
    target,
    installed: input.installed,
    ecosystem: input.ecosystem,
    scope: input.scope,
    introducedBy: input.introducedBy,
    noClearReason: noClearReason(input.fixedInByAdvisory, input.installed),
  })
}

// The rigorous per-dependency target: the LOWEST fixed release the advisory
// matcher actually clears of EVERY one of the dependency's advisories.
// fixActionFor's max-of-minimals assumes any version at or above each advisory's
// fix is clear of it, which breaks when an advisory re-affects a later range
// (affected [1.0, 1.5) AND [1.8, 2.0)): the max of the minimal fixes can land
// back inside another advisory's affected range and not clear it. The caller
// supplies `clears`, which re-runs the matcher at a candidate version (the
// snapshot lives at the call site, so this stays pure), and we take the lowest
// candidate that clears them all. Null when none does -> remove-or-replace.
export function rigorousFixAction(input: {
  // Every fixed release the dependency's advisories list (duplicates are fine).
  candidates: string[]
  installed: string
  ecosystem: string
  scope: 'direct' | 'transitive'
  introducedBy: string[]
  // True when bumping to this version leaves none of the dependency's advisories
  // matching. Injected so the matcher (and its snapshot) stays at the call site.
  clears: (version: string) => boolean
}): SecurityFixAction {
  const above = input.candidates.filter((v) => {
    const c = compareVersions(v, input.installed, input.ecosystem)
    return c !== null && c > 0
  })
  const sorted = [...new Set(above)].sort((a, b) => compareVersions(a, b, input.ecosystem) ?? 0)
  const target = sorted.find((v) => input.clears(v)) ?? null
  return actionForTarget({
    target,
    installed: input.installed,
    ecosystem: input.ecosystem,
    scope: input.scope,
    introducedBy: input.introducedBy,
    noClearReason:
      input.candidates.length === 0
        ? 'the advisories list no fixed release'
        : 'no fixed release clears every advisory on this dependency',
  })
}

// Build the action for a known clearing target, or remove-or-replace when
// nothing clears every advisory (target null). A same-major step is a bump an
// agent can take; otherwise the fix exists but is breaking, so remove-or-replace
// still carries it as majorTo so the agent can choose it over removal. A Go major
// is a new module import path, not just a higher version, so the reason says so.
export function actionForTarget(input: {
  target: string | null
  installed: string
  ecosystem: string
  scope: 'direct' | 'transitive'
  introducedBy: string[]
  noClearReason: string
}): SecurityFixAction {
  const via = input.scope === 'transitive' ? [...input.introducedBy] : []
  if (input.target === null) {
    return { kind: 'remove-or-replace', reason: input.noClearReason }
  }
  if (sameMajor(input.installed, input.target, input.ecosystem) === true) {
    return { kind: 'bump-to-fixedIn', to: input.target, via }
  }
  const reason =
    input.ecosystem === 'Go'
      ? `clearing every advisory needs ${input.target}, a new major module path (the import path changes)`
      : `clearing every advisory needs ${input.target}, a major-version bump`
  return { kind: 'remove-or-replace', reason, majorTo: input.target }
}

function noClearReason(fixedInByAdvisory: string[][], installed: string): string {
  if (fixedInByAdvisory.every((f) => f.length === 0)) return 'the advisories list no fixed release'
  return `at least one advisory has no fixed release above the installed ${installed}`
}

function minimalAbove(fixedIn: string[], installed: string, ecosystem: string): string | null {
  const newer = fixedIn.filter((f) => {
    const c = compareVersions(f, installed, ecosystem)
    return c !== null && c > 0
  })
  if (newer.length === 0) return null
  return newer.reduce((lowest, f) => {
    const c = compareVersions(f, lowest, ecosystem)
    return c !== null && c < 0 ? f : lowest
  })
}

function maxVersion(versions: string[], ecosystem: string): string {
  return versions.reduce((highest, v) => {
    const c = compareVersions(v, highest, ecosystem)
    return c !== null && c > 0 ? v : highest
  })
}

// Ecosystem-aware version ordering. PyPI uses PEP 440; everything else uses
// semver, coercing a loose or v-prefixed version (v1.2 -> 1.2.0) so a comparison
// still lands. Returns null when either side can't be parsed, and the caller stays
// conservative.
function compareVersions(a: string, b: string, ecosystem: string): number | null {
  if (ecosystem === 'PyPI') {
    const pa = parsePep440(a)
    const pb = parsePep440(b)
    return pa && pb ? comparePep440(pa, pb) : null
  }
  const sa = toSemver(a)
  const sb = toSemver(b)
  return sa && sb ? semver.compare(sa, sb) : null
}

// Same-major (non-breaking) for the installed -> fixed step, false when it's a
// major bump, null when it can't be told. Go has no special case: a v2+ module is
// a different import path (a different DependencyNode), so a fix that matched THIS
// node is already same-path, while v0 -> v1 is a real breaking boundary that the
// semver major check (and the 0.x rule) below catches.
function sameMajor(installed: string, fixed: string, ecosystem: string): boolean | null {
  if (ecosystem === 'PyPI') {
    const pi = parsePep440(installed)
    const pf = parsePep440(fixed)
    if (!pi || !pf) return null
    return (pi.release[0] ?? 0) === (pf.release[0] ?? 0)
  }
  const si = toSemver(installed)
  const sf = toSemver(fixed)
  if (!si || !sf) return null
  if (semver.major(si) !== semver.major(sf)) return false
  // 0.x: under caret rules a minor bump is breaking (0.2 -> 0.3), so only a
  // same-minor change counts as non-breaking.
  if (semver.major(si) === 0) return semver.minor(si) === semver.minor(sf)
  return true
}

function toSemver(raw: string): string | null {
  return semver.valid(raw) ?? semver.coerce(raw)?.version ?? null
}

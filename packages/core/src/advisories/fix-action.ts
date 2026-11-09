// The fix loop (G2): propose a remediation for a matched advisory, purely from
// the advisory's fixed releases and the installed version — no I/O, no network,
// no clock. The security card (security-card.md) composes this alongside
// `fixedIn`; G1's scan_diff then verifies a proposed bump actually cleared the
// CVE and introduced none.
//
// "Non-breaking" here means a SAME-MAJOR bump, not "within your declared range":
// the manifest constraint (^1.2.3) isn't on the graph, so the card is honest and
// says "same major" rather than claiming to know the caret range. A transitive
// dependency can't be bumped at its own version — `via` names the direct
// parent(s) to bump or override instead, so an agent never edits a manifest for
// a package it doesn't declare.

import semver from 'semver'
import type { SecurityFixAction } from '@neat.is/types'
import { comparePep440, parsePep440 } from './pep440.js'

export interface FixActionInput {
  // The advisory's fixed releases (match.fixedIn), in no particular order.
  fixedIn: string[]
  // The installed (vulnerable) version on the DependencyNode.
  installed: string
  // The DependencyNode ecosystem: 'npm', 'PyPI', 'Go', etc.
  ecosystem: string
  // Whether the service declares this dependency directly or pulls it in.
  scope: 'direct' | 'transitive'
  // The direct parent(s) that introduced a transitive dependency (edge
  // introducedBy). Empty for a direct dependency.
  introducedBy: string[]
}

export function fixActionFor(input: FixActionInput): SecurityFixAction {
  const via = input.scope === 'transitive' ? [...input.introducedBy] : []
  if (input.fixedIn.length === 0) {
    return { kind: 'remove-or-replace', reason: 'the advisory lists no fixed release' }
  }
  const picked = minimalNonBreaking(input.fixedIn, input.installed, input.ecosystem)
  if ('to' in picked) return { kind: 'bump-to-fixedIn', to: picked.to, via }
  return { kind: 'remove-or-replace', reason: picked.reason }
}

// The lowest fixed release strictly newer than the installed version, when it is
// a same-major (non-breaking) bump; otherwise the reason it can't be bumped.
function minimalNonBreaking(
  fixedIn: string[],
  installed: string,
  ecosystem: string,
): { to: string } | { reason: string } {
  const newer = fixedIn.filter((f) => {
    const c = compareVersions(f, installed, ecosystem)
    return c !== null && c > 0
  })
  if (newer.length === 0) {
    return { reason: `no fixed release is newer than the installed ${installed}` }
  }
  const minimal = newer.reduce((lowest, f) => {
    const c = compareVersions(f, lowest, ecosystem)
    return c !== null && c < 0 ? f : lowest
  })
  const same = sameMajor(installed, minimal, ecosystem)
  if (same === true) return { to: minimal }
  if (same === false) {
    return { reason: `the earliest fixed release above ${installed} is ${minimal}, a major-version bump` }
  }
  return { reason: `cannot compare ${installed} to the fixed release ${minimal}` }
}

// Ecosystem-aware version ordering. PyPI uses PEP 440; everything else uses
// semver, coercing a loose version (1.2 -> 1.2.0) so a comparison still lands.
// Returns null when either side can't be parsed — the caller treats that as
// "can't evaluate" and stays conservative.
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

// True when the fixed release is a same-major (non-breaking) step from the
// installed version, false when it's a major bump, null when it can't be told.
function sameMajor(installed: string, fixed: string, ecosystem: string): boolean | null {
  // Go encodes the major in the module path (/v2 is a different module, hence a
  // different DependencyNode). A fixed release that matched THIS node is the
  // same module, so it is same-major by construction.
  if (ecosystem === 'Go') return true
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

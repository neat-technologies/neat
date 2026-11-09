// The security gate on a pull request (security-card.md §6, #1550). Renders the
// known vulnerabilities a PR introduces, leaves in place and removes, each with
// the fix, as its own sticky comment. Pure: main.mjs runs the scan and posts.
//
// Two inputs are accepted, both in the engine's own shapes (@neat.is/types):
//   - a SecurityDiff (scan_diff over base and head): the real gate, because it
//     separates what this PR introduced from what was already there.
//   - a SecurityScanResult (get_reachable_cves over head): what the code pulls
//     in at head, with no way to tell new from old. Used when the engine has no
//     diff yet; the comment says so rather than calling everything "introduced".

export const SECURITY_MARKER = '<!-- neat-action:security -->'

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'unknown']

const LEVEL_TEXT = {
  'reachable-observed': 'called in production',
  'reachable-static': 'reachable from your code',
  imported: 'imported by your code',
  present: 'in the lockfile only',
}

const MAX_LISTED = 15
const MAX_IMPORTERS = 3

function cveOf(advisory) {
  if (/^CVE-/.test(advisory.id)) return advisory.id
  return (advisory.aliases || []).find((a) => /^CVE-/.test(a)) || null
}

function advisoryLabel(advisory) {
  const cve = cveOf(advisory)
  return cve && cve !== advisory.id ? `${advisory.id} (${cve})` : advisory.id
}

/** The remediation, as the engine knows it: the fixed versions, or that none is published. */
export function fixText(card) {
  const fixed = card.fix?.fixedIn
  if (fixed && fixed.length) return `upgrade \`${card.dependency.name}\` to ${fixed.map((v) => '`' + v + '`').join(' or ')}`
  return 'no fixed version published yet'
}

function importersText(card) {
  const importers = card.reachability?.importers || []
  if (!importers.length) return ''
  const shown = importers.slice(0, MAX_IMPORTERS).map((i) => `\`${i.file}:${i.line}\``)
  const more = importers.length > MAX_IMPORTERS ? ` and ${importers.length - MAX_IMPORTERS} more` : ''
  return ` Imported at ${shown.join(', ')}${more}.`
}

/** One finding as a markdown list item: severity, advisory, package, how exposed, the fix, where. */
export function cardLine(card) {
  const sev = card.advisory.severity?.label || 'unknown'
  const dep = card.dependency
  const scope = dep.scope === 'transitive' ? 'transitive' : 'direct'
  const level = LEVEL_TEXT[card.reachability?.level] || card.reachability?.level || 'matched'
  const text = (card.advisory.summary || '').trim().replace(/\s+/g, ' ').replace(/\.+$/, '')
  const summary = text ? ` ${text}.` : ''
  return (
    `- **${sev}** ${advisoryLabel(card.advisory)} in \`${dep.name}@${dep.version}\` (${scope}, ${level}, service \`${card.service}\`).` +
    `${summary} Fix: ${fixText(card)}.${importersText(card)}`
  )
}

function bySeverity(cards) {
  const rank = (c) => {
    const i = SEVERITY_ORDER.indexOf(c.advisory.severity?.label || 'unknown')
    return i < 0 ? SEVERITY_ORDER.length : i
  }
  // Stable: the engine already ranks by exposure, so severity only breaks into tiers.
  return cards.map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c)
}

function list(L, cards) {
  for (const c of cards.slice(0, MAX_LISTED)) L.push(cardLine(c))
  if (cards.length > MAX_LISTED) L.push(`- and ${cards.length - MAX_LISTED} more`)
}

function sourceNote(result) {
  const parts = []
  if (result.advisories === 'osv') parts.push('Advisories from OSV')
  else if (result.advisories === 'mirror') parts.push('Advisories from the NEAT mirror')
  if (result.asOf) parts.push(`as of ${result.asOf}`)
  let note = parts.join(' ')
  if (result.stale) note += `${note ? '. ' : ''}${result.stale} package(s) served from a stale cache because the refresh failed`
  if (result.errors?.length) note += `${note ? '. ' : ''}${result.errors.length} advisory lookup error(s), so this may be incomplete`
  note += `${note ? '. ' : ''}Reachability is call-graph, no dataflow.`
  return note
}

const isDiff = (r) => Array.isArray(r?.introduced) && Array.isArray(r?.stillPresent)

/**
 * The security comment. `result` is a SecurityDiff or a SecurityScanResult.
 * Returns the marker, the body and the counts the gate reads.
 */
export function renderSecurity(result) {
  const L = [SECURITY_MARKER]

  if (result.advisories === 'disabled') {
    L.push('### NEAT security: advisories disabled')
    L.push('')
    L.push('The advisory lookup is turned off (`NEAT_ADVISORIES=off`), so this PR was not checked for known vulnerabilities. That is not the same as having none.')
    return { marker: SECURITY_MARKER, body: L.join('\n'), introduced: 0, present: 0, checked: false }
  }

  if (isDiff(result)) {
    const introduced = bySeverity(result.introduced.map((e) => e.after).filter(Boolean))
    const still = bySeverity(result.stillPresent.map((e) => e.after ?? e.before).filter(Boolean))
    const removed = bySeverity(result.removed.map((e) => e.before).filter(Boolean))

    if (introduced.length) {
      L.push(`### NEAT security: this PR introduces ${introduced.length} reachable known vulnerabilit${introduced.length === 1 ? 'y' : 'ies'}`)
    } else if (still.length) {
      L.push('### NEAT security: no new reachable vulnerabilities')
    } else {
      L.push('### NEAT security: no reachable known vulnerabilities')
    }
    L.push('')
    if (introduced.length) {
      L.push('**Introduced by this PR**')
      list(L, introduced)
      L.push('')
    }
    if (removed.length) {
      L.push('**Removed by this PR**')
      list(L, removed)
      L.push('')
    }
    if (still.length) {
      L.push(`<details><summary>Already present before this PR (${still.length})</summary>`)
      L.push('')
      list(L, still)
      L.push('')
      L.push('</details>')
      L.push('')
    }
    const ctxIn = result.context?.introduced?.length || 0
    if (ctxIn) {
      L.push(`${ctxIn} more matched advisor${ctxIn === 1 ? 'y is' : 'ies are'} new in the lockfile but not imported by your code, so ${ctxIn === 1 ? 'it is' : 'they are'} not counted as findings.`)
      L.push('')
    }
    L.push(`<sub>Base and head checked against one advisory snapshot, so every difference comes from this PR. ${sourceNote(result)}</sub>`)
    return { marker: SECURITY_MARKER, body: L.join('\n'), introduced: introduced.length, present: still.length, checked: true }
  }

  // Head-only scan: what the code pulls in now, new or not.
  const findings = bySeverity(result.findings || [])
  L.push(
    findings.length
      ? `### NEAT security: ${findings.length} reachable known vulnerabilit${findings.length === 1 ? 'y' : 'ies'} at this PR's head`
      : "### NEAT security: no reachable known vulnerabilities at this PR's head",
  )
  L.push('')
  if (findings.length) {
    list(L, findings)
    L.push('')
    L.push('This scan covers the head only, so it lists what the code pulls in after this PR without separating what the PR introduced from what was already there.')
    L.push('')
  }
  const ctx = result.context?.length || 0
  if (ctx) {
    L.push(`${ctx} more matched advisor${ctx === 1 ? 'y is' : 'ies are'} in the lockfile but not imported by your code, so not counted as findings.`)
    L.push('')
  }
  L.push(`<sub>${sourceNote(result)}</sub>`)
  return { marker: SECURITY_MARKER, body: L.join('\n'), introduced: null, present: findings.length, checked: true }
}

/**
 * Whether the gate fails the check. Only `fail` mode ever does, and only on a
 * reachable vulnerability this PR introduced: a head-only scan can't attribute
 * anything to the PR, so it never fails a check on its own.
 */
export function securityGateFails(rendered, mode) {
  return mode === 'fail' && rendered.checked && typeof rendered.introduced === 'number' && rendered.introduced > 0
}

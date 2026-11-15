// The security step: scan the PR for known vulnerabilities, post the security
// comment, and fail the check only when the opt-in gate says so. Runs on its own,
// so a PR whose graph comes back empty is still checked.

import path from 'node:path'
import { SCAN_SUBPATH, SECURITY_GATE, TOKEN, WORKSPACE, apiUrl } from './config.mjs'
import { runEngineJson } from './engine.mjs'
import { failSecurityGate } from './exit.mjs'
import { postSticky } from './github.mjs'
import { apiHeaders } from './host.mjs'
import { renderSecurity, securityGateFails } from './security.mjs'

/**
 * The security scan for this PR, in the engine's own shapes. In order:
 *   1. the engine's scan_diff over base and head, inline in CI: the gate proper;
 *   2. the engine's head-only reachable-CVE scan, inline;
 *   3. a connected NEAT host's /graph/security/reachable-cves (neat-api-url).
 * Null when none is available. The advisory lookup is the engine's one network
 * step; CI has network, so no daemon is needed for 1 or 2.
 */
export async function runSecurityScan({ target, baseSha, headSha, run = runEngineJson, fetchImpl = fetch }) {
  if (baseSha && headSha) {
    const diff = run(['security', 'diff', target, '--base', baseSha, '--head', headSha, '--json'], target)
    if (diff && Array.isArray(diff.introduced)) return { result: diff, via: 'engine-diff' }
  }
  const scan = run(['security', 'scan', target, '--json'], target)
  if (scan && Array.isArray(scan.findings)) return { result: scan, via: 'engine-scan' }
  const url = apiUrl()
  if (url) {
    try {
      const res = await fetchImpl(url.replace(/\/+$/, '') + '/graph/security/reachable-cves', { headers: apiHeaders() })
      if (res.ok) {
        const body = await res.json()
        if (body && (Array.isArray(body.findings) || body.advisories === 'disabled')) return { result: body, via: 'host' }
      }
    } catch {
      // A host hiccup leaves the PR without a security comment, never a failed check.
    }
  }
  return null
}

export async function securityStep(owner, repo, prNumber, baseSha, headSha) {
  const target = SCAN_SUBPATH ? path.join(WORKSPACE, SCAN_SUBPATH) : WORKSPACE
  let scan = null
  try {
    scan = await runSecurityScan({ target, baseSha, headSha })
  } catch (e) {
    console.log('security scan skipped:', e.message)
  }
  if (!scan) {
    console.log('No security scan available (engine without the security verbs and no neat-api-url); skipping the security comment.')
    return
  }
  const rendered = renderSecurity(scan.result)
  if (TOKEN) {
    try {
      await postSticky(owner, repo, prNumber, rendered.marker, rendered.body)
      console.log(`Posted NEAT security comment on PR #${prNumber} (${scan.via})`)
    } catch (e) {
      console.log('security comment not posted:', e.message)
    }
  } else {
    console.log('No github-token; security comment preview:\n' + rendered.body)
  }
  if (securityGateFails(rendered, SECURITY_GATE)) {
    console.error(`neat-action: this PR introduces ${rendered.introduced} known vulnerabilit${rendered.introduced === 1 ? 'y' : 'ies'} in imported dependencies (security-gate: fail)`)
    failSecurityGate()
  }
}

// NEAT graph-impact GitHub Action entrypoint. Extracts the base and head graphs
// of a PR with the NEAT engine, diffs them, computes the blast radius of the
// changed files, and posts a sticky PR comment. Node builtins only — no bundling,
// no install. Never fails the PR check hard (its own errors exit 0); the one
// exception is the opt-in security gate (security-gate: fail).

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  loadGraph,
  diffGraphs,
  renderComment,
  renderVerdict,
  changedNodesForObservedScan,
  changedFileNodeIds,
  changedNodeIds as changedNodeIdsOf,
  formatDivergences,
  observedBreakFrom,
} from './graph.mjs'
import { renderSecurity, securityGateFails } from './security.mjs'

const env = process.env
const TOKEN = env.INPUT_GITHUB_TOKEN || env.GITHUB_TOKEN || ''
const ENGINE = env.INPUT_ENGINE || 'neat.is'
const SCAN_SUBPATH = env.INPUT_SCAN_PATH || ''
const NEAT_API_URL = env.INPUT_NEAT_API_URL || ''
const NEAT_API_TOKEN = env.INPUT_NEAT_API_TOKEN || ''
const TONE = env.INPUT_TONE === 'professional' ? 'professional' : 'loud'
const SNIPER_DISPATCH_URL = env.INPUT_SNIPER_DISPATCH_URL || ''
const GRAPH_DIFF_URL = env.INPUT_GRAPH_DIFF_URL || ''
const WORKSPACE = env.GITHUB_WORKSPACE || process.cwd()
const SECURITY = env.INPUT_SECURITY === 'off' ? 'off' : 'on'
const SECURITY_GATE = env.INPUT_SECURITY_GATE === 'fail' ? 'fail' : 'report'

// Headers for a request to the connected NEAT host. When a token is configured —
// a self-hosted daemon exposed over the customer's own network, or the hosted
// plane, both authenticate the /graph/* API — it rides as a bearer; unset (the
// neat-local static tier connects to no host) sends none. Read at call time so
// tests don't fight the module cache, same as the URL.
function apiHeaders() {
  const token = process.env.INPUT_NEAT_API_TOKEN || NEAT_API_TOKEN
  const headers = { Accept: 'application/json', 'User-Agent': 'neat-action' }
  if (token) headers.Authorization = 'Bearer ' + token
  return headers
}

// The fused tier: query a connected NEAT host for declared-vs-observed
// divergences, keep the ones that involve a node this PR changed, and format
// them. Tolerant of the response shape; a host error degrades to the static tier.
export async function fetchDivergences(changedNodeIds) {
  const apiUrl = process.env.INPUT_NEAT_API_URL || NEAT_API_URL
  if (!apiUrl) return []
  try {
    const res = await fetch(apiUrl.replace(/\/+$/, '') + '/graph/divergences', {
      headers: apiHeaders(),
    })
    if (!res.ok) return []
    return formatDivergences(await res.json(), changedNodeIds)
  } catch {
    return []
  }
}

// The observed-break scan: for each node this PR removes or changes, ask the
// connected host what production actually does with it
// (GET /graph/observed-dependencies/:nodeId). A node the OTel layer has *seen*
// (`observed: true`) is one production is live on, so removing or changing it is
// a break. The response carries counts of observed edges — inboundObservedCount
// (callers of the node) and dependencies (the OBSERVED calls it makes) — but no
// request volume and no timestamp, so we surface honest dependent counts and let
// the renderer degrade gracefully. Never fabricate "served N× in 7d." Reads
// INPUT_NEAT_API_URL at call time so tests don't fight the module cache.
export async function fetchObservedBreaks(nodes) {
  const apiUrl = process.env.INPUT_NEAT_API_URL || NEAT_API_URL
  if (!apiUrl || !nodes?.length) return []
  const base = apiUrl.replace(/\/+$/, '')
  const breaks = []
  for (const node of nodes) {
    try {
      const res = await fetch(
        base + '/graph/observed-dependencies/' + encodeURIComponent(node.id),
        { headers: apiHeaders() },
      )
      if (!res.ok) continue
      const found = observedBreakFrom(node, await res.json())
      if (found) breaks.push(found)
    } catch {
      // A host hiccup on one node degrades that node to "no observed break," not
      // the whole run — the static findings still stand.
    }
  }
  return breaks
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

// A path-like engine (a slash, or a .cjs/.js file) runs directly via node — used
// to test with a locally-built engine; a bare package name runs via npx.
function engineCommand(args) {
  if (ENGINE.includes('/') || ENGINE.endsWith('.cjs') || ENGINE.endsWith('.js')) return ['node', [ENGINE, ...args]]
  return ['npx', ['--yes', ENGINE, ...args]]
}

function runEngine(target) {
  const [cmd, args] = engineCommand(['init', target])
  sh(cmd, args, { cwd: target })
}

// Run an engine verb that prints JSON on stdout. Null when the engine doesn't
// have the verb (an older version), fails, or prints something that isn't JSON:
// the caller then falls back rather than failing the PR.
function runEngineJson(args, cwd) {
  try {
    const [cmd, argv] = engineCommand(args)
    return JSON.parse(sh(cmd, argv, { cwd, maxBuffer: 64 * 1024 * 1024 }))
  } catch {
    return null
  }
}

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
  const apiUrl = process.env.INPUT_NEAT_API_URL || NEAT_API_URL
  if (apiUrl) {
    try {
      const res = await fetchImpl(apiUrl.replace(/\/+$/, '') + '/graph/security/reachable-cves', { headers: apiHeaders() })
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

function extractGraph(dir) {
  const target = SCAN_SUBPATH ? path.join(dir, SCAN_SUBPATH) : dir
  if (!existsSync(target)) return null
  try {
    runEngine(target)
  } catch {
    // init can exit non-zero on partial extraction; the snapshot may still exist.
  }
  const gp = path.join(target, 'neat-out', 'graph.json')
  return existsSync(gp) ? loadGraph(gp) : null
}

async function githubApi(method, url, body) {
  const res = await fetch('https://api.github.com' + url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'neat-action',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`GitHub ${method} ${url} → ${res.status}`)
  return res.json()
}

async function postSticky(owner, repo, prNumber, marker, bodyText) {
  const comments = await githubApi(
    'GET',
    `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
  )
  const existing = comments.find((c) => (c.body || '').includes(marker))
  if (existing) {
    await githubApi('PATCH', `/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      body: bodyText,
    })
  } else {
    await githubApi('POST', `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      body: bodyText,
    })
  }
}

async function securityStep(owner, repo, prNumber, baseSha, headSha) {
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
    // The one deliberate failure: security-gate: fail and a reachable known
    // vulnerability this PR introduced. Set the exit code, don't throw, so the
    // graph comment still posts.
    console.error(`neat-action: this PR introduces ${rendered.introduced} reachable known vulnerabilit${rendered.introduced === 1 ? 'y' : 'ies'} (security-gate: fail)`)
    process.exitCode = 1
  }
}

async function main() {
  const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    : {}
  const pr = event.pull_request
  if (!pr) {
    console.log('Not a pull_request event; skipping.')
    return
  }
  const [owner, repo] = (env.GITHUB_REPOSITORY || '/').split('/')
  const baseSha = pr.base?.sha
  const headSha = pr.head?.sha

  let changedPaths = []
  try {
    changedPaths = sh('git', ['diff', '--name-only', `${baseSha}...${headSha}`], { cwd: WORKSPACE })
      .split('\n')
      .filter(Boolean)
  } catch {
    /* shallow checkout — degrade to no blast radius */
  }

  // The security gate runs on its own: a PR whose graph comes back empty still
  // gets checked for the vulnerabilities it pulls in.
  if (SECURITY === 'on') await securityStep(owner, repo, pr.number, baseSha, headSha)

  const head = extractGraph(WORKSPACE)
  if (!head) {
    console.log('NEAT produced no graph for the PR head; nothing to post.')
    return
  }

  let base = null
  const tmp = mkdtempSync(path.join(tmpdir(), 'neat-base-'))
  try {
    sh('git', ['worktree', 'add', '--detach', tmp, baseSha], { cwd: WORKSPACE })
    const baseTarget = SCAN_SUBPATH ? path.join(tmp, SCAN_SUBPATH) : tmp
    // A scan target absent from the base is new in this PR — so everything the
    // head graph carries under it is genuinely *added*, not a failed extraction.
    base = existsSync(baseTarget) ? extractGraph(tmp) : { nodes: new Map(), edges: [] }
  } catch (e) {
    console.log('base extract skipped:', e.message)
  } finally {
    try {
      sh('git', ['worktree', 'remove', '--force', tmp], { cwd: WORKSPACE })
    } catch {
      /* best-effort */
    }
  }

  const delta = base
    ? diffGraphs(base, head)
    : { routesAdded: [], routesRemoved: [], tablesAdded: [], tablesRemoved: [] }
  const changedFiles = changedFileNodeIds(head, changedPaths)
  const changedNodeIds = changedNodeIdsOf(base, head)
  const apiUrl = process.env.INPUT_NEAT_API_URL || NEAT_API_URL
  const connected = Boolean(apiUrl)

  let marker, body
  if (connected) {
    // Fused tier: query the connected host for divergences and observed breaks,
    // then render the verdict-first report.
    const divergences = await fetchDivergences(changedNodeIds)
    const scanNodes = base ? changedNodesForObservedScan(base, head) : []
    const observedBreaks = await fetchObservedBreaks(scanNodes)
    ;({ marker, body } = renderVerdict({
      graph: head,
      delta,
      changedFiles,
      divergences,
      observedBreaks,
      tone: TONE,
      sniperDispatchUrl: SNIPER_DISPATCH_URL,
      graphDiffUrl: GRAPH_DIFF_URL,
    }))
  } else {
    // Static tier: no connected host, so the Action can't see production. Keep
    // the graph-diff + blast-radius comment and nudge toward the OBSERVED layer.
    ;({ marker, body } = renderComment({
      graph: head,
      delta,
      changedFiles,
      divergences: [],
      connected: false,
    }))
  }

  if (!TOKEN) {
    console.log('No github-token; comment preview:\n' + body)
    return
  }
  await postSticky(owner, repo, pr.number, marker, body)
  console.log('Posted NEAT graph-impact comment on PR #' + pr.number)
}

// Run only as the action entrypoint; importable (for tests/harness) without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('neat-action:', e.message)
    // Never fail the PR check on the action's own error; only the opt-in
    // security gate sets a failing exit code.
    process.exit(process.exitCode === 1 ? 1 : 0)
  })
}

// NEAT graph-impact GitHub Action entrypoint. Extracts the base and head graphs
// of a PR with the NEAT engine, diffs them, computes the blast radius of the
// changed files, and posts a sticky PR comment. Node builtins only — no bundling,
// no install. Never fails the PR check hard (its own errors exit 0).

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadGraph, diffGraphs, renderComment } from './graph.mjs'

const env = process.env
const TOKEN = env.INPUT_GITHUB_TOKEN || env.GITHUB_TOKEN || ''
const ENGINE = env.INPUT_ENGINE || 'neat.is'
const SCAN_SUBPATH = env.INPUT_SCAN_PATH || ''
const NEAT_API_URL = env.INPUT_NEAT_API_URL || ''
const WORKSPACE = env.GITHUB_WORKSPACE || process.cwd()

// The fused tier: query a connected NEAT host for declared-vs-observed
// divergences, keep the ones that involve a node this PR changed, and format
// them. Tolerant of the response shape; a host error degrades to the static tier.
export async function fetchDivergences(changedNodeIds) {
  const apiUrl = process.env.INPUT_NEAT_API_URL || NEAT_API_URL
  if (!apiUrl) return []
  try {
    const res = await fetch(apiUrl.replace(/\/+$/, '') + '/graph/divergences', {
      headers: { Accept: 'application/json', 'User-Agent': 'neat-action' },
    })
    if (!res.ok) return []
    const data = await res.json()
    const findings = Array.isArray(data)
      ? data
      : (data.divergences ?? data.findings ?? data.items ?? [])
    const changed = new Set(changedNodeIds)
    const short = (id) => String(id ?? '').split(':').slice(-1)[0]
    return findings
      .filter((f) => changed.has(f.source) || changed.has(f.target) || changed.has(f.nodeId))
      .slice(0, 10)
      .map((f) => {
        const kind = f.kind || f.type || 'divergence'
        const s = short(f.source ?? f.nodeId)
        const t = f.target ? ' → `' + short(f.target) + '`' : ''
        const why = f.reason || f.message || ''
        return `${kind}: \`${s}\`${t}${why ? ' — ' + why : ''}`
      })
  } catch {
    return []
  }
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

// A path-like engine (a slash, or a .cjs/.js file) runs directly via node — used
// to test with a locally-built engine; a bare package name runs via npx.
function runEngine(target) {
  if (ENGINE.includes('/') || ENGINE.endsWith('.cjs') || ENGINE.endsWith('.js')) {
    sh('node', [ENGINE, 'init', target], { cwd: target })
  } else {
    sh('npx', ['--yes', ENGINE, 'init', target], { cwd: target })
  }
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

// Map git's changed paths (repo-relative) to FileNode ids, matching a FileNode's
// service-relative `path` as a suffix so it works in both flat and monorepo repos.
function changedFileNodeIds(graph, changedPaths) {
  const ids = []
  for (const [key, attrs] of graph.nodes) {
    if (attrs.type !== 'FileNode' || !attrs.path) continue
    if (changedPaths.some((c) => c === attrs.path || c.endsWith('/' + attrs.path))) ids.push(key)
  }
  return ids
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
  const changedNodeIds = base
    ? [
        ...[...head.nodes.keys()].filter((k) => !base.nodes.has(k)),
        ...[...base.nodes.keys()].filter((k) => !head.nodes.has(k)),
      ]
    : [...head.nodes.keys()]
  const divergences = NEAT_API_URL ? await fetchDivergences(changedNodeIds) : []
  const { marker, body } = renderComment({
    graph: head,
    delta,
    changedFiles,
    divergences,
    connected: Boolean(NEAT_API_URL),
  })

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
    process.exit(0) // never fail the PR check on the action's own error
  })
}

// The graph-impact step: extract the head and base graphs, diff them, and post
// the graph comment. Verdict-first when a NEAT host is connected (fused tier),
// graph diff plus blast radius otherwise (static tier).

import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GRAPH_DIFF_URL, SCAN_SUBPATH, SNIPER_DISPATCH_URL, TOKEN, TONE, WORKSPACE, apiUrl } from './config.mjs'
import { extractGraph, sh } from './engine.mjs'
import { postSticky } from './github.mjs'
import {
  diffGraphs,
  renderComment,
  renderVerdict,
  changedNodesForObservedScan,
  changedFileNodeIds,
  changedNodeIds as changedNodeIdsOf,
} from './graph.mjs'
import { fetchDivergences, fetchObservedBreaks } from './host.mjs'

export async function graphStep(owner, repo, prNumber, baseSha, changedPaths) {
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
  const connected = Boolean(apiUrl())

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
  await postSticky(owner, repo, prNumber, marker, body)
  console.log('Posted NEAT graph-impact comment on PR #' + prNumber)
}

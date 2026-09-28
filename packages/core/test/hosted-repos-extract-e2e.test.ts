import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MultiDirectedGraph } from 'graphology'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import { runRepoSyncPass, type CloneRepo, type HostedRepoSyncDeps } from '../src/connectors/hosted-repos.js'
import { extractFromDirectory } from '../src/extract.js'
import type { NeatGraph } from '../src/graph.js'

// End-to-end for the hosted "add your repos" leg that until now only lived as a one-off prod proof
// (docs/hosted-web-repo-binding.md: proven on neat-technologies/neat-landing). The daemon's own unit tests
// mock both the clone and the extractor; this exercises the REAL extractor against a real on-disk repo and a
// real graph, so the chain the console + daemon depend on — deliver → clone → EXTRACTED into the graph →
// status synced with real counts — is a durable CI gate, not a manual prod check.
//
// The git transport itself (isomorphic-git in `defaultCloneRepo`) is a thin wrapper the unit tests already
// cover at the seam; here the clone is a fixture-materialiser (populate the dir the daemon hands it), so the
// test stays hermetic — no network, no GitHub App — while everything downstream of a populated clone dir is
// the real code path.

const newGraph = (): NeatGraph => new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })

const deps = (fetchImpl: typeof fetch): HostedRepoSyncDeps => ({
  cpUrl: 'https://cp.example',
  projectId: 'prj_1',
  daemonToken: 'daemon-token',
  fetchImpl,
})

/** A control-plane double: delivers one bound repo, records the status the daemon reports back. */
function cpFetch() {
  const statusPosts: Array<{ owner: string; name: string; body: Record<string, unknown> }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET' && url.endsWith('/repos')) {
      return new Response(
        JSON.stringify([
          {
            owner: 'octo',
            name: 'app',
            defaultBranch: 'main',
            // The daemon's clone is stubbed below, so this URL is never dialed — it only has to look real.
            cloneUrl: 'https://x-access-token:tok-123@github.com/octo/app.git',
            // The CP remembers this repo as `synced` from a past instance (#1215). A fresh instance's graph
            // holds nothing, so the boot pass must re-extract it anyway — that's the case this proves.
            syncStatus: 'synced',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (method === 'POST' && /\/repos\/[^/]+\/[^/]+\/status$/.test(url)) {
      const m = url.match(/\/repos\/([^/]+)\/([^/]+)\/status$/)!
      statusPosts.push({ owner: m[1]!, name: m[2]!, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response('{}', { status: 200 })
    }
    return new Response('unexpected', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, statusPosts }
}

/** Stand in for the git clone: write a tiny but real Node project into the dir the daemon prepared. */
const materializeFixture: CloneRepo = async (_cloneUrl, _ref, destDir) => {
  await writeFile(
    path.join(destDir, 'package.json'),
    JSON.stringify({ name: 'octo-app', version: '1.0.0', main: 'src/index.js' }, null, 2),
  )
  await mkdir(path.join(destDir, 'src'), { recursive: true })
  await writeFile(
    path.join(destDir, 'src', 'math.js'),
    'function add(a, b) {\n  return a + b\n}\nmodule.exports = { add }\n',
  )
  await writeFile(
    path.join(destDir, 'src', 'index.js'),
    "const { add } = require('./math')\nfunction main() {\n  return add(2, 3)\n}\nmodule.exports = { main }\n",
  )
}

describe('hosted repo-sync — real extraction e2e (fresh graph + CP synced → clone → EXTRACTED → synced)', () => {
  it('re-extracts a CP-synced repo into a fresh graph on the boot pass, reporting the real counts (#1215)', async () => {
    const { fetchImpl, statusPosts } = cpFetch()
    const graph = newGraph()
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'neat-repo-e2e-'))
    try {
      const before = graph.order

      await runRepoSyncPass({
        deps: deps(fetchImpl),
        graph,
        project: 'default',
        cloneRepo: materializeFixture,
        // The real extractor — no mock. This is the leg the prod proof covered and CI didn't.
        extract: extractFromDirectory,
        // The boot pass: a fresh instance re-extracts every bound repo regardless of the CP's `synced`.
        forceResync: true,
        tmpRoot,
        now: () => Date.parse('2026-09-24T00:00:00Z'),
      })

      // Real nodes landed in the graph from the cloned repo — this is the EXTRACTED half of the fusion, and
      // the proof of #1215: a CP-`synced` repo is NOT skipped on a fresh instance.
      expect(graph.order).toBeGreaterThan(before)

      // Honest pill: syncing while it ran, then synced with the real counts + injected lastSyncAt.
      expect(statusPosts[0]).toMatchObject({ owner: 'octo', name: 'app', body: { syncStatus: 'syncing' } })
      const terminal = statusPosts.at(-1)!
      expect(terminal).toMatchObject({ owner: 'octo', name: 'app' })
      expect(terminal.body.syncStatus).toBe('synced')
      expect(terminal.body.lastSyncAt).toBe('2026-09-24T00:00:00.000Z')
      // The detail carries the real, non-zero counts the extractor produced (not a hard-coded string).
      expect(String(terminal.body.detail)).toMatch(/extracted [1-9]\d* nodes?, \d+ edges?/)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })
})

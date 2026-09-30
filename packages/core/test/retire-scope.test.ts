import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, GraphNode } from '@neat.is/types'
import { NodeType, Provenance } from '@neat.is/types'

// The retire sweep's reach vs its evidence (#1291, #1294).
//
// `retireExtractedEdgesByMissingFile` walks *every* EXTRACTED edge in the graph
// and drops the ones whose `evidence.file` doesn't resolve under *this pass's*
// scan root. One graph, one root: sound when the graph has a single source and
// the pass is scanning it, which is a local daemon. A hosted daemon has neither
// property —
//
//   * a boot pass runs over `entry.path`, which on a tenant holds no source, so
//     every restored edge fails the existence check (#1291);
//   * each bound repo is cloned to a fresh temp dir and extracted into the same
//     graph, so repo B's pass sweeps repo A's edges (#1294).
//
// These are Coder's three fixtures from #1291, as executable evidence. The third
// is the control: when the pass that sweeps *is* a pass over the source the
// edges came from, the sweep is correct and must stay that way — including for
// files deleted while the instance was down.

const dirs: string[] = []

async function repoDir(name: string, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `neat-${name}-`))
  dirs.push(dir)
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, body, 'utf8')
  }
  return dir
}

/** A one-service repo that emits EXTRACTED call edges from a known relative path. */
function serviceRepo(serviceName: string): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: serviceName, version: '1.0.0' }),
    'server/main.js': [
      "const express = require('express')",
      'const app = express()',
      "app.get('/health', (req, res) => res.send('ok'))",
      "fetch('http://billing.internal/charge')",
      'module.exports = app',
    ].join('\n'),
  }
}

function counts(graph: ReturnType<typeof getGraph>): {
  nodes: number
  edges: number
  extracted: number
  fileNodes: number
} {
  let extracted = 0
  let fileNodes = 0
  graph.forEachEdge((_id, attrs) => {
    if ((attrs as GraphEdge).provenance === Provenance.EXTRACTED) extracted++
  })
  graph.forEachNode((_id, attrs) => {
    if ((attrs as GraphNode).type === NodeType.FileNode) fileNodes++
  })
  return { nodes: graph.order, edges: graph.size, extracted, fileNodes }
}

describe('the retire sweep is scoped to one pass, but reaches the whole graph', () => {
  beforeEach(() => resetGraph())

  it('#1291 — a boot pass over a root with no source retires the whole restored layer', async () => {
    const graph = getGraph()
    const repo = await repoDir('restored', serviceRepo('billing-api'))
    await extractFromDirectory(graph, repo)
    const before = counts(graph)
    expect(before.extracted).toBeGreaterThan(0)
    expect(before.fileNodes).toBeGreaterThan(0)

    // The hosted boot: the snapshot is already loaded, and the pass runs over
    // `entry.path` — which on a tenant holds no source at all.
    const emptyRoot = await repoDir('empty', {})
    const pass = await extractFromDirectory(graph, emptyRoot)
    const after = counts(graph)

    // Documented here as the behaviour on main, so the fix has a baseline to
    // move. Every EXTRACTED edge is gone and the FileNodes went with them.
    expect(pass.ghostsRetired).toBe(before.extracted)
    expect(after.extracted).toBe(0)
    expect(after.fileNodes).toBe(0)
  })

  // #1294 has two halves with different triggers, and a fixture that mixes them
  // proves neither. The retire half needs the repos to differ in relative path
  // (the sweep's existence check is tolerant — it tries every base, so a path
  // that happens to exist in the *other* repo counts as found). The identity
  // half needs them to agree, on both service name and path, which is what
  // "Frontend-Dashboard mirrors the monorepo's package layout" means.

  it('#1294 retire half — repo B\'s pass retires repo A\'s edges when their paths differ', async () => {
    const graph = getGraph()
    const a = await repoDir('repo-a', {
      'package.json': JSON.stringify({ name: 'repo-a-svc', version: '1.0.0' }),
      'src/a-only.js': "fetch('http://billing.internal/charge')",
    })
    await extractFromDirectory(graph, a)
    const afterA = counts(graph)
    expect(afterA.extracted).toBeGreaterThan(0)

    // A different repo, its own clone dir, same graph — what repo-sync does per
    // bound repo.
    const b = await repoDir('repo-b', {
      'package.json': JSON.stringify({ name: 'repo-b-svc', version: '1.0.0' }),
      'src/b-only.js': "fetch('http://audit.internal/log')",
    })
    const pass = await extractFromDirectory(graph, b)

    // A's edges go, because A's files aren't under B's root.
    expect(pass.ghostsRetired).toBe(afterA.extracted)
  })

  it('#1294 identity half — two repos with the same layout mint the same FileNode', async () => {
    const graph = getGraph()
    // Same service name and same relative path in both repos: the id carries
    // neither, so both land on one node.
    const a = await repoDir('mirror-a', serviceRepo('web'))
    await extractFromDirectory(graph, a)
    const afterA = counts(graph)

    const b = await repoDir('mirror-b', serviceRepo('web'))
    await extractFromDirectory(graph, b)
    const afterB = counts(graph)

    // Two repos went in; one file's worth of nodes came out. Nothing
    // distinguishes them, so the second repo's file *is* the first repo's node.
    expect(afterB.fileNodes).toBe(afterA.fileNodes)
    expect(graph.hasNode('file:web:server/main.js')).toBe(true)
  })

  it('control — a pass over the repo its own edges came from retires only what was deleted', async () => {
    const graph = getGraph()
    const full = serviceRepo('kept-svc')
    const repo = await repoDir('kept', { ...full, 'server/gone.js': "fetch('http://audit.internal/log')" })
    await extractFromDirectory(graph, repo)
    const before = counts(graph)

    // Same repo, one file deleted while the instance was down.
    await rm(path.join(repo, 'server', 'gone.js'))
    const pass = await extractFromDirectory(graph, repo)
    const after = counts(graph)

    // Exactly the deleted file's edges, and nothing else. This is the sweep
    // doing its job, and no fix may take it away.
    expect(pass.ghostsRetired).toBeGreaterThan(0)
    expect(after.extracted).toBeGreaterThan(0)
    expect(after.extracted).toBeLessThan(before.extracted)
  })
})

describe('scoping the sweep by source (ADR-233)', () => {
  beforeEach(() => resetGraph())

  it('#1291 — a boot pass over a source-less root leaves the restored layer alone', async () => {
    const graph = getGraph()
    const repo = await repoDir('restored', serviceRepo('billing-api'))
    await extractFromDirectory(graph, repo, { source: 'acme/billing' })
    const before = counts(graph)

    // The same hosted boot as above: snapshot loaded, pass over a path that
    // holds no source. It names the project, not the repo, so none of the
    // restored files are its to retire.
    const emptyRoot = await repoDir('empty', {})
    const pass = await extractFromDirectory(graph, emptyRoot, { source: 'the-project' })
    const after = counts(graph)

    expect(pass.ghostsRetired).toBe(0)
    expect(after.extracted).toBe(before.extracted)
    expect(after.fileNodes).toBe(before.fileNodes)
  })

  it("#1294 — repo B's pass leaves repo A's edges where they are", async () => {
    const graph = getGraph()
    const a = await repoDir('repo-a', {
      'package.json': JSON.stringify({ name: 'repo-a-svc', version: '1.0.0' }),
      'src/a-only.js': "fetch('http://billing.internal/charge')",
    })
    await extractFromDirectory(graph, a, { source: 'acme/repo-a' })
    const afterA = counts(graph)

    const b = await repoDir('repo-b', {
      'package.json': JSON.stringify({ name: 'repo-b-svc', version: '1.0.0' }),
      'src/b-only.js': "fetch('http://audit.internal/log')",
    })
    const pass = await extractFromDirectory(graph, b, { source: 'acme/repo-b' })
    const after = counts(graph)

    expect(pass.ghostsRetired).toBe(0)
    // Both repos' edges are in the graph, which is the whole point of binding
    // two repos to one project.
    expect(after.extracted).toBe(afterA.extracted * 2)
    expect(after.fileNodes).toBe(afterA.fileNodes * 2)
  })

  it('still retires a file deleted from the repo that owns it', async () => {
    // The sweep must keep working inside its own source — a scope that retires
    // nothing is not a fix, it is the sweep turned off.
    const graph = getGraph()
    const full = serviceRepo('kept-svc')
    const repo = await repoDir('kept', { ...full, 'server/gone.js': "fetch('http://audit.internal/log')" })
    await extractFromDirectory(graph, repo, { source: 'acme/kept' })
    const before = counts(graph)

    await rm(path.join(repo, 'server', 'gone.js'))
    const pass = await extractFromDirectory(graph, repo, { source: 'acme/kept' })
    const after = counts(graph)

    expect(pass.ghostsRetired).toBeGreaterThan(0)
    expect(after.extracted).toBeLessThan(before.extracted)
    expect(after.extracted).toBeGreaterThan(0)
  })

  it('leaves a restored file with no source alone, so the bug does not survive its own fix', async () => {
    // The upgrade case. A snapshot written before sources existed carries none,
    // so if unowned files were judged by existence the first repo to sync after
    // an upgrade would sweep every other repo's restored files — exactly #1294,
    // one more time. They are out of scope until a pass claims them.
    const graph = getGraph()
    const restored = await repoDir('legacy', {
      'package.json': JSON.stringify({ name: 'legacy-svc', version: '1.0.0' }),
      'src/legacy.js': "fetch('http://billing.internal/charge')",
    })
    await extractFromDirectory(graph, restored) // no source — a pre-ADR-233 snapshot
    const before = counts(graph)
    expect(before.extracted).toBeGreaterThan(0)

    // A different bound repo syncs first after the upgrade.
    const other = await repoDir('other', {
      'package.json': JSON.stringify({ name: 'other-svc', version: '1.0.0' }),
      'src/other.js': "fetch('http://audit.internal/log')",
    })
    const pass = await extractFromDirectory(graph, other, { source: 'acme/other' })

    expect(pass.ghostsRetired).toBe(0)
    expect(counts(graph).extracted).toBe(before.extracted + 1)
  })

  it('claims a file already in the graph when this pass reads it', async () => {
    // A snapshot restored from before sources existed carries unstamped
    // FileNodes. The first pass that reads one claims it, so the next pass can
    // tell whose it is — without that, an unstamped node is everyone's and the
    // old behaviour never ends.
    const graph = getGraph()
    const repo = await repoDir('claimed', serviceRepo('claimed-svc'))
    await extractFromDirectory(graph, repo)
    const unstamped = graph.getNodeAttributes('file:claimed-svc:server/main.js') as { source?: string }
    expect(unstamped.source).toBeUndefined()

    await extractFromDirectory(graph, repo, { source: 'acme/claimed' })
    const stamped = graph.getNodeAttributes('file:claimed-svc:server/main.js') as { source?: string }
    expect(stamped.source).toBe('acme/claimed')
  })
})

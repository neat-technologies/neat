import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance } from '@neat.is/types'

// #1723: a second repository's extraction retires the first repository's symbol
// CALLS and DEPENDS_ON edges.
//
// When two repos are extracted into one project graph, each with its own source
// (ADR-233), retireExtractedEdgesByMissingFile protected an edge from the sweep only
// when an endpoint was a FileNode whose source differs from the pass's. A
// symbol-grain CALLS (symbol -> symbol) and a service ──DEPENDS_ON──▶ dep edge have
// no FileNode endpoint, so they fell to the existence check against the wrong repo's
// root and were dropped. The fix resolves the owning file from the symbol id, and for
// a service-rooted edge with no file at all infers ownership from the service's own
// files (service-source inference).
//
// The fixtures put each repo's service under its own directory (svc-x, svc-y) with
// distinct file names, so one repo's evidence.file paths do not resolve under the
// other's root, which is what a hosted project with two bound repos looks like. (A
// shared file name would be "found" by the tolerant existence check in the other
// repo, hiding the bug.)

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

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

// A one-service repo under `svcDir/`, with: an intra-repo call (CALLS), an
// exact-pinned dependency so it resolves with no lockfile (DEPENDS_ON + IMPORTS), and
// a Dockerfile (RUNS_ON). The service node and its file give CONTAINS.
function serviceRepo(
  svcDir: string,
  svcName: string,
  dep: string,
  depVersion: string,
  entry: string,
): Record<string, string> {
  return {
    [`${svcDir}/package.json`]: JSON.stringify({ name: svcName, version: '1.0.0', dependencies: { [dep]: depVersion } }),
    [`${svcDir}/${entry}`]: [
      `const lib = require('${dep}')`,
      'function helper(n) { return lib(n) }',
      'function main() { return helper(1) }',
      'module.exports = { main, helper }',
    ].join('\n'),
    [`${svcDir}/Dockerfile`]: ['FROM node:20', 'WORKDIR /app', 'COPY . .', `CMD ["node", "${entry}"]`].join('\n'),
  }
}

function extractedIdsByType(graph: ReturnType<typeof getGraph>): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>()
  graph.forEachEdge((id, attrs) => {
    const e = attrs as GraphEdge
    if (e.provenance !== Provenance.EXTRACTED) return
    const set = by.get(e.type) ?? new Set<string>()
    set.add(id)
    by.set(e.type, set)
  })
  return by
}

function survivors(graph: ReturnType<typeof getGraph>, ids: Set<string>): number {
  let n = 0
  for (const id of ids) if (graph.hasEdge(id)) n++
  return n
}

// Every class the bug touches, including IMPORTS, which the fixture also produces.
const CLASSES = [EdgeType.CALLS, EdgeType.DEPENDS_ON, EdgeType.RUNS_ON, EdgeType.CONTAINS, EdgeType.IMPORTS] as const

describe("#1723: one repo's edges survive another repo's extraction pass", () => {
  beforeEach(() => resetGraph())

  it("keeps X's CALLS, DEPENDS_ON, RUNS_ON, CONTAINS and IMPORTS edges after Y extracts into the same graph", async () => {
    const graph = getGraph()

    const x = await repoDir('repo-x', serviceRepo('svc-x', 'x-svc', 'lodash', '4.17.21', 'index.js'))
    await extractFromDirectory(graph, x, { source: 'acme/x' })
    const xBefore = extractedIdsByType(graph)

    // The fixture must produce every class, or the test proves nothing about it.
    for (const t of CLASSES) {
      expect(xBefore.get(t)?.size ?? 0, `fixture must produce ${t} edges`).toBeGreaterThan(0)
    }

    // A second bound repo, its own clone dir, same graph: what repo-sync does.
    const y = await repoDir('repo-y', serviceRepo('svc-y', 'y-svc', 'express', '4.18.2', 'app.js'))
    await extractFromDirectory(graph, y, { source: 'acme/y' })

    for (const t of CLASSES) {
      const ids = xBefore.get(t)!
      expect(survivors(graph, ids), `${t}: X's edges must survive Y's pass`).toBe(ids.size)
    }
  })

  it("still retires a dependency removed from the repo's own manifest on its next pass", async () => {
    // Service-source inference must not make a dependency immortal inside its own
    // repo: a pass over the repo that owns the service still prunes a dep it no longer
    // declares. Two deps so the manifest still resolves after one is removed.
    const graph = getGraph()
    const withBoth = {
      'svc-x/package.json': JSON.stringify({ name: 'x-svc', version: '1.0.0', dependencies: { lodash: '4.17.21', ms: '2.1.3' } }),
      'svc-x/index.js': ["const _ = require('lodash')", "const ms = require('ms')", 'module.exports = { _, ms }'].join('\n'),
    }
    const x = await repoDir('repo-x', withBoth)
    await extractFromDirectory(graph, x, { source: 'acme/x' })
    const lodashEdge = 'DEPENDS_ON:service:x-svc->dep:npm:lodash@4.17.21'
    const msEdge = 'DEPENDS_ON:service:x-svc->dep:npm:ms@2.1.3'
    expect(graph.hasEdge(lodashEdge)).toBe(true)
    expect(graph.hasEdge(msEdge)).toBe(true)

    // Remove lodash from the manifest and the code; keep ms. Re-extract on the same source.
    await writeFile(
      path.join(x, 'svc-x', 'package.json'),
      JSON.stringify({ name: 'x-svc', version: '1.0.0', dependencies: { ms: '2.1.3' } }),
      'utf8',
    )
    await writeFile(path.join(x, 'svc-x', 'index.js'), ["const ms = require('ms')", 'module.exports = { ms }'].join('\n'), 'utf8')
    await extractFromDirectory(graph, x, { source: 'acme/x' })

    expect(graph.hasEdge(lodashEdge), 'the removed dependency must be retired').toBe(false)
    expect(graph.hasEdge(msEdge), 'the kept dependency must stay').toBe(true)
  })

  it('a pass with no source behaves exactly as before (the pre-fix sweep)', async () => {
    // With no source the fix is inert: outOfScope returns false immediately, so a
    // second repo's pass retires the first's edges the way it did before ADR-233 and
    // #1723. This pins that the new resolution never activates without a source.
    const graph = getGraph()

    const x = await repoDir('repo-x', serviceRepo('svc-x', 'x-svc', 'lodash', '4.17.21', 'index.js'))
    await extractFromDirectory(graph, x)
    const xBefore = extractedIdsByType(graph)
    expect(xBefore.get(EdgeType.CALLS)!.size).toBeGreaterThan(0)

    const y = await repoDir('repo-y', serviceRepo('svc-y', 'y-svc', 'express', '4.18.2', 'app.js'))
    await extractFromDirectory(graph, y)

    // The symbol edges with no FileNode endpoint are swept, as before the fix.
    expect(survivors(graph, xBefore.get(EdgeType.CALLS)!)).toBe(0)
    expect(survivors(graph, xBefore.get(EdgeType.DEPENDS_ON)!)).toBe(0)
  })
})

// Ref views (ADR-278, contracts/ref-views.md): building a repository's static
// layer at one git state, and composing the view a `?ref=` read is answered from.
//
// A static layer is `extractFromDirectory` run into a fresh graph over a checkout
// of exactly the keyed state, scoped by `source` to the repository (ADR-233). The
// graph belongs to no project, so nothing that serves or persists a project can
// reach it.
//
// A view is a copy: the ref's static layer, plus the live static layers of the
// project's other repositories, plus the live runtime layer. Ownership is read
// from `declaredBy` (static-extraction.md): a live static element is left out
// only when the ref's repository is its sole recorded declarer and the ref lacks
// it. An element with no recorded declarer is unknown, is treated as someone
// else's, and stays. A runtime edge shows only while both its endpoints are in
// the view, and the ones left out are counted.
//
// Every graph write here lands on a graph this module made. The live graph and a
// built layer are only read.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import git from 'isomorphic-git'
import { Provenance, type GraphEdge, type GraphNode, type RefBlock } from '@neat.is/types'
import { makeGraph, type NeatGraph } from '../graph.js'
import {
  commitKey,
  mutationCount,
  parseRefKey,
  type RefLayerEntry,
  type RefRegistry,
  type StaticLayer,
} from '../ref-registry.js'
import { defaultCloneCommit, scrubCloneToken, type CloneCommit } from '../connectors/hosted-repos.js'
import { preserveRuntimeAttributes } from './candidate-stage.js'
import { extractFromDirectory } from './index.js'
import { readSourceBaselines, type SourceBaseline } from './source-baseline.js'

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

// ── building a static layer (ref-views.md §4) ────────────────────────────────

/** Writes the tree of commit `sha` into `destDir`. */
export type CheckoutCommit = (scanPath: string, sha: string, destDir: string) => Promise<void>

// Where a checkout keeps its git objects. A linked worktree has a `.git` file
// naming its own gitdir, and its objects live in the main repository's common dir.
async function gitDirOf(repoRoot: string): Promise<string> {
  const dotGit = path.join(repoRoot, '.git')
  if ((await fs.stat(dotGit)).isDirectory()) return dotGit
  const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8'))
  if (!pointer) throw new Error(`${dotGit} is not a git directory or a gitdir pointer`)
  const own = path.resolve(repoRoot, pointer[1]!.trim())
  try {
    return path.resolve(own, (await fs.readFile(path.join(own, 'commondir'), 'utf8')).trim())
  } catch {
    return own
  }
}

const SYMLINK_MODE = 0o120000

/**
 * The local checkout: the tree of `sha` under the project's scan path, written
 * from the repository's own object store into `destDir`. It reads git and never
 * touches the working tree or the index, so a dirty checkout is left as it is
 * and the layer is the commit and nothing else.
 */
export const checkoutLocalCommit: CheckoutCommit = async (scanPath, sha, destDir) => {
  const root = path.resolve(scanPath)
  const repoRoot = await git.findRoot({ fs, filepath: root })
  const gitdir = await gitDirOf(repoRoot)
  // A sha the repository does not hold fails here, before anything is written.
  await git.readCommit({ fs, gitdir, oid: sha })
  const subdir = path.relative(repoRoot, root)
  const prefix = subdir ? `${subdir.split(path.sep).join('/')}/` : ''
  await fs.mkdir(destDir, { recursive: true })
  await git.walk({
    fs,
    gitdir,
    trees: [git.TREE({ ref: sha })],
    map: async (filepath, [entry]) => {
      if (!entry || filepath === '.') return true
      // Descend only into the scan root's own subtree.
      if (prefix && !`${filepath}/`.startsWith(prefix) && !prefix.startsWith(`${filepath}/`)) return null
      if ((await entry.type()) !== 'blob') return true
      if (prefix && !filepath.startsWith(prefix)) return null
      const content = await entry.content()
      if (!content) return null
      const dest = path.join(destDir, ...filepath.slice(prefix.length).split('/'))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      if ((await entry.mode()) === SYMLINK_MODE) {
        await fs.symlink(Buffer.from(content).toString('utf8'), dest)
      } else {
        await fs.writeFile(dest, content)
      }
      return null
    },
  })
}

export interface BuildLayerDeps {
  /** Test seam: the extractor (defaults to extractFromDirectory). */
  extract?: typeof extractFromDirectory
  /** Test seam: the hosted single-commit clone (defaults to isomorphic-git). */
  cloneCommit?: CloneCommit
  /** Test seam: the local checkout (defaults to the repository's object store). */
  checkout?: CheckoutCommit
  /** Root the temporary checkout is made under (default os.tmpdir()). */
  tmpRoot?: string
}

export interface BuildLayerInput {
  repository: string
  sha: string
  /** Local: the project's scan path, a directory inside a git checkout. */
  scanPath?: string
  /** Hosted: the credentialed clone URL, used for the one clone and then gone. */
  cloneUrl?: string
  deps?: BuildLayerDeps
}

/**
 * Build one static layer: check out exactly `sha`, extract it into a fresh
 * graph, and remove the checkout. The checkout takes the name a plain clone
 * would have, so a package.json with no name is the same service at every ref
 * (#1557). Nothing is written but the temporary checkout.
 */
export async function buildStaticLayer(input: BuildLayerInput): Promise<StaticLayer> {
  const deps = input.deps ?? {}
  const extract = deps.extract ?? extractFromDirectory
  if (!input.cloneUrl && !input.scanPath) throw new Error('no clone URL and no scan path to read the commit from')
  const tmp = await fs.mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), 'neat-ref-'))
  try {
    const leaf = input.cloneUrl
      ? input.repository.split('/').pop()!
      : path.basename(path.resolve(input.scanPath!))
    const dir = path.join(tmp, leaf)
    try {
      if (input.cloneUrl) {
        await fs.mkdir(dir, { recursive: true })
        await (deps.cloneCommit ?? defaultCloneCommit)(input.cloneUrl, input.sha, dir)
      } else {
        await (deps.checkout ?? checkoutLocalCommit)(input.scanPath!, input.sha, dir)
      }
    } catch (err) {
      // A clone URL carries a credential, and the message is kept on the entry.
      throw new Error(`checkout failed: ${scrubCloneToken((err as Error).message ?? String(err)).slice(0, 300)}`)
    }
    const graph = makeGraph()
    const result = await extract(graph, dir, {
      source: input.repository,
      announce: false,
      ...(REPOSITORY.test(input.repository)
        ? { sourceCommit: { repository: input.repository, sha: input.sha } }
        : {}),
    })
    return { graph, extractionErrors: result.extractionErrors, skippedFiles: result.skippedFiles }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

export interface RequestLayerInput extends BuildLayerInput {
  project: string
}

/**
 * Ask for the layer of a commit. Returns its entry at once: the build runs
 * behind it, and a second request for the same key shares that build.
 */
export function requestStaticLayer(registry: RefRegistry, input: RequestLayerInput): RefLayerEntry {
  return registry.request(input.project, input.repository, commitKey(input.sha), () => buildStaticLayer(input))
}

// ── composing a view (ref-views.md §3, §4a, §5) ──────────────────────────────

function soleDeclarer(declaredBy: string[] | undefined, repository: string): boolean {
  return declaredBy !== undefined && declaredBy.length === 1 && declaredBy[0] === repository
}

// The declarers of an element both the ref and the live graph hold: the ref's
// own, and every other repository the live graph records.
function mergedDeclarers(ref: string[] | undefined, live: string[] | undefined): string[] | undefined {
  if (!live || live.length === 0) return ref
  const union = new Set([...(ref ?? []), ...live])
  if (ref && union.size === ref.length) return ref
  return [...union].sort()
}

function withoutDeclarer<T extends { declaredBy?: string[] }>(attrs: T, repository: string): T {
  if (!attrs.declaredBy?.includes(repository)) return { ...attrs }
  const { declaredBy, ...rest } = attrs
  const others = declaredBy.filter((s) => s !== repository)
  return (others.length > 0 ? { ...rest, declaredBy: others } : rest) as T
}

export interface ComposeResult {
  graph: NeatGraph
  /** Runtime edges left out because an endpoint is absent at the ref. */
  hiddenRuntimeEdges: number
}

/**
 * Compose the view of `repository` at the state `layer` was built from, over the
 * live graph as it stands now. Synchronous, so the runtime it reads is one state.
 * Neither argument is written.
 */
export function composeView(layer: NeatGraph, live: NeatGraph, repository: string): ComposeResult {
  const view = layer.copy() as NeatGraph

  live.forEachNode((id, liveAttrs) => {
    if (view.hasNode(id)) {
      // Declared at the ref and present live: the ref's declared fields, with
      // the runtime fields the live node carries.
      const refAttrs = view.getNodeAttributes(id)
      let next = preserveRuntimeAttributes(liveAttrs, refAttrs)
      const declaredBy = mergedDeclarers(refAttrs.declaredBy, liveAttrs.declaredBy)
      if (declaredBy !== refAttrs.declaredBy) next = { ...next, declaredBy } as GraphNode
      if (next !== refAttrs) view.replaceNodeAttributes(id, next)
      return
    }
    // The ref lacks it. A runtime-discovered node always shows. A static node
    // leaves only when the ref's repository alone declared it.
    const runtimeDiscovered = (liveAttrs as { discoveredVia?: string }).discoveredVia === 'otel'
    if (!runtimeDiscovered && soleDeclarer(liveAttrs.declaredBy, repository)) return
    if (!view.hasNode(id)) view.addNode(id, withoutDeclarer(liveAttrs, repository))
  })

  let hiddenRuntimeEdges = 0
  live.forEachEdge((key, liveAttrs, source, target) => {
    const runtime = liveAttrs.provenance !== Provenance.EXTRACTED
    if (!runtime) {
      if (view.hasEdge(key)) {
        const refAttrs = view.getEdgeAttributes(key)
        const declaredBy = mergedDeclarers(refAttrs.declaredBy, liveAttrs.declaredBy)
        if (declaredBy !== refAttrs.declaredBy) view.replaceEdgeAttributes(key, { ...refAttrs, declaredBy } as GraphEdge)
        return
      }
      if (soleDeclarer(liveAttrs.declaredBy, repository)) return
      // Another repository's declaration onto a node this ref does not have.
      if (!view.hasNode(source) || !view.hasNode(target)) return
      if (!view.hasEdge(key)) view.addEdgeWithKey(key, source, target, withoutDeclarer(liveAttrs, repository))
      return
    }
    if (!view.hasNode(source) || !view.hasNode(target)) {
      hiddenRuntimeEdges++
      return
    }
    // The runtime layer is the live graph's, so a key the ref also holds reads as live does.
    if (view.hasEdge(key)) view.dropEdge(key)
    view.addEdgeWithKey(key, source, target, { ...liveAttrs })
  })

  return { graph: view, hiddenRuntimeEdges }
}

/** What one request reads: the view, the block its answer carries, and the view's baselines. */
export interface RefView {
  graph: NeatGraph
  ref: RefBlock
  sourceBaselines: SourceBaseline[]
}

// The view's own entry for its repository is the layer's (ref-views.md §5.4). A
// layer whose extraction was incomplete is not evidence of its commit, the same
// rule the live graph's baseline follows.
function layerBaseline(entry: RefLayerEntry): SourceBaseline | undefined {
  if (!REPOSITORY.test(entry.repository)) return undefined
  const state = parseRefKey(entry.key)
  if (!state || entry.status !== 'ready') return { status: 'unavailable', repository: entry.repository }
  return {
    status: 'ready',
    repository: entry.repository,
    sha: state.sha,
    state: state.state,
    ...(state.dirtyDigest ? { dirtyDigest: state.dirtyDigest } : {}),
  }
}

/**
 * The view a request on this layer reads, resolved once at the request's start:
 * the last composed view while the live graph has not changed since, otherwise a
 * fresh compose. The caller holds the returned object for the whole request, so
 * every step reads one runtime state however many times it awaits.
 */
export function resolveView(registry: RefRegistry, entry: RefLayerEntry, live: NeatGraph): RefView {
  const layer = entry.layer
  if (!layer) throw new Error(`ref ${entry.key} has no built layer`)
  registry.touch(entry)
  const mutation = mutationCount(live)
  let view = entry.view
  if (!view || view.live !== live || view.mutation !== mutation) {
    const composed = composeView(layer.graph, live, entry.repository)
    view = { graph: composed.graph, live, mutation, hiddenRuntimeEdges: composed.hiddenRuntimeEdges }
    entry.view = view
  }
  const own = layerBaseline(entry)
  const sourceBaselines = [
    ...readSourceBaselines(live).filter((b) => b.repository !== entry.repository),
    ...(own ? [own] : []),
  ].sort((a, b) => (a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0))
  return {
    graph: view.graph,
    ref: {
      key: entry.key,
      hiddenRuntimeEdges: view.hiddenRuntimeEdges,
      ...(entry.status === 'incomplete'
        ? { extractionErrors: layer.extractionErrors, skippedFiles: layer.skippedFiles }
        : {}),
    },
    sourceBaselines,
  }
}

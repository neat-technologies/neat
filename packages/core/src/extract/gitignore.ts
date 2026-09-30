// `.gitignore`, the way git reads it: the file in every directory from the repo
// root down to the one being walked, with a deeper file able to override a
// shallower one.
//
// Service discovery honoured the root `.gitignore` and file enumeration honoured
// nothing (#1255), so a gitignored directory was skipped when looking for
// services and then walked in full when collecting one service's files. A built
// bundle under an ignored path came into the graph as first-party source, and
// the first anyone knew was a snapshot too large to write (#1254).
//
// Root *and* nested matters for the shape NEAT is usually pointed at: a monorepo
// whose packages carry their own `.gitignore`, and a service directory that sits
// well below the repo root. Walking up to the repo root is what makes an
// ancestor's rules apply to a service nested under it, with no scan-root
// plumbing through `addFiles` → `walkSourceFiles`.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'

/** One `.gitignore`, and the directory its patterns are relative to. */
export interface IgnoreLayer {
  dir: string
  ig: Ignore
}

/** Layers outermost first — the order git resolves them in. */
export type IgnoreChain = readonly IgnoreLayer[]

// One process-lifetime cache of "what does this directory's .gitignore say".
// The walk asks per directory, and a miss is a failed `readFile`; without this
// a deep tree pays that on every descent. `null` records "no file here", which
// is the common answer and worth remembering too.
const LAYER_CACHE = new Map<string, IgnoreLayer | null>()

/** Reset between scans in tests; the cache is keyed by absolute path. */
export function clearIgnoreCache(): void {
  LAYER_CACHE.clear()
}

async function layerFor(dir: string): Promise<IgnoreLayer | null> {
  const cached = LAYER_CACHE.get(dir)
  if (cached !== undefined) return cached
  let layer: IgnoreLayer | null = null
  try {
    const raw = await fs.readFile(path.join(dir, '.gitignore'), 'utf8')
    layer = { dir, ig: ignore().add(raw) }
  } catch {
    layer = null
  }
  LAYER_CACHE.set(dir, layer)
  return layer
}

async function isRepoRoot(dir: string): Promise<boolean> {
  try {
    // `.git` is a directory in a normal clone and a file in a worktree or
    // submodule, so existence is the test, not `isDirectory()`.
    await fs.stat(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * The chain governing `startDir`: every `.gitignore` from the repo root down to
 * it, outermost first.
 *
 * Stops at the directory holding `.git`, or at the filesystem root when there
 * isn't one — a scan of a plain directory still honours whatever `.gitignore`
 * files it contains, and never climbs into a parent project that has nothing to
 * do with it.
 */
export async function loadIgnoreChain(startDir: string): Promise<IgnoreChain> {
  const dirs: string[] = []
  let current = path.resolve(startDir)
  for (;;) {
    dirs.push(current)
    if (await isRepoRoot(current)) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  dirs.reverse() // outermost first
  const layers: IgnoreLayer[] = []
  for (const dir of dirs) {
    const layer = await layerFor(dir)
    if (layer) layers.push(layer)
  }
  return layers
}

/** The chain plus `dir`'s own `.gitignore`, if it has one. */
export async function extendIgnoreChain(chain: IgnoreChain, dir: string): Promise<IgnoreChain> {
  const layer = await layerFor(path.resolve(dir))
  return layer ? [...chain, layer] : chain
}

/**
 * Whether git would ignore this path.
 *
 * Layers are applied outermost first so a deeper `.gitignore` can re-include
 * something an ancestor excluded — `ignore`'s `test()` reports an explicit
 * un-ignore, which a plain boolean `ignores()` cannot. A path outside a layer's
 * directory is not that layer's business and is skipped.
 */
export function isIgnored(chain: IgnoreChain, fullPath: string, isDir: boolean): boolean {
  return decide(chain, fullPath, isDir).ignored
}

/**
 * The verdict, plus the chain that governs this path's subtree.
 *
 * git prunes at the directory: an excluded directory is never descended into, so
 * a pattern like `build/` excludes what's underneath by never looking rather
 * than by matching each file. That distinction is load-bearing once a deeper
 * `.gitignore` re-includes such a directory — git then walks it, and the
 * ancestor's `build/` does not apply to the files inside, because it matches a
 * directory named `build` and not `build/keep.js`. Testing each file against the
 * whole chain independently would re-exclude them and quietly lose the
 * re-include, so a layer that explicitly un-ignores a directory also ends the
 * reach of everything above it for that subtree.
 */
export function decide(
  chain: IgnoreChain,
  fullPath: string,
  isDir: boolean,
): { ignored: boolean; subtree: IgnoreChain } {
  if (chain.length === 0) return { ignored: false, subtree: chain }
  const abs = path.resolve(fullPath)
  let ignored = false
  let unignoredAt = -1
  for (let i = 0; i < chain.length; i++) {
    const layer = chain[i]!
    const rel = path.relative(layer.dir, abs)
    // A path outside this layer's directory is not its business.
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    // Trailing slash so a directory pattern (`dist/`) matches; `ignore`
    // distinguishes the file and directory tests.
    const candidate = rel.split(path.sep).join('/') + (isDir ? '/' : '')
    const result = layer.ig.test(candidate)
    if (result.ignored) ignored = true
    else if (result.unignored) {
      ignored = false
      unignoredAt = i
    }
  }
  return {
    ignored,
    subtree: unignoredAt >= 0 ? chain.slice(unignoredAt) : chain,
  }
}

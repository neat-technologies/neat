import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import git from 'isomorphic-git'
import type { SecurityCard, SecurityDiff, SecurityDiffEntry, ServiceNode } from '@neat.is/types'
import { NodeType } from '@neat.is/types'
import { inventoryFromGraph, loadAdvisorySnapshot, matchAdvisories } from './advisories/index.js'
import type { InventoryItem } from './advisories/index.js'
import { extractFromDirectory } from './extract.js'
import { makeGraph, type NeatGraph } from './graph.js'
import { buildSecurityCards, rankSecurityCards } from './security-card.js'

// scan_diff (security-card.md §6): the known vulnerabilities a change introduced,
// removed and left in place. It is the check behind "the fix removed the CVE and
// introduced none": the PR gate and a remediation run both read it.
//
// Both sides are judged against ONE advisory snapshot, loaded for the union of
// their inventories, so every difference comes from the change, never from the
// feed moving between two scans. The diff itself is pure.

type Side = 'before' | 'after'

const keyOf = (c: SecurityCard) =>
  [c.advisory.id, c.dependency.ecosystem, c.dependency.name, c.service].join('\u0000')

function entry(before: SecurityCard | undefined, after: SecurityCard | undefined): SecurityDiffEntry {
  const c = (after ?? before)!
  return {
    advisoryId: c.advisory.id,
    ecosystem: c.dependency.ecosystem,
    package: c.dependency.name,
    service: c.service,
    before: before ?? null,
    after: after ?? null,
  }
}

// Ranked by the card that matters for the bucket (the after side for what's
// there now, the before side for what went), so the most exposed comes first.
function ordered(entries: SecurityDiffEntry[], side: Side): SecurityDiffEntry[] {
  const pick = (e: SecurityDiffEntry) => (side === 'after' ? (e.after ?? e.before) : (e.before ?? e.after))!
  const rank = new Map(rankSecurityCards(entries.map(pick)).map((c, i) => [c.id, i]))
  return entries.sort((a, b) => rank.get(pick(a).id)! - rank.get(pick(b).id)!)
}

/**
 * The before/after comparison of two sets of cards. An advisory, package and
 * service is one entry whatever the version on each side; with several versions
 * of a package in one service, the most exposed card stands for it.
 *
 * - `introduced`: a finding after (`imported` or above) that wasn't one before,
 *   including a package that was only in the lockfile and is now imported.
 * - `removed`: a finding before that isn't one after, whether the package went,
 *   moved to an unaffected version, or is no longer imported.
 * - `stillPresent`: a finding on both sides.
 * - `context`: matches that are only in the lockfile, appearing or going.
 */
export function diffSecurityCards(before: SecurityCard[], after: SecurityCard[]): Omit<
  SecurityDiff,
  'advisories' | 'asOf' | 'stale' | 'errors' | 'base' | 'head'
> {
  const best = (cards: SecurityCard[]) => {
    const m = new Map<string, SecurityCard>()
    for (const c of rankSecurityCards(cards)) if (!m.has(keyOf(c))) m.set(keyOf(c), c)
    return m
  }
  const b = best(before)
  const a = best(after)
  const finding = (c: SecurityCard | undefined) => !!c && c.reachability.level !== 'present'

  const introduced: SecurityDiffEntry[] = []
  const removed: SecurityDiffEntry[] = []
  const stillPresent: SecurityDiffEntry[] = []
  const ctxIntroduced: SecurityDiffEntry[] = []
  const ctxRemoved: SecurityDiffEntry[] = []
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    const [x, y] = [b.get(key), a.get(key)]
    if (finding(x) && finding(y)) stillPresent.push(entry(x, y))
    else if (finding(y)) introduced.push(entry(x, y))
    else if (finding(x)) removed.push(entry(x, y))
    else if (y && !x) ctxIntroduced.push(entry(x, y))
    else if (x && !y) ctxRemoved.push(entry(x, y))
  }
  return {
    introduced: ordered(introduced, 'after'),
    removed: ordered(removed, 'before'),
    stillPresent: ordered(stillPresent, 'after'),
    context: { introduced: ordered(ctxIntroduced, 'after'), removed: ordered(ctxRemoved, 'before') },
  }
}

export interface ScanDiffOptions {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  // Only this service (its name or its node id).
  service?: string
}

function serviceName(graph: NeatGraph, service: string): string {
  if (graph.hasNode(service)) {
    const node = graph.getNodeAttributes(service) as ServiceNode
    if (node.type === NodeType.ServiceNode) return node.name
  }
  return service
}

/** The comparison of two already-extracted graphs, judged against one snapshot. */
export async function scanDiffGraphs(
  before: NeatGraph,
  after: NeatGraph,
  refs: { base: string; head: string },
  opts: ScanDiffOptions = {},
): Promise<SecurityDiff> {
  const invB = inventoryFromGraph(before)
  const invA = inventoryFromGraph(after)
  const union = new Map<string, InventoryItem>()
  for (const i of [...invB, ...invA]) union.set(i.dependencyId, i)
  const loaded = await loadAdvisorySnapshot([...union.values()], opts)
  const head = {
    advisories: loaded.source,
    stale: loaded.stale,
    errors: loaded.errors,
    base: { ref: refs.base, inventory: invB.length },
    head: { ref: refs.head, inventory: invA.length },
  }
  if (!loaded.snapshot) {
    return { ...head, asOf: null, introduced: [], removed: [], stillPresent: [], context: { introduced: [], removed: [] } }
  }
  const snapshot = loaded.snapshot
  const cardsOf = (graph: NeatGraph, inv: InventoryItem[]) => {
    const want = opts.service ? serviceName(graph, opts.service) : undefined
    return matchAdvisories(inv, snapshot)
      .flatMap((m) => buildSecurityCards(graph, m, snapshot))
      .filter((c) => !want || c.service === want)
  }
  return { ...head, asOf: snapshot.asOf, ...diffSecurityCards(cardsOf(before, invB), cardsOf(after, invA)) }
}

const MAX_BLOB_BYTES = 2 * 1024 * 1024

/**
 * A commit for a ref name, a full or short sha, or either followed by `~N` /
 * `^` (first parents), the forms a PR or an agent writes: `main`, `HEAD~1`,
 * `abc123^`. isomorphic-git resolves names and shas but not the suffixes.
 */
export async function resolveRevision(repoRoot: string, rev: string): Promise<string> {
  const m = /^(.*?)((?:~\d*|\^)*)$/.exec(rev.trim())!
  const name = m[1]!
  const suffix = m[2] ?? ''
  if (!name) throw new Error(`not a revision: ${rev}`)
  let oid = await git.resolveRef({ fs, dir: repoRoot, ref: name }).catch(() => git.expandOid({ fs, dir: repoRoot, oid: name }))
  let back = 0
  for (const step of suffix.match(/~\d*|\^/g) ?? []) back += step === '^' || step === '~' ? 1 : Number(step.slice(1))
  for (let i = 0; i < back; i++) {
    const { commit } = await git.readCommit({ fs, dir: repoRoot, oid })
    const parent = commit.parent[0]
    if (!parent) throw new Error(`${rev}: ${name} has fewer than ${back} ancestors`)
    oid = parent
  }
  return oid
}

/**
 * Write the tree of `ref` under `subdir` of the repository at `repoRoot` into
 * `outDir`, from the local object store (no network). Blobs over 2MB are left
 * out; extraction doesn't read them.
 */
export async function materializeRef(repoRoot: string, ref: string, subdir: string, outDir: string): Promise<void> {
  const oid = await resolveRevision(repoRoot, ref)
  const prefix = subdir ? `${subdir.split(path.sep).join('/')}/` : ''
  await git.walk({
    fs,
    dir: repoRoot,
    trees: [git.TREE({ ref: oid })],
    map: async (filepath, [entry]) => {
      if (!entry || filepath === '.') return true
      // Only descend into the scan root's own subtree.
      if (prefix && !(filepath + '/').startsWith(prefix) && !prefix.startsWith(filepath + '/')) return null
      if ((await entry.type()) !== 'blob') return true
      if (prefix && !filepath.startsWith(prefix)) return null
      const content = await entry.content()
      if (!content || content.byteLength > MAX_BLOB_BYTES) return null
      const dest = path.join(outDir, ...filepath.slice(prefix.length).split('/'))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, content)
      return null
    },
  })
}

/**
 * scan_diff on a local checkout: `base` (a ref or commit) against `head` (a ref
 * or commit, or the working tree when omitted). Each side is extracted into its
 * own scratch graph, never the project's. The scratch copies take the scan
 * root's directory name, so a service named after its directory (a nameless
 * package.json) is the same service on both sides.
 */
export async function scanDiffLocal(
  scanPath: string,
  refs: { base: string; head?: string },
  opts: ScanDiffOptions & { tmpRoot?: string } = {},
): Promise<SecurityDiff> {
  const repoRoot = await git.findRoot({ fs, filepath: path.resolve(scanPath) })
  const subdir = path.relative(repoRoot, path.resolve(scanPath))
  const tmp = await fs.mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), 'neat-scan-diff-'))
  const name = path.basename(path.resolve(scanPath))
  try {
    const baseDir = path.join(tmp, 'base', name)
    await materializeRef(repoRoot, refs.base, subdir, baseDir)
    let headDir = path.resolve(scanPath)
    if (refs.head) {
      headDir = path.join(tmp, 'head', name)
      await materializeRef(repoRoot, refs.head, subdir, headDir)
    }
    const before = makeGraph()
    const after = makeGraph()
    await extractFromDirectory(before, baseDir, { announce: false })
    await extractFromDirectory(after, headDir, { announce: false })
    return await scanDiffGraphs(before, after, { base: refs.base, head: refs.head ?? 'working tree' }, opts)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

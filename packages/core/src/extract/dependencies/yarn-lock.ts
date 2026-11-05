import { parse as parseYaml } from 'yaml'
import type { ServiceManifest } from './npm-lock.js'
import { TreeFold, type ServiceInventory } from './resolved.js'

// yarn.lock, classic (v1) and Berry (v2+) (dependency-inventory.md §3). Both key
// each resolved package by the descriptors (`name@range`) that resolved to it,
// so the walk is: a manifest range → its descriptor → the entry → that entry's
// dependency ranges → their descriptors. Berry also lists the workspaces
// themselves (`name@workspace:path`). Those are first-party code: walked through,
// never counted.

interface YarnEntry {
  name: string
  version: string
  deps: Array<[string, string]>
  workspace: boolean
}

// `"@scope/a@^1.0.0", a@npm:^1.1.0` → ['@scope/a@^1.0.0', 'a@npm:^1.1.0']
function splitDescriptors(header: string): string[] {
  return header
    .split(',')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

function descriptorName(descriptor: string): string {
  const at = descriptor.indexOf('@', descriptor.startsWith('@') ? 1 : 0)
  return at > 0 ? descriptor.slice(0, at) : descriptor
}

function unquote(s: string): string {
  return s.trim().replace(/^"|"$/g, '')
}

export function parseYarnV1(text: string): Map<string, YarnEntry> {
  const out = new Map<string, YarnEntry>()
  let descriptors: string[] = []
  let entry: YarnEntry | null = null
  let section: 'deps' | null = null
  const flush = () => {
    if (entry) for (const d of descriptors) out.set(d, entry)
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!line.startsWith(' ')) {
      flush()
      descriptors = splitDescriptors(line.replace(/:\s*$/, ''))
      entry = { name: descriptorName(descriptors[0] ?? ''), version: '', deps: [], workspace: false }
      section = null
      continue
    }
    if (!entry) continue
    if (/^ {2}\S/.test(line)) {
      const t = line.trim()
      section = t === 'dependencies:' || t === 'optionalDependencies:' ? 'deps' : null
      const v = /^version\s+(.+)$/.exec(t)
      if (v?.[1]) entry.version = unquote(v[1])
      continue
    }
    if (section === 'deps' && /^ {4}\S/.test(line)) {
      const m = /^\s+("?[^"\s]+"?)\s+(.+)$/.exec(line)
      if (m?.[1] && m[2]) entry.deps.push([unquote(m[1]), unquote(m[2])])
    }
  }
  flush()
  return out
}

interface BerryEntry {
  version?: string
  resolution?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export function parseYarnBerry(text: string): Map<string, YarnEntry> {
  const doc = (parseYaml(text) ?? {}) as Record<string, BerryEntry>
  const out = new Map<string, YarnEntry>()
  for (const [header, value] of Object.entries(doc)) {
    if (header === '__metadata' || !value || typeof value !== 'object') continue
    const descriptors = splitDescriptors(header)
    const resolution = value.resolution ?? descriptors[0] ?? ''
    const entry: YarnEntry = {
      name: descriptorName(resolution),
      version: String(value.version ?? ''),
      deps: Object.entries(value.dependencies ?? {}),
      workspace: resolution.includes('@workspace:') || resolution.includes('@link:'),
    }
    for (const d of descriptors) out.set(d, entry)
  }
  return out
}

export function isYarnBerry(text: string): boolean {
  return /^__metadata:/m.test(text)
}

function lookup(entries: Map<string, YarnEntry>, name: string, range: string): YarnEntry | undefined {
  return (
    entries.get(`${name}@${range}`) ??
    entries.get(`${name}@npm:${range}`) ??
    // Berry writes `npm:` into dependency values for aliases; v1 doesn't.
    (range.startsWith('npm:') ? entries.get(`${name}@${range.slice(4)}`) : undefined)
  )
}

/**
 * Resolve one service's tree from its manifest's direct ranges. In yarn v1 a
 * workspace sibling isn't in the lockfile, so a dependency on one resolves to
 * nothing here and its subtree isn't attributed to this service.
 */
export function resolveYarnLock(
  text: string,
  lockPath: string,
  manifest: ServiceManifest,
  opts: { ownsLockfile: boolean } = { ownsLockfile: true },
): ServiceInventory {
  const entries = isYarnBerry(text) ? parseYarnBerry(text) : parseYarnV1(text)
  const fold = new TreeFold('npm')
  const roots: Array<{ name: string; range: string; dev: boolean }> = [
    ...Object.entries(manifest.dependencies ?? {}).map(([name, range]) => ({ name, range, dev: false })),
    ...Object.entries(manifest.optionalDependencies ?? {}).map(([name, range]) => ({ name, range, dev: false })),
    ...Object.entries(manifest.devDependencies ?? {})
      .filter(([n]) => !(manifest.dependencies ?? {})[n])
      .map(([name, range]) => ({ name, range, dev: true })),
  ]
  for (const root of roots) {
    const queue: Array<{ entry: YarnEntry; isDirect: boolean }> = []
    const first = lookup(entries, root.name, root.range)
    if (first) queue.push({ entry: first, isDirect: true })
    const seen = new Set<YarnEntry>()
    while (queue.length > 0) {
      const { entry, isDirect } = queue.shift()!
      if (seen.has(entry)) continue
      seen.add(entry)
      if (!entry.workspace && entry.version) {
        fold.visit(entry.name, entry.version, { direct: root.name, dev: root.dev, isDirect })
      }
      for (const [n, r] of entry.deps) {
        const next = lookup(entries, n, r)
        if (next && !seen.has(next)) queue.push({ entry: next, isDirect: false })
      }
    }
  }
  // Yarn v1 installs and locks peer dependencies without recording the peer edge,
  // so no walk from the manifest reaches them. When the lockfile belongs to this
  // service alone, everything it locks is installed for this service: an entry
  // the walk missed is still present, so it is kept as transitive with no
  // known introducer. A workspace lockfile is shared, so there the missed
  // entries could belong to a sibling and are left out.
  if (opts.ownsLockfile) {
    for (const entry of new Set(entries.values())) {
      if (entry.workspace || !entry.version) continue
      fold.visitUnattributed(entry.name, entry.version)
    }
  }
  return { source: lockPath, resolution: 'complete', dependencies: fold.result() }
}

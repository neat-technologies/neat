import path from 'node:path'
import { TreeFold, type ServiceInventory } from './resolved.js'

// package-lock.json v2/v3 (dependency-inventory.md §3). The `packages` map is
// keyed by install path: "" for the lockfile's root, "node_modules/a",
// "node_modules/a/node_modules/b", and a workspace's own path ("packages/api").
// v1 lockfiles (npm 6) have no `packages` map and are reported as unsupported,
// so the service falls back to exact pins.

interface LockEntry {
  name?: string
  version?: string
  link?: boolean
  resolved?: string
  dev?: boolean
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface PackageLock {
  lockfileVersion?: number
  packages?: Record<string, LockEntry>
}

export interface ServiceManifest {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

// The install path one level up the node_modules chain: "a/node_modules/b" → "a",
// "node_modules/a" → "", "packages/api" → "".
function parentKey(key: string): string {
  const at = key.lastIndexOf('node_modules/')
  if (at <= 0) return ''
  return key.slice(0, at - 1)
}

// Node's resolution algorithm, over lockfile keys: look in the requester's own
// node_modules, then each ancestor's, ending at the root.
function locate(packages: Record<string, LockEntry>, fromKey: string, name: string): string | null {
  let base = fromKey
  for (;;) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${name}`
    if (packages[candidate]) return candidate
    if (base === '') return null
    base = parentKey(base)
  }
}

function nameOf(key: string, entry: LockEntry): string {
  if (entry.name) return entry.name
  const at = key.lastIndexOf('node_modules/')
  return at >= 0 ? key.slice(at + 'node_modules/'.length) : path.posix.basename(key)
}

function childNames(entry: LockEntry): string[] {
  const peers = Object.keys(entry.peerDependencies ?? {}).filter(
    (n) => !entry.peerDependenciesMeta?.[n]?.optional,
  )
  return [
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...peers,
  ]
}

/**
 * Resolve one service's dependency tree from a package-lock.json. `serviceKey`
 * is the service directory relative to the lockfile's directory ("" when they're
 * the same). Returns null when the lockfile can't answer for this service: a v1
 * lockfile, or a workspace the lockfile doesn't list.
 */
export function resolveNpmLock(
  lock: PackageLock,
  lockPath: string,
  serviceKey: string,
  manifest: ServiceManifest,
): ServiceInventory | null {
  const packages = lock.packages
  if (!packages || (lock.lockfileVersion ?? 0) < 2) return null
  if (serviceKey !== '' && !packages[serviceKey]) return null

  const fold = new TreeFold('npm')
  const roots: Array<{ name: string; dev: boolean }> = [
    ...Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, dev: false })),
    ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, dev: false })),
    ...Object.keys(manifest.devDependencies ?? {})
      .filter((n) => !(manifest.dependencies ?? {})[n])
      .map((name) => ({ name, dev: true })),
  ]

  // A workspace link resolves to the linked package's own path. Workspace
  // packages are first-party code, so they aren't dependencies themselves, but
  // what they depend on runs in the service, so the walk goes through them.
  const follow = (key: string): { key: string; entry: LockEntry } | null => {
    const entry = packages[key]
    if (!entry) return null
    if (entry.link && entry.resolved) {
      const target = packages[entry.resolved]
      return target ? { key: entry.resolved, entry: { ...target, link: true } } : null
    }
    return { key, entry }
  }

  for (const root of roots) {
    const start = locate(packages, serviceKey, root.name)
    if (!start) continue
    const queue: Array<{ key: string; isDirect: boolean }> = [{ key: start, isDirect: true }]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const { key, isDirect } = queue.shift()!
      if (seen.has(key)) continue
      seen.add(key)
      const hit = follow(key)
      if (!hit) continue
      const { entry } = hit
      if (!entry.link && entry.version) {
        const changed = fold.visit(nameOf(key, entry), entry.version, {
          direct: root.name,
          dev: root.dev,
          isDirect,
        })
        // Already folded under this root with nothing new to record: its subtree
        // was walked from here before.
        if (!changed && !isDirect) continue
      }
      for (const child of childNames(entry)) {
        const childKey = locate(packages, hit.key, child)
        if (childKey && !seen.has(childKey)) queue.push({ key: childKey, isDirect: false })
      }
    }
  }

  return { source: lockPath, resolution: 'complete', dependencies: fold.result() }
}

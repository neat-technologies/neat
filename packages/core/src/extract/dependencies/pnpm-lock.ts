import path from 'node:path'
import { TreeFold, type ServiceInventory } from './resolved.js'

// pnpm-lock.yaml, lockfile versions 6 and 9 (dependency-inventory.md §3).
//
// `importers` maps each workspace path ("." for the root) to its direct
// dependencies, each `{ specifier, version }`. The tree lives in `snapshots`
// (v9) or `packages` (v6, keys prefixed with "/"), keyed by
// `name@version(peer@x)…`. The peer suffix belongs to the key, so the same version
// installed against two peer sets is two keys and one DependencyNode.
// A `link:` version is a workspace package: first-party code, walked through
// rather than counted.

type DepMap = Record<string, string | { specifier?: string; version: string }>

interface Importer {
  dependencies?: DepMap
  optionalDependencies?: DepMap
  devDependencies?: DepMap
}

interface SnapshotEntry {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface PnpmLock extends Importer {
  lockfileVersion?: string | number
  importers?: Record<string, Importer>
  packages?: Record<string, SnapshotEntry>
  snapshots?: Record<string, SnapshotEntry>
}

function versionRef(v: DepMap[string]): string {
  return typeof v === 'string' ? v : v.version
}

// The snapshot key a dependency reference points at. Usually `name@ref`. An
// alias (`npm:other@1.0.0`, or v9's bare `other@1.0.0`) and a v6 path (`/x@1.0.0`)
// already name the target package.
function snapshotKey(name: string, ref: string): string {
  if (ref.startsWith('/')) return ref.slice(1)
  if (ref.startsWith('npm:')) return ref.slice(4)
  if (/^[^\d]/.test(ref) && ref.includes('@')) return ref
  return `${name}@${ref}`
}

// `@scope/name@1.2.3(peer@1)` → { name: '@scope/name', version: '1.2.3' }.
function parseKey(key: string): { name: string; version: string } | null {
  const at = key.indexOf('@', key.startsWith('@') ? 1 : 0)
  if (at <= 0) return null
  const rest = key.slice(at + 1)
  const paren = rest.indexOf('(')
  const version = paren >= 0 ? rest.slice(0, paren) : rest
  return version ? { name: key.slice(0, at), version } : null
}

function children(entry: SnapshotEntry | Importer): Array<[string, string]> {
  return [
    ...Object.entries(entry.dependencies ?? {}),
    ...Object.entries(entry.optionalDependencies ?? {}),
  ].map(([n, v]) => [n, versionRef(v as DepMap[string])])
}

/**
 * Resolve one service's tree. `importerKey` is the service directory relative to
 * the lockfile's directory ("" for the same directory). Returns null when the
 * lockfile has no importer for the service, or is a version this doesn't read
 * (pnpm 7's v5 format).
 */
export function resolvePnpmLock(lock: PnpmLock, lockPath: string, importerKey: string): ServiceInventory | null {
  const major = Number(String(lock.lockfileVersion ?? '0').split('.')[0])
  if (!(major >= 6)) return null
  const importers: Record<string, Importer> = lock.importers ?? {
    '.': { dependencies: lock.dependencies, optionalDependencies: lock.optionalDependencies, devDependencies: lock.devDependencies },
  }
  const ownKey = importerKey === '' ? '.' : importerKey
  const importer = importers[ownKey]
  if (!importer) return null

  const snapshots: Record<string, SnapshotEntry> = {}
  if (lock.snapshots) Object.assign(snapshots, lock.snapshots)
  else for (const [k, v] of Object.entries(lock.packages ?? {})) snapshots[k.startsWith('/') ? k.slice(1) : k] = v

  const fold = new TreeFold('npm')
  const roots: Array<{ name: string; ref: string; dev: boolean; from: string }> = [
    ...children(importer).map(([name, ref]) => ({ name, ref, dev: false, from: ownKey })),
    ...Object.entries(importer.devDependencies ?? {})
      .filter(([n]) => !(importer.dependencies ?? {})[n])
      .map(([name, v]) => ({ name, ref: versionRef(v), dev: true, from: ownKey })),
  ]

  for (const root of roots) {
    // Work items are either a snapshot key or a linked workspace importer.
    const queue: Array<{ kind: 'pkg'; key: string; isDirect: boolean } | { kind: 'ws'; key: string }> = []
    const enqueueRef = (name: string, ref: string, from: string, isDirect: boolean) => {
      if (ref.startsWith('link:')) {
        const target = path.posix.normalize(path.posix.join(from === '.' ? '' : from, ref.slice(5))) || '.'
        queue.push({ kind: 'ws', key: target })
      } else {
        queue.push({ kind: 'pkg', key: snapshotKey(name, ref), isDirect })
      }
    }
    enqueueRef(root.name, root.ref, root.from, true)
    const seen = new Set<string>()
    while (queue.length > 0) {
      const item = queue.shift()!
      const seenKey = `${item.kind}:${item.key}`
      if (seen.has(seenKey)) continue
      seen.add(seenKey)
      if (item.kind === 'ws') {
        const ws = importers[item.key]
        if (!ws) continue
        for (const [n, r] of children(ws)) enqueueRef(n, r, item.key, false)
        continue
      }
      const parsed = parseKey(item.key)
      if (!parsed) continue
      fold.visit(parsed.name, parsed.version, { direct: root.name, dev: root.dev, isDirect: item.isDirect })
      const entry = snapshots[item.key]
      if (!entry) continue
      for (const [n, r] of children(entry)) enqueueRef(n, r, '.', false)
    }
  }
  return { source: lockPath, resolution: 'complete', dependencies: fold.result() }
}

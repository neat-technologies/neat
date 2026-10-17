import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServiceNode } from '@neat.is/types'
import { serviceId } from '@neat.is/types'
import type { DiscoveredService } from './shared.js'
import { IGNORED_DIRS } from './shared.js'
import { parseGoMod } from './go.js'

// ADR-255 — one Go module, several binaries. A repository like DeathStarBench's
// hotelReservation is a single go.mod with one `cmd/<name>/main.go` per deployed
// service, and its packages under `services/<name>/`. Discovery keys a Go service
// on go.mod, so the whole repository was one service named after the module,
// while each binary reports its own `service.name` at runtime (`frontend`, `geo`).
//
// When a module has two or more `cmd/<name>/main.go`, each becomes a service named
// `<name>`. A Go package is a directory, so ownership is per package directory:
// - a package reachable from exactly one binary's import closure (imports inside
//   this module only) belongs to that binary's service;
// - a package reachable from several binaries, or from none, stays on the module
//   service as shared code, never duplicated;
// - a directory with no Go package of its own (static assets, a config dir)
//   follows its nearest ancestor package directory, else the module.
// Every binary service and the module service keep the module root as `dir`, so
// file ids stay module-relative; each one excludes the files it doesn't own.
// A module with one main (or none) is returned unchanged, so existing repos don't
// move.

interface GoFile {
  abs: string
  dir: string
}

async function listModuleFiles(moduleDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string, isRoot: boolean): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    // A nested go.mod is another module; its files are not this module's.
    if (!isRoot && entries.some((e) => e.isFile() && e.name === 'go.mod')) return
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name === 'vendor' || entry.name.startsWith('.')) continue
        await walk(full, false)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  await walk(moduleDir, true)
  return out
}

const IMPORT_BLOCK = /^\s*import\s*\(([^]*?)^\s*\)/gm
const IMPORT_SINGLE = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm
const IMPORT_LINE = /^\s*(?:[\w.]+\s+)?"([^"]+)"/

// The import paths a Go file names. Only the header matters, and the regexes stop
// at the first match shape, so a string in a function body never reads as one.
export function goImports(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(IMPORT_BLOCK)) {
    for (const line of m[1]!.split(/\r?\n/)) {
      const im = IMPORT_LINE.exec(line.replace(/\/\/.*$/, ''))
      if (im) out.push(im[1]!)
    }
  }
  for (const m of source.matchAll(IMPORT_SINGLE)) out.push(m[1]!)
  return out
}

export async function splitGoBinaries(module: DiscoveredService): Promise<DiscoveredService[]> {
  if (module.node.language !== 'go') return []
  const root = path.resolve(module.dir)
  const mod = parseGoMod(await fs.readFile(path.join(root, 'go.mod'), 'utf8').catch(() => ''))
  if (!mod) return []
  const modulePath = mod.module
  const cmdDir = path.join(root, 'cmd')
  const cmdEntries = await fs.readdir(cmdDir, { withFileTypes: true }).catch(() => [])
  const binaries: string[] = []
  for (const e of cmdEntries) {
    if (!e.isDirectory()) continue
    const main = path.join(cmdDir, e.name, 'main.go')
    if (await fs.stat(main).then((s) => s.isFile()).catch(() => false)) binaries.push(e.name)
  }
  if (binaries.length < 2) return []
  binaries.sort()

  const files = await listModuleFiles(root)
  const goFiles: GoFile[] = files
    .filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
    .map((abs) => ({ abs, dir: path.dirname(abs) }))
  const packageDirs = new Set(goFiles.map((f) => f.dir))

  // package dir → the in-module package dirs it imports.
  const importsOf = new Map<string, Set<string>>()
  const prefix = modulePath + '/'
  for (const f of goFiles) {
    const src = await fs.readFile(f.abs, 'utf8').catch(() => '')
    const set = importsOf.get(f.dir) ?? new Set<string>()
    for (const imp of goImports(src)) {
      if (!imp.startsWith(prefix)) continue
      const dir = path.join(root, ...imp.slice(prefix.length).split('/'))
      if (packageDirs.has(dir)) set.add(dir)
    }
    importsOf.set(f.dir, set)
  }

  // Which binaries reach each package.
  const reachedBy = new Map<string, Set<string>>()
  for (const bin of binaries) {
    const start = path.join(cmdDir, bin)
    const seen = new Set<string>([start])
    const queue = [start]
    while (queue.length > 0) {
      const dir = queue.shift()!
      for (const next of importsOf.get(dir) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    for (const dir of seen) {
      const set = reachedBy.get(dir) ?? new Set<string>()
      set.add(bin)
      reachedBy.set(dir, set)
    }
  }

  // The owning binary of a directory, or null for the module (shared).
  const ownerCache = new Map<string, string | null>()
  function ownerOf(dir: string): string | null {
    const cached = ownerCache.get(dir)
    if (cached !== undefined) return cached
    let owner: string | null
    if (packageDirs.has(dir)) {
      const bins = reachedBy.get(dir)
      owner = bins && bins.size === 1 ? [...bins][0]! : null
    } else if (dir === root || !dir.startsWith(root + path.sep)) {
      owner = null
    } else {
      owner = ownerOf(path.dirname(dir))
    }
    ownerCache.set(dir, owner)
    return owner
  }

  const ownedBy = new Map<string | null, string[]>()
  for (const f of files) {
    const owner = ownerOf(path.dirname(f))
    const list = ownedBy.get(owner) ?? []
    list.push(f)
    ownedBy.set(owner, list)
  }
  const notOwnedBy = (owner: string | null): string[] =>
    [...ownedBy.entries()].filter(([o]) => o !== owner).flatMap(([, fs]) => fs)

  // The module service keeps the shared code; it excludes what a binary owns.
  module.excludeDirs = [...(module.excludeDirs ?? []), ...notOwnedBy(null)]

  return binaries.map((bin) => {
    const node: ServiceNode = { ...module.node, id: serviceId(bin), name: bin }
    return {
      pkg: { ...module.pkg, name: bin },
      dir: module.dir,
      node,
      excludeDirs: notOwnedBy(bin),
    }
  })
}

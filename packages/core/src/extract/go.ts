import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServiceNode } from '@neat.is/types'
import { NodeType, serviceId } from '@neat.is/types'
import type { DiscoveredService, PackageJson } from './shared.js'
import { IGNORED_DIRS } from './shared.js'

export interface GoModule {
  module: string
  goVersion?: string
  dependencies: Record<string, string>
}

export function parseGoMod(source: string): GoModule | null {
  const module = source.match(/^\s*module\s+(\S+)\s*$/m)?.[1]
  if (!module) return null
  const goVersion = source.match(/^\s*go\s+(\S+)\s*$/m)?.[1]
  const dependencies: Record<string, string> = {}
  const block = source.match(/^\s*require\s*\(([^]*?)^\s*\)/m)?.[1] ?? ''
  for (const line of block.split(/\r?\n/)) {
    const m = line.replace(/\/\/.*$/, '').trim().match(/^(\S+)\s+(v\S+)$/)
    if (m) dependencies[m[1]!] = m[2]!
  }
  for (const m of source.matchAll(/^\s*require\s+(\S+)\s+(v\S+)(?:\s*\/\/.*)?$/gm)) {
    dependencies[m[1]!] = m[2]!
  }
  return { module, ...(goVersion ? { goVersion } : {}), dependencies }
}

// The web framework a Go service declares, for the ServiceNode's `framework`
// label — the same package-name → label discipline the JS/Python readers use.
// The go.mod require path carries the major-version suffix (`.../echo/v4`), so
// the versioned and pre-modules module paths both map to one label.
function goFramework(deps: Record<string, string>): string | undefined {
  if (deps['github.com/gin-gonic/gin']) return 'gin'
  if (deps['github.com/labstack/echo/v4'] || deps['github.com/labstack/echo']) return 'echo'
  if (deps['github.com/gofiber/fiber/v2'] || deps['github.com/gofiber/fiber/v3']) return 'fiber'
  if (deps['github.com/go-chi/chi/v5'] || deps['github.com/go-chi/chi']) return 'chi'
  return undefined
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

// golang/dep's lock file: one `[[projects]]` table per dependency, carrying its
// `name` and a `version` (else `branch`, else `revision`). Read for the same
// dependency map a go.mod `require` block gives (ADR-256).
export function parseGopkgLock(source: string): Record<string, string> {
  const deps: Record<string, string> = {}
  for (const block of source.split(/^\s*\[\[(?:projects|constraint)\]\]\s*$/m).slice(1)) {
    const field = (k: string): string | undefined => block.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]+)"`, 'm'))?.[1]
    const name = field('name')
    if (!name) continue
    deps[name] = field('version') ?? field('branch') ?? field('revision') ?? '*'
  }
  return deps
}

// The directories under `root` that hold Go source of their own (a Go package is a
// directory), relative and slash-separated. `vendor/`, nested modules and the
// usual ignored directories are skipped.
async function goPackageDirs(root: string): Promise<string[]> {
  const out = new Set<string>()
  async function walk(current: string, isRoot: boolean): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    if (!isRoot && entries.some((e) => e.isFile() && (e.name === 'go.mod' || e.name === 'Gopkg.toml'))) return
    for (const e of entries) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(full, false)
      } else if (e.isFile() && e.name.endsWith('.go')) {
        out.add(path.relative(root, current).split(path.sep).join('/'))
      }
    }
  }
  await walk(root, true)
  return [...out]
}

// A dep-layout repository names its own import path nowhere in a file. Recover it
// from its own source: an import that ends in one of the repo's package
// directories (`…/services/geo` while `services/geo/` exists) names the module as
// everything before that directory. The prefix most imports agree on wins, which
// keeps a stray coincidental match from deciding it.
export async function inferGoModulePath(root: string): Promise<string | null> {
  const dirs = (await goPackageDirs(root)).filter((d) => d.length > 0)
  if (dirs.length === 0) return null
  const counts = new Map<string, number>()
  for (const dir of dirs) {
    const abs = path.join(root, ...dir.split('/'))
    const entries = await fs.readdir(abs).catch(() => [] as string[])
    for (const f of entries) {
      if (!f.endsWith('.go')) continue
      const src = await fs.readFile(path.join(abs, f), 'utf8').catch(() => '')
      for (const imp of goImports(src)) {
        for (const d of dirs) {
          if (!imp.endsWith('/' + d)) continue
          const prefix = imp.slice(0, imp.length - d.length - 1)
          if (prefix.length > 0) counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
        }
      }
    }
  }
  let best: string | null = null
  let bestCount = 0
  for (const [prefix, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (n > bestCount) {
      best = prefix
      bestCount = n
    }
  }
  return best
}

// The Go module rooted at `dir`: from go.mod, else from golang/dep's
// `Gopkg.toml` / `Gopkg.lock` (ADR-256), whose import path is inferred from the
// repo's own imports, falling back to the directory name.
export async function readGoModule(dir: string): Promise<GoModule | null> {
  const goMod = await fs.readFile(path.join(dir, 'go.mod'), 'utf8').catch(() => null)
  if (goMod !== null) return parseGoMod(goMod)
  const lock = await fs.readFile(path.join(dir, 'Gopkg.lock'), 'utf8').catch(() => null)
  const toml = await fs.readFile(path.join(dir, 'Gopkg.toml'), 'utf8').catch(() => null)
  if (lock === null && toml === null) return null
  const module = (await inferGoModulePath(dir)) ?? path.basename(path.resolve(dir))
  return { module, dependencies: parseGopkgLock(lock ?? toml ?? '') }
}

export async function discoverGoService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  const mod = await readGoModule(dir)
  if (!mod) return null
  const name = mod.module.split('/').filter(Boolean).pop() ?? mod.module
  const pkg: PackageJson = { name, dependencies: mod.dependencies }
  const framework = goFramework(mod.dependencies)
  const node: ServiceNode = {
    id: serviceId(name),
    type: NodeType.ServiceNode,
    name,
    language: 'go',
    dependencies: mod.dependencies,
    repoPath: path.relative(scanPath, dir),
    ...(framework ? { framework } : {}),
  }
  return { pkg, dir, node }
}

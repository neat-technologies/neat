import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPackageSource } from '../../advisories/fixdiff.js'
import { normalizePypiName } from '../dependencies/resolved.js'
import type { DependencyRef } from './extract.js'

// Finds the installed copy of a dependency version and reads its own source
// (dependency-inventory.md §5). Read-only: nothing is installed, imported or run.
// A copy whose version doesn't match the one asked for is not used, so a symbol
// is never minted for a version from different code.
//
// Installed copies only. Fetching the registry release when nothing is installed
// is the advisory cache's job (advisory-cache.md §4) and lands separately.

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILES = 10_000

export interface LocatedSource {
  // Where the copy was found, for diagnostics. Never written into the graph.
  root: string
  files: Map<string, string>
}

async function readJson(p: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch {
    return null
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

// The directories from `start` up to and including `stop` (or the filesystem
// root when `start` isn't under `stop`).
function ancestors(start: string, stop: string): string[] {
  const out: string[] = []
  const root = path.resolve(stop)
  let dir = path.resolve(start)
  for (;;) {
    out.push(dir)
    if (dir === root || !dir.startsWith(root)) break
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return out
}

// Every package-source file under `root`, keyed by its posix path relative to it.
// Null when the package is too big to read whole: a partial symbol set would read
// as complete.
async function readTree(root: string, keep: (rel: string) => boolean = isPackageSource): Promise<Map<string, string> | null> {
  const files = new Map<string, string>()
  const walk = async (dir: string): Promise<boolean> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return true
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        // A nested node_modules is another package's code.
        if (e.name === 'node_modules' || e.name === '.git') continue
        if (!(await walk(abs))) return false
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join('/')
        if (!keep(rel)) continue
        const st = await fs.stat(abs)
        if (st.size > MAX_FILE_BYTES) continue
        if (files.size >= MAX_FILES) return false
        files.set(rel, await fs.readFile(abs, 'utf8'))
      }
    }
    return true
  }
  return (await walk(root)) ? files : null
}

// ── npm ─────────────────────────────────────────────────────────────────────

async function locateNpm(dep: DependencyRef, searchFrom: string[], scanPath: string): Promise<LocatedSource | null> {
  const seen = new Set<string>()
  for (const start of searchFrom) {
    for (const dir of ancestors(start, scanPath)) {
      const pkgDir = path.join(dir, 'node_modules', ...dep.name.split('/'))
      if (seen.has(pkgDir)) continue
      seen.add(pkgDir)
      const pkg = (await readJson(path.join(pkgDir, 'package.json'))) as { version?: string } | null
      if (pkg?.version !== dep.version) continue
      const files = await readTree(pkgDir)
      return files ? { root: pkgDir, files } : null
    }
  }
  return null
}

// ── PyPI ────────────────────────────────────────────────────────────────────

async function sitePackagesDirs(searchFrom: string[], scanPath: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const venvs: string[] = []
  if (env.VIRTUAL_ENV) venvs.push(env.VIRTUAL_ENV)
  for (const start of searchFrom) {
    for (const dir of ancestors(start, scanPath)) {
      for (const name of ['.venv', 'venv', 'env']) venvs.push(path.join(dir, name))
    }
  }
  const out: string[] = []
  for (const venv of [...new Set(venvs)]) {
    const win = path.join(venv, 'Lib', 'site-packages')
    if (await isDir(win)) out.push(win)
    const lib = path.join(venv, 'lib')
    let entries: string[] = []
    try {
      entries = (await fs.readdir(lib)).filter((n) => /^python\d/.test(n)).sort()
    } catch {
      continue
    }
    for (const py of entries) {
      const sp = path.join(lib, py, 'site-packages')
      if (await isDir(sp)) out.push(sp)
    }
  }
  return out
}

export interface PythonDistribution {
  sitePackages: string
  distInfo: string
}

// The installed `<name>-<version>.dist-info` for a PyPI dependency version.
export async function findPythonDistribution(
  dep: DependencyRef,
  searchFrom: string[],
  scanPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PythonDistribution | null> {
  const want = normalizePypiName(dep.name)
  for (const sp of await sitePackagesDirs(searchFrom, scanPath, env)) {
    let entries: string[]
    try {
      entries = (await fs.readdir(sp)).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      const m = /^(.+)-([^-]+)\.dist-info$/.exec(entry)
      if (!m || normalizePypiName(m[1]!) !== want || m[2] !== dep.version) continue
      return { sitePackages: sp, distInfo: path.join(sp, entry) }
    }
  }
  return null
}

// The files a distribution installed, from its RECORD, package-relative to
// site-packages. Scripts outside site-packages (`../../bin/…`) and the metadata
// directory are left out.
async function recordFiles(dist: PythonDistribution): Promise<string[]> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(dist.distInfo, 'RECORD'), 'utf8')
  } catch {
    return []
  }
  const metaDir = path.basename(dist.distInfo)
  return raw
    .split('\n')
    .map((l) => l.split(',')[0]!.trim())
    .filter((p) => p && !p.startsWith('..') && !p.startsWith('/') && !p.startsWith(`${metaDir}/`))
    .sort()
}

/**
 * The top-level import names a distribution provides (`yaml` for PyYAML, `PIL`
 * for Pillow): its `top_level.txt`, else the first path segment of each module
 * its RECORD lists. Empty when it isn't installed or says nothing.
 */
export async function pythonTopLevelModules(dist: PythonDistribution): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(dist.distInfo, 'top_level.txt'), 'utf8')
    const names = raw.split('\n').map((l) => l.trim()).filter(Boolean)
    if (names.length) return [...new Set(names)].sort()
  } catch {
    // no top_level.txt: fall through to RECORD
  }
  const names = new Set<string>()
  for (const p of await recordFiles(dist)) {
    const head = p.split('/')[0]!
    if (head.endsWith('.data') || head === '__pycache__') continue
    if (p.includes('/')) names.add(head)
    else if (head.endsWith('.py')) names.add(head.slice(0, -3))
  }
  return [...names].sort()
}

async function locatePypi(dep: DependencyRef, searchFrom: string[], scanPath: string, env: NodeJS.ProcessEnv): Promise<LocatedSource | null> {
  const dist = await findPythonDistribution(dep, searchFrom, scanPath, env)
  if (!dist) return null
  const listed = (await recordFiles(dist)).filter(isPackageSource)
  if (listed.length > MAX_FILES) return null
  const files = new Map<string, string>()
  for (const rel of listed) {
    const abs = path.join(dist.sitePackages, ...rel.split('/'))
    try {
      if ((await fs.stat(abs)).size > MAX_FILE_BYTES) continue
      files.set(rel, await fs.readFile(abs, 'utf8'))
    } catch {
      // listed but gone: the install is partial, read what's there
    }
  }
  return { root: dist.distInfo, files }
}

// ── Go ──────────────────────────────────────────────────────────────────────

// The module cache escapes an uppercase letter as `!` plus its lowercase.
function escapeGoModulePath(p: string): string {
  return p.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)
}

function goModCache(env: NodeJS.ProcessEnv): string {
  if (env.GOMODCACHE) return env.GOMODCACHE
  const gopath = (env.GOPATH ?? '').split(path.delimiter).find(Boolean) ?? path.join(os.homedir(), 'go')
  return path.join(gopath, 'pkg', 'mod')
}

async function locateGo(dep: DependencyRef, env: NodeJS.ProcessEnv): Promise<LocatedSource | null> {
  const version = dep.version.startsWith('v') ? dep.version : `v${dep.version}`
  const dir = path.join(goModCache(env), `${escapeGoModulePath(dep.name)}@${version}`)
  if (!(await isDir(dir))) return null
  const files = await readTree(dir)
  return files ? { root: dir, files } : null
}

/**
 * The installed source of one dependency version, or null when no matching copy
 * is installed (or it's too large to read whole). `searchFrom` are the
 * directories of the services that depend on it; the search walks up from each
 * to `scanPath`.
 */
export async function locateInstalledSource(
  dep: DependencyRef,
  searchFrom: string[],
  scanPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocatedSource | null> {
  if (dep.ecosystem === 'npm') return locateNpm(dep, searchFrom, scanPath)
  if (dep.ecosystem === 'PyPI') return locatePypi(dep, searchFrom, scanPath, env)
  if (dep.ecosystem === 'Go') return locateGo(dep, env)
  return null
}

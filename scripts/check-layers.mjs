#!/usr/bin/env node
// The layer check for docs/contracts/substrate.md (#1373). Reads the import graph
// of every package in docs/contracts/layers.json and fails on:
//   - an import cycle between files;
//   - an import that goes up a layer, unless it is on the upward allowlist;
//   - a producer outside ingest importing the ingest.ts barrel, unless allowlisted;
//   - a workspace-package import the package doesn't declare, unless allowlisted;
//   - a source file the map doesn't place;
//   - an allowlist entry whose import no longer exists (the lists only shrink).
// Type-only imports count: moving a type down is cheap, and an exemption is a hole.
// It only reads files; nothing it checks needs editing to run it.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.d\.(ts|mts)$/.test(name)) out.push(full)
  }
  return out
}

// A relative specifier, written with the .js extension ESM wants, resolved to the source file.
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  const stem = base.replace(/\.(m?js|cjs|ts)$/, '')
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Every import, re-export and literal dynamic import in a file, type-only ones included. */
function importsOf(file) {
  const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
  return info.importedFiles.map((f) => f.fileName)
}

export function checkLayers(repo = REPO) {
  const config = JSON.parse(readFileSync(path.join(repo, 'docs/contracts/layers.json'), 'utf8'))
  const rank = config.layers
  const rel = (abs) => path.relative(repo, abs).split(path.sep).join('/')
  const problems = []

  // Which package and layer a repo-relative file belongs to.
  const pkgRoots = Object.keys(config.packages)
  const placeRules = new Map()
  for (const root of pkgRoots) {
    const rules = Object.entries(config.packages[root].map)
      .flatMap(([layer, paths]) => paths.map((p) => ({ p, layer })))
      .sort((a, b) => b.p.length - a.p.length)
    placeRules.set(root, rules)
  }
  const pkgOf = (file) => pkgRoots.find((r) => file.startsWith(`${r}/`))
  const layerOf = (file) => {
    const root = pkgOf(file)
    if (!root) return null
    const inner = file.slice(root.length + 1)
    const hit = placeRules.get(root).find(({ p }) => (p === '' || p.endsWith('/') ? inner.startsWith(p) : inner === p))
    return hit ? hit.layer : null
  }
  const corePkg = Object.entries(config.packages).find(([, c]) => c.name === '@neat.is/core')
  const coreRoot = corePkg?.[0]
  const unitOf = (file) => {
    if (!coreRoot || !file.startsWith(`${coreRoot}/`)) return null
    const inner = file.slice(coreRoot.length + 1)
    for (const [unit, paths] of Object.entries(corePkg[1].producerUnits ?? {})) {
      if (paths.some((p) => (p.endsWith('/') ? inner.startsWith(p) : inner === p))) return unit
    }
    return inner
  }

  // The import graph.
  const edges = new Map()
  const workspaceImports = []
  for (const root of pkgRoots) {
    for (const abs of walk(path.join(repo, root))) {
      const from = rel(abs)
      if (!layerOf(from)) problems.push(`unplaced: ${from} has no layer in docs/contracts/layers.json`)
      const targets = new Set()
      for (const spec of importsOf(abs)) {
        if (spec.startsWith('.')) {
          const hit = resolveRelative(abs, spec)
          if (hit && /\.(ts|tsx|mts)$/.test(hit)) targets.add(rel(hit))
        } else if (spec.startsWith('@neat.is/')) {
          const pkg = spec.split('/').slice(0, 2).join('/')
          const sub = spec.split('/').slice(2).join('/')
          if (pkg === '@neat.is/core' && coreRoot && root !== coreRoot) {
            const hit = resolveRelative(path.join(repo, coreRoot, 'index.ts'), `./${sub || 'index'}.js`)
            if (hit) targets.add(rel(hit))
          }
          if (pkg !== config.packages[root].name) workspaceImports.push({ from, pkg })
        }
      }
      edges.set(from, [...targets])
    }
  }

  // Cycles: strongly connected components of more than one file, or a file importing itself.
  let index = 0
  const idx = new Map(), low = new Map(), onStack = new Set(), stack = []
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++
    stack.push(v); onStack.add(v)
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))) }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)))
    }
    if (low.get(v) === idx.get(v)) {
      const scc = []
      let w
      do { w = stack.pop(); onStack.delete(w); scc.push(w) } while (w !== v)
      if (scc.length > 1 || (edges.get(v) ?? []).includes(v)) problems.push(`cycle: ${scc.sort().join(' <-> ')}`)
    }
  }
  for (const v of edges.keys()) if (!idx.has(v)) strong(v)

  // Upward imports and producer barrel imports.
  const key = (a, b) => `${a} -> ${b}`
  const allowUp = new Set(config.allowlist.upward.map((e) => key(e.from, e.to)))
  const allowBarrel = new Set(config.allowlist.producerBarrel.map((e) => e.from))
  const allowPkg = new Set(config.allowlist.crossPackage.map((e) => key(e.from, e.to)))
  const seenUp = new Set(), seenBarrel = new Set(), seenPkg = new Set()
  const barrel = coreRoot && corePkg[1].producerBarrel ? `${coreRoot}/${corePkg[1].producerBarrel}` : null
  for (const [from, targets] of edges) {
    const a = layerOf(from)
    if (!a) continue
    for (const to of targets) {
      const b = layerOf(to)
      if (!b) continue
      if (rank[a] < rank[b]) {
        if (allowUp.has(key(from, to))) seenUp.add(key(from, to))
        else problems.push(`upward: ${from} (${a}) imports ${to} (${b})`)
      }
      if (to === barrel && a === 'producers' && unitOf(from) !== unitOf(to)) {
        if (allowBarrel.has(from)) seenBarrel.add(from)
        else problems.push(`producer barrel: ${from} imports ${to}; import the helper from ingest/<file> instead`)
      }
    }
  }
  for (const { from, pkg } of workspaceImports) {
    const root = pkgOf(from)
    if ((config.packages[root].allowedWorkspaceImports ?? []).includes(pkg)) continue
    if (allowPkg.has(key(from, pkg))) seenPkg.add(key(from, pkg))
    else problems.push(`cross-package: ${from} imports ${pkg}, which ${config.packages[root].name} does not declare`)
  }

  // The allowlists only shrink: an entry nothing matches any more has to go.
  for (const k of allowUp) if (!seenUp.has(k)) problems.push(`stale allowlist (upward): ${k} no longer exists; remove it`)
  for (const f of allowBarrel) if (!seenBarrel.has(f)) problems.push(`stale allowlist (producerBarrel): ${f} no longer imports the barrel; remove it`)
  for (const k of allowPkg) if (!seenPkg.has(k)) problems.push(`stale allowlist (crossPackage): ${k} no longer exists; remove it`)

  const files = edges.size
  const imports = [...edges.values()].reduce((n, t) => n + t.length, 0)
  return { problems, files, imports }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { problems, files, imports } = checkLayers()
  if (problems.length) {
    console.error(`Layer check failed (docs/contracts/substrate.md), ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(`Layer check passed: ${files} files, ${imports} internal imports, no cycles, no new upward imports.`)
}

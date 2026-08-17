import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServiceNode } from '@neat.is/types'
import { NodeType, serviceId } from '@neat.is/types'
import {
  SERVICE_FILE_EXTENSIONS,
  exists,
  isNeatAuthoredSourceFile,
  type DiscoveredService,
  type PackageJson,
} from './shared.js'
import { hasCsharpProject } from './csharp.js'

// Dockerfile-declared service discovery (ADR-194). Every other `discoverXService`
// keys on a language manifest — package.json, pyproject.toml/requirements.txt,
// go.mod, Gemfile, composer.json. A containerized service that ships none of them
// (a k6 load generator is `Dockerfile` + `script.js` and nothing else) is
// invisible to all of them, so it never becomes a ServiceNode and never reaches
// symbol grain. The Dockerfile is the missing signal: it's an explicit "this
// directory is a deployable service" marker, which is exactly what lets us mint
// here without over-minting on any stray script.
//
// The precision boundary is three ANDs — a Dockerfile, AND top-level source, AND
// no language manifest:
//   - Dockerfile alone (no source)      → not a service. The Dockerfile could be
//                                          a base image or a tooling container.
//   - source alone (no Dockerfile)      → not a service. A loose script isn't a
//                                          deployable unit; the manifest paths
//                                          already cover real projects.
//   - a manifest is present             → the manifest path owns the dir. This
//                                          fallback bails so nothing double-mints.
// Directories the walk already skips (`IGNORED_DIRS`, `.gitignore`) never reach
// this function, so vendored / build-output dirs can't mint either.

// Extension → language tag for a manifest-less service's `language` field. Only
// the extensions the source walker actually reads (`SERVICE_FILE_EXTENSIONS`) map
// to a language; anything else returns null so a `.sh` entrypoint or a `.json`
// data file never counts as source.
function languageForSourceExt(ext: string): string | null {
  switch (ext) {
    case '.py':
      return 'python'
    case '.go':
      return 'go'
    case '.rb':
      return 'ruby'
    case '.php':
      return 'php'
    case '.cs':
      return 'csharp'
    case '.ts':
    case '.tsx':
      return 'typescript'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    default:
      return null
  }
}

// Detection precedence when a dir mixes languages at the top level — the winner
// is the language with the most top-level source files, ties broken by this fixed
// order so a mixed dir resolves to the same language on every pass (idempotency).
const LANGUAGE_PRECEDENCE = ['typescript', 'javascript', 'python', 'go', 'ruby', 'php', 'csharp']

// Infer the service's language from the primary source at the *top level* of the
// dir — not recursively. Top-level-only is the precision knob: it pins discovery
// to a leaf service directory whose own files are the source (the load-generator
// shape), so a repo root that merely has a Dockerfile and subdir services doesn't
// mint a phantom root service off code that belongs to something else. Returns
// null when the dir carries no recognized source, which is the "Dockerfile alone"
// guardrail.
async function inferServiceLanguage(dir: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    // NEAT's own generated bootstrap isn't the user's source.
    if (isNeatAuthoredSourceFile(entry.name)) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!SERVICE_FILE_EXTENSIONS.has(ext)) continue
    const lang = languageForSourceExt(ext)
    if (!lang) continue
    counts.set(lang, (counts.get(lang) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  let best: string | null = null
  let bestCount = -1
  for (const lang of LANGUAGE_PRECEDENCE) {
    const c = counts.get(lang) ?? 0
    if (c > bestCount) {
      best = lang
      bestCount = c
    }
  }
  return best
}

// The language manifests every other discovery path keys on. A dir carrying any
// of them is owned by that path, so the Dockerfile fallback stands down — even a
// nameless package.json counts, so "no language manifest" is read strictly.
async function hasLanguageManifest(dir: string): Promise<boolean> {
  return (
    (await exists(path.join(dir, 'package.json'))) ||
    (await exists(path.join(dir, 'pyproject.toml'))) ||
    (await exists(path.join(dir, 'requirements.txt'))) ||
    (await exists(path.join(dir, 'setup.py'))) ||
    (await exists(path.join(dir, 'go.mod'))) ||
    (await exists(path.join(dir, 'Gemfile'))) ||
    (await exists(path.join(dir, 'composer.json'))) ||
    // C#'s marker is a glob (`*.csproj` / `*.sln`), so it reads the directory
    // rather than probing a fixed filename (ADR-196).
    (await hasCsharpProject(dir))
  )
}

// Cheap predicate the discovery walk uses to decide whether a manifest-less dir
// is a candidate at all. The `Dockerfile` `exists` check gates the readdir, so a
// dir without one pays a single `fs.access` and stops.
export async function hasDockerfileDeclaredService(dir: string): Promise<boolean> {
  if (!(await exists(path.join(dir, 'Dockerfile')))) return false
  return (await inferServiceLanguage(dir)) !== null
}

export async function discoverDockerfileService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  if (!(await exists(path.join(dir, 'Dockerfile')))) return null
  // Manifest wins — the manifest-based paths run before this one in the discovery
  // chain, but bail here too so the rule holds no matter the call order.
  if (await hasLanguageManifest(dir)) return null
  const language = await inferServiceLanguage(dir)
  if (!language) return null
  const name = path.basename(dir)
  const pkg: PackageJson = { name, dependencies: {} }
  const node: ServiceNode = {
    id: serviceId(name),
    type: NodeType.ServiceNode,
    name,
    language,
    dependencies: {},
    repoPath: path.relative(scanPath, dir),
  }
  return { pkg, dir, node }
}

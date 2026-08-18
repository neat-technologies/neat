import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServiceNode } from '@neat.is/types'
import { NodeType, serviceId } from '@neat.is/types'
import { exists, type DiscoveredService, type PackageJson } from './shared.js'

// C++ service discovery (ADR-202), the last of the OpenTelemetry Demo languages.
// Unlike Go/Ruby/Java/Rust, C++ has no single clean dependency manifest that also
// names the service — a directory can build with plain `g++`, a Makefile, Bazel,
// or CMake, and only some of those carry a service name at all. The primary marker
// this reader keys on is CMake's `CMakeLists.txt`: a fixed filename, so it rides the
// same `exists` predicate the Go/Ruby/Java/Rust readers use (not the directory glob
// C# needs, ADR-196), and its `project(<name> …)` directive names the service. The
// otel-demo `currency` service is exactly this shape — a `CMakeLists.txt` with
// `project(currency)` plus `src/server.cpp`.
//
// There is no crate/gem/composer dependency table to lift into the ServiceNode's
// `dependencies` gates — CMake's `find_package` / `target_link_libraries` are the
// nearest analog, but they name build targets, not the versioned packages a route /
// data recognizer would gate on — so `dependencies` is left empty here, the way the
// Dockerfile-declared reader (ADR-194) leaves it empty. A `currency` discovered
// instead via that Dockerfile path still reaches symbol grain: the symbol grain keys
// off the file extension (`.cpp`), not the discovery route.

// The build manifest that marks a C++ service directory. CMake keys on a fixed
// `CMakeLists.txt`, an explicit "this is a buildable project" marker — a filename,
// not a glob.
export const CMAKE_MANIFEST = 'CMakeLists.txt'

// Cheap predicate the discovery walk and the Dockerfile fallback share: does this
// directory carry a `CMakeLists.txt`? A fixed-filename `exists` check, the same
// shape `hasRustManifest` / `hasJavaManifest` use — the C++ marker is a filename,
// not the directory glob C# needs (ADR-196).
export async function hasCppManifest(dir: string): Promise<boolean> {
  return exists(path.join(dir, CMAKE_MANIFEST))
}

// Read the service name out of a `CMakeLists.txt`'s `project(<name> …)` directive.
// CMake's `project()` command always takes the project name as its first argument;
// every optional keyword (`VERSION`, `DESCRIPTION`, `LANGUAGES`, `HOMEPAGE_URL`)
// follows it, so the first token after `project(` is always the name. `#`-to-end-of-
// line comments are stripped first so a commented-out `project()` can't win, and the
// name is matched against a plain identifier character class — a computed name like
// `project(${APP_NAME})` matches nothing and the caller falls back to the directory
// basename. A targeted regex read, not a CMake parser: there is no TOML/JSON to lift,
// and the name is the only field this reader needs.
export function parseCMakeProjectName(source: string): string | undefined {
  const withoutComments = source.replace(/#.*$/gm, '')
  // `project` `(` then optional whitespace/newlines, an optional quote, then the
  // name token. `\s` spans newlines, so a multi-line `project(\n  currency\n …)`
  // still resolves. The character class is CMake's identifier shape plus the `.`/`+`
  // /`-` that appear in real project names; `$`/`{` are excluded so a variable
  // reference fails to match rather than capturing a bogus name.
  const m = withoutComments.match(/\bproject\s*\(\s*"?([A-Za-z0-9_.+-]+)"?/i)
  return m?.[1]
}

export async function discoverCppService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  const cmakePath = path.join(dir, CMAKE_MANIFEST)
  if (!(await exists(cmakePath))) return null

  const source = await fs.readFile(cmakePath, 'utf8').catch(() => '')
  // The `project()` name names the service; a manifest with no usable `project()`
  // name takes the directory basename the Go/Ruby/Java/Rust readers use for
  // name-less manifests.
  const name = parseCMakeProjectName(source)?.trim() || path.basename(dir)

  // No dependency-manifest analog to parse — CMake names build targets, not the
  // versioned packages a later route / data recognizer would gate on.
  const dependencies: Record<string, string> = {}

  const pkg: PackageJson = { name, dependencies }
  const node: ServiceNode = {
    id: serviceId(name),
    type: NodeType.ServiceNode,
    name,
    language: 'cpp',
    dependencies,
    repoPath: path.relative(scanPath, dir),
  }
  return { pkg, dir, node }
}

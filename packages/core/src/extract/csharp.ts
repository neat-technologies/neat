import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServiceNode } from '@neat.is/types'
import { NodeType, serviceId } from '@neat.is/types'
import type { DiscoveredService, PackageJson } from './shared.js'

// C#/.NET service discovery (ADR-196), the MSBuild-project analog of
// extract/ruby.ts's Gemfile reader, extract/php.ts's composer.json reader, and
// extract/go.ts's go.mod reader. A .NET service is a directory that ships an
// MSBuild project — a `*.csproj` — or a solution — a `*.sln`. Unlike the other
// language manifests, the marker is a glob, not a fixed filename: the file is
// named after the assembly (`Cart.csproj`, `Accounting.csproj`), so a directory
// is a service when it holds *any* `.csproj` / `.sln`. The `.csproj` names the
// service (its basename, the assembly name convention); a `.sln`-only directory
// falls back to the directory basename. `PackageReference` items become the
// dependency gates a later route / EF Core recognizer keys on, the way a go.mod
// `require` block or a composer.json `require` does.

export interface Csproj {
  dependencies: Record<string, string>
}

// The MSBuild project extensions that mark a .NET service directory. A `.csproj`
// is a single project; a `.sln` aggregates projects. Either is an explicit
// "this is a .NET service" marker.
const CSHARP_PROJECT_EXTS = new Set(['.csproj', '.sln'])

// List the .NET project markers at the top level of `dir`, sorted so discovery
// picks the same one on every pass (idempotency). One readdir; the glob shape
// (any `*.csproj` / `*.sln`) is why C# can't ride the fixed-filename `exists`
// checks the other manifests use.
async function projectFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (CSHARP_PROJECT_EXTS.has(path.extname(entry.name).toLowerCase())) out.push(entry.name)
  }
  return out.sort()
}

// Cheap predicate the discovery walk and the Dockerfile fallback share: does this
// directory carry a `.csproj` or `.sln`? Keyed on the glob, so it can't be an
// `exists(path.join(dir, 'X'))` the way `hasGoManifest` is.
export async function hasCsharpProject(dir: string): Promise<boolean> {
  return (await projectFiles(dir)).length > 0
}

// Read the `PackageReference` items a `.csproj` declares. A line/regex scan, the
// same discipline go.ts's go.mod reader and ruby.ts's Gemfile reader use for
// polyglot manifest data — not a full MSBuild parse. The version is optional
// (Central Package Management moves it to `Directory.Packages.props`), so a
// reference with only an `Include` registers at ''. `Microsoft.AspNetCore.*` in
// the set is the gate a later ASP.NET route recognizer reads.
export function parseCsproj(source: string): Csproj {
  const dependencies: Record<string, string> = {}
  const re = /<PackageReference\b([^>]*?)\/?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const attrs = m[1] ?? ''
    const include = attrs.match(/\bInclude\s*=\s*"([^"]+)"/)?.[1]
    if (!include) continue
    const version = attrs.match(/\bVersion\s*=\s*"([^"]+)"/)?.[1]
    dependencies[include] = version ?? ''
  }
  return { dependencies }
}

export async function discoverCsharpService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  const projects = await projectFiles(dir)
  if (projects.length === 0) return null

  // The `.csproj` names the service (its basename is the assembly-name
  // convention); a `.sln`-only directory has no single project name, so it takes
  // the directory basename the Go/Ruby/PHP readers use for manifests that name no
  // project.
  const csproj = projects.find((p) => p.toLowerCase().endsWith('.csproj'))
  const name = csproj
    ? path.basename(csproj, path.extname(csproj))
    : path.basename(dir)

  let dependencies: Record<string, string> = {}
  if (csproj) {
    const raw = await fs.readFile(path.join(dir, csproj), 'utf8').catch(() => '')
    dependencies = parseCsproj(raw).dependencies
  }

  const pkg: PackageJson = { name, dependencies }
  const node: ServiceNode = {
    id: serviceId(name),
    type: NodeType.ServiceNode,
    name,
    language: 'csharp',
    dependencies,
    repoPath: path.relative(scanPath, dir),
  }
  return { pkg, dir, node }
}

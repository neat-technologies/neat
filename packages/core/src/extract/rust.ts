import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { ServiceNode } from '@neat.is/types'
import { NodeType, serviceId } from '@neat.is/types'
import { exists, type DiscoveredService, type PackageJson } from './shared.js'

// Rust service discovery (ADR-201), the Cargo analog of extract/go.ts's go.mod
// reader and extract/java.ts's Maven/Gradle reader. A Rust service is a directory
// that ships a `Cargo.toml` — a fixed filename, so it rides the same `exists`
// predicate the Go/Ruby/PHP/Java readers use rather than a directory glob. Cargo's
// `[package] name` names the service; a virtual-workspace manifest (a `[workspace]`
// with no `[package]`) carries no name here, so it falls back to the directory
// basename — the same basename-as-service-name convention the Gemfile and go.mod
// readers use. Declared `[dependencies]` (crate → version) become the gates a later
// Axum / Actix / SQLx recognizer would key on, the way a go.mod `require` block does.
//
// TOML is parsed with `smol-toml`, the same parser extract/python.ts reads
// `pyproject.toml` with and the infra readers read `wrangler.toml` / `railway.toml`
// with — the established manifest-parser for this repo, already a dependency, so no
// hand-rolled scan and no new package (unlike java.ts, which regex-scans XML/Gradle
// because no lightweight parser for those was on hand).

// The build manifest that marks a Rust service directory. Cargo keys on a fixed
// `Cargo.toml`, an explicit "this is a Rust crate" marker — a filename, not a glob.
export const CARGO_MANIFEST = 'Cargo.toml'

export interface CargoManifest {
  // The crate name a `[package] name` declares, if any. A virtual-workspace
  // manifest carries no `[package]`, so this is undefined and discovery uses the dir.
  name?: string
  dependencies: Record<string, string>
}

// The `Cargo.toml` shape this reader looks at — `[package] name` and the flat
// `[dependencies]` table. A dependency's value is either a bare version string
// (`serde = "1.0"`) or an inline table (`tokio = { version = "1", … }`); anything
// else is a path / git source with no version.
interface CargoToml {
  package?: { name?: unknown }
  dependencies?: Record<string, unknown>
}

// Cheap predicate the discovery walk and the Dockerfile fallback share: does this
// directory carry a `Cargo.toml`? A fixed-filename `exists` check, the same shape
// `hasGoManifest` uses (extract/services.ts) — the Rust marker is a filename, not
// the directory glob C# needs (ADR-196).
export async function hasRustManifest(dir: string): Promise<boolean> {
  return exists(path.join(dir, CARGO_MANIFEST))
}

// Read a `Cargo.toml` into the crate name and its declared dependency gates. Each
// `[dependencies]` entry registers as `crate` → version, whether it takes the string
// form or the inline-table form (version '' when the table names a path / git source
// with no version) — the same "which packages does this service pull in" gate a
// go.mod `require` or a composer.json `require` provides. A malformed manifest is
// swallowed to an empty result rather than thrown, so one bad `Cargo.toml` can't
// abort a whole-repo discovery walk (java.ts's `.catch(() => '')` read discipline).
export function parseCargoToml(source: string): CargoManifest {
  const dependencies: Record<string, string> = {}
  let name: string | undefined

  let parsed: CargoToml
  try {
    parsed = parseToml(source) as CargoToml
  } catch {
    return { dependencies }
  }

  if (typeof parsed.package?.name === 'string') name = parsed.package.name

  for (const [crate, spec] of Object.entries(parsed.dependencies ?? {})) {
    if (typeof spec === 'string') {
      dependencies[crate] = spec
    } else if (spec && typeof spec === 'object') {
      const version = (spec as { version?: unknown }).version
      dependencies[crate] = typeof version === 'string' ? version : ''
    } else {
      dependencies[crate] = ''
    }
  }

  return { name, dependencies }
}

export async function discoverRustService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  const cargoPath = path.join(dir, CARGO_MANIFEST)
  if (!(await exists(cargoPath))) return null

  const manifest = parseCargoToml(await fs.readFile(cargoPath, 'utf8').catch(() => ''))

  // The `[package] name` names the service; a virtual-workspace manifest carries no
  // name here, so it takes the directory basename the Go/Ruby/Java readers use for
  // name-less manifests.
  const name = manifest.name?.trim() || path.basename(dir)
  const dependencies = manifest.dependencies

  const pkg: PackageJson = { name, dependencies }
  const node: ServiceNode = {
    id: serviceId(name),
    type: NodeType.ServiceNode,
    name,
    language: 'rust',
    dependencies,
    repoPath: path.relative(scanPath, dir),
  }
  return { pkg, dir, node }
}

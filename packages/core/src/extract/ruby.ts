import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServiceNode } from '@neat.is/types'
import { NodeType, serviceId } from '@neat.is/types'
import type { DiscoveredService, PackageJson } from './shared.js'

// Ruby service discovery (ADR-173), the Gemfile analog of extract/go.ts's
// `go.mod` reader. A Gemfile names no project, so the service takes its
// directory's basename; the `gem` lines become dependency gates the way a
// `go.mod` `require` block does, so the route producer can gate on `rails`.

export interface Gemfile {
  dependencies: Record<string, string>
}

// Read the gems a Gemfile declares. `gem 'rails', '~> 7.1'` → { rails: '~> 7.1' }.
// A version is optional (`gem 'puma'` → ''); a gem with only non-version options
// (`gem 'pg', require: false`) still registers, at ''. Commented lines are
// skipped. This is a line scan, not a Ruby parse — the same discipline go.ts's
// `go.mod` reader and proto.ts's `.proto` scan use for polyglot manifest data.
export function parseGemfile(source: string): Gemfile {
  const dependencies: Record<string, string> = {}
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const m = line.match(/^gem\s+(['"])([^'"]+)\1\s*(?:,\s*(['"])([^'"]+)\3)?/)
    if (!m) continue
    const name = m[2]!
    const version = m[4] && /\d/.test(m[4]) ? m[4] : ''
    dependencies[name] = version
  }
  return { dependencies }
}

export async function discoverRubyService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(dir, 'Gemfile'), 'utf8')
  } catch {
    return null
  }
  const gemfile = parseGemfile(raw)
  const name = path.basename(dir)
  const pkg: PackageJson = { name, dependencies: gemfile.dependencies }
  const node: ServiceNode = {
    id: serviceId(name),
    type: NodeType.ServiceNode,
    name,
    language: 'ruby',
    dependencies: gemfile.dependencies,
    repoPath: path.relative(scanPath, dir),
    ...(gemfile.dependencies['rails'] !== undefined ? { framework: 'rails' } : {}),
  }
  return { pkg, dir, node }
}

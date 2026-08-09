import path from 'node:path'
import type { ServiceNode } from '@neat.is/types'
import { NodeType, serviceId } from '@neat.is/types'
import { readJson, type DiscoveredService, type PackageJson } from './shared.js'

// PHP service discovery (ADR-177), the `composer.json` analog of extract/ruby.ts's
// Gemfile reader and extract/go.ts's `go.mod` reader. A composer.json does name a
// project (`vendor/package`), but we keep the basename-as-service-name convention
// the Gemfile/go.mod readers use so a PHP service sits next to the others without
// a vendor slash in its id; the `require` block becomes the dependency gates the
// route producer reads, so it can gate on `laravel/framework`.

interface ComposerJson {
  name?: string
  require?: Record<string, string>
  'require-dev'?: Record<string, string>
}

export interface Composer {
  dependencies: Record<string, string>
}

// Read the packages a composer.json declares, merging `require` and
// `require-dev` the way the JS reader merges dependencies and devDependencies.
// `laravel/framework` in `require` is the gate the Laravel route recognizer uses.
export function parseComposerJson(composer: ComposerJson): Composer {
  return {
    dependencies: {
      ...(composer.require ?? {}),
      ...(composer['require-dev'] ?? {}),
    },
  }
}

export async function discoverPhpService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  let composer: ComposerJson
  try {
    composer = await readJson<ComposerJson>(path.join(dir, 'composer.json'))
  } catch {
    return null
  }
  const { dependencies } = parseComposerJson(composer)
  const name = path.basename(dir)
  const pkg: PackageJson = { name, dependencies }
  const node: ServiceNode = {
    id: serviceId(name),
    type: NodeType.ServiceNode,
    name,
    language: 'php',
    dependencies,
    repoPath: path.relative(scanPath, dir),
    ...(dependencies['laravel/framework'] !== undefined ? { framework: 'laravel' } : {}),
  }
  return { pkg, dir, node }
}

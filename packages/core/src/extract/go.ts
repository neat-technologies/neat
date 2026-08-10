import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServiceNode } from '@neat.is/types'
import { NodeType, serviceId } from '@neat.is/types'
import type { DiscoveredService, PackageJson } from './shared.js'

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
  return undefined
}

export async function discoverGoService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(dir, 'go.mod'), 'utf8')
  } catch {
    return null
  }
  const mod = parseGoMod(raw)
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

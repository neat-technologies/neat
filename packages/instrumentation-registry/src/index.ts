import semver from 'semver'
import { z } from 'zod'
import registryJson from './registry.json' with { type: 'json' }

const VersionEntryBaseSchema = z.object({
  range: z.string(),
  coverage: z.enum(['bundled', 'first-party', 'third-party', 'http-only', 'gap']),
  notes: z.string(),
})

const VersionEntryInstallSchema = VersionEntryBaseSchema.extend({
  coverage: z.enum(['first-party', 'third-party']),
  instrumentation_package: z.string(),
  package_version: z.string(),
  registration: z.string(),
})

const VersionEntrySchema = z.discriminatedUnion('coverage', [
  VersionEntryInstallSchema,
  VersionEntryBaseSchema.extend({ coverage: z.enum(['bundled', 'http-only', 'gap']) }),
])

export type Coverage = 'bundled' | 'first-party' | 'third-party' | 'http-only' | 'gap'

export interface RegistryEntry {
  library: string
  coverage: Coverage
  instrumentation_package?: string
  package_version?: string
  registration?: string
  notes?: string
}

const RegistrySchema = z.record(z.object({ versions: z.array(VersionEntrySchema) }))

// Validate the seed JSON at module load time — catches malformed entries fast.
const _validated = RegistrySchema.parse(registryJson)

export function resolve(library: string, installedVersion?: string): RegistryEntry | null {
  const entry = (registryJson as Record<string, { versions: Array<Record<string, string>> }>)[library]
  if (!entry) return null
  for (const v of entry.versions) {
    const coerced = installedVersion ? semver.coerce(installedVersion)?.version : undefined
    const matches = !installedVersion || !coerced || semver.satisfies(coerced, v['range'] as string)
    if (matches) {
      return {
        library,
        coverage: v['coverage'] as Coverage,
        instrumentation_package: v['instrumentation_package'],
        package_version: v['package_version'],
        registration: v['registration'],
        notes: v['notes'],
      }
    }
  }
  return null
}

export function list(): RegistryEntry[] {
  return Object.entries(
    registryJson as Record<string, { versions: Array<Record<string, string>> }>,
  ).map(([library, { versions }]) => {
    const first = versions[0]!
    return {
      library,
      coverage: first['coverage'] as Coverage,
      instrumentation_package: first['instrumentation_package'],
      package_version: first['package_version'],
      registration: first['registration'],
      notes: first['notes'],
    }
  })
}

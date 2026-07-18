import path from 'node:path'
import {
  readIfExists,
  parseConnectionString,
  resolveEnvVar,
  schemeToEngine,
  type DbConfig,
} from './shared.js'

// Prisma's schema file declares datasources of the form:
//
//   datasource db {
//     provider = "postgresql"
//     url      = env("DATABASE_URL")
//   }
//
// We match the provider directly. The url is almost always an env() indirection,
// so we resolve the referenced variable from the service's .env to recover the
// real host — that keys the DatabaseNode on the same host the dotenv parser
// mints, so the two fuse to one declared node instead of a placeholder twin
// (ADR-141). Only when the url is a literal, or the env var is absent, do we
// fall back (literal parse, then a deterministic per-service placeholder).
export async function parse(serviceDir: string): Promise<DbConfig[]> {
  const schemaPath = path.join(serviceDir, 'prisma', 'schema.prisma')
  const content = await readIfExists(schemaPath)
  if (!content) return []

  const block = content.match(/datasource\s+\w+\s*\{([^}]*)\}/s)
  if (!block) return []
  const body = block[1] ?? ''

  const providerMatch = body.match(/provider\s*=\s*"([^"]+)"/)
  if (!providerMatch) return []
  const engine = schemeToEngine(providerMatch[1]!)
  if (!engine) return []

  const urlMatch = body.match(/url\s*=\s*"([^"]+)"/)
  if (urlMatch) {
    const config = parseConnectionString(urlMatch[1]!)
    if (config) return [{ ...config, sourceFile: schemaPath }]
  }

  const envMatch = body.match(/url\s*=\s*env\(\s*"([^"]+)"\s*\)/)
  if (envMatch) {
    const resolved = await resolveEnvVar(serviceDir, envMatch[1]!)
    if (resolved) {
      const config = parseConnectionString(resolved)
      if (config) return [{ ...config, sourceFile: schemaPath }]
    }
  }

  return [
    {
      host: `${engine}-prisma`,
      database: '',
      engine,
      engineVersion: 'unknown',
      sourceFile: schemaPath,
    },
  ]
}

export const prismaParser = { name: 'prisma', parse }

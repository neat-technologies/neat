import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface DbConfig {
  host: string
  port?: number
  database: string
  engine: string
  engineVersion: string // "unknown" when not statically determinable
  // Absolute path to the file the parser read this config from. Required —
  // ghost-edge cleanup keys CONNECTS_TO retirement on `evidence.file` per
  // ADR-032 / #140. Parsers that synthesize a DbConfig from a partial
  // source still set this to the file the partial came from.
  sourceFile: string
}

// Map a connection-string scheme to the engine name our compat matrix uses.
// Schemes like "postgres+asyncpg" are normalised by stripping the dialect
// suffix; anything we don't recognise returns null so the parser can decline.
export function schemeToEngine(scheme: string): string | null {
  const s = scheme.toLowerCase().split('+')[0]
  switch (s) {
    case 'postgres':
    case 'postgresql':
      return 'postgresql'
    case 'mysql':
    case 'mariadb':
      return 'mysql'
    case 'mongodb':
    case 'mongodb+srv':
      return 'mongodb'
    case 'redis':
    case 'rediss':
      return 'redis'
    case 'sqlite':
      return 'sqlite'
    default:
      return null
  }
}

// Returns the inner DbConfig fields without sourceFile — every caller spreads
// the parser's own file path on top. Type makes that contract explicit.
export type ParsedConnectionConfig = Omit<DbConfig, 'sourceFile'>

export function parseConnectionString(url: string): ParsedConnectionConfig | null {
  const m = url.match(
    /^(?<scheme>[a-z][a-z+]*):\/\/(?:[^@/]+(?::[^@]*)?@)?(?<host>[^:/?]+)(?::(?<port>\d+))?(?:\/(?<db>[^?#]*))?/i,
  )
  if (!m || !m.groups) return null
  const engine = schemeToEngine(m.groups.scheme!)
  if (!engine) return null
  return {
    host: m.groups.host!,
    port: m.groups.port ? Number(m.groups.port) : undefined,
    database: m.groups.db ?? '',
    engine,
    engineVersion: 'unknown',
  }
}

export async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

// Resolve an env variable an ORM datasource references indirectly — Prisma's
// `url = env("DATABASE_URL")`, Drizzle/Knex reading `process.env.DATABASE_URL`
// — from the service's `.env` files, so the parser can recover the real host
// instead of falling back to a placeholder (ADR-141). Precedence follows the
// dotenv convention: `.env.local` overrides `.env`, then any other `.env.*`.
// Per ADR-016 the value is transient — it only derives the DatabaseNode host and
// never lands in a ConfigNode or the snapshot.
export async function resolveEnvVar(serviceDir: string, name: string): Promise<string | null> {
  const entries = await fs.readdir(serviceDir, { withFileTypes: true }).catch(() => [])
  const envNames = entries
    .filter((e) => e.isFile() && (e.name === '.env' || e.name.startsWith('.env.')))
    .map((e) => e.name)
  const rank = (n: string): number => (n === '.env.local' ? 0 : n === '.env' ? 1 : 2)
  envNames.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  for (const fileName of envNames) {
    const content = await readIfExists(path.join(serviceDir, fileName))
    if (!content) continue
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      if (trimmed.slice(0, eq).trim() !== name) continue
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      return value || null
    }
  }
  return null
}

export async function findFirst(
  serviceDir: string,
  candidates: string[],
): Promise<string | null> {
  for (const rel of candidates) {
    const abs = path.join(serviceDir, rel)
    const content = await readIfExists(abs)
    if (content !== null) return abs
  }
  return null
}

// Engine name from a docker-compose `image:` value like "postgres:15-alpine"
// or "mysql/mysql-server:8.0". Returns the engine + version when both are
// resolvable, or null if the image isn't one we recognise.
export function engineFromImage(
  image: string,
): { engine: string; engineVersion: string } | null {
  const lower = image.toLowerCase()
  const colon = lower.lastIndexOf(':')
  const repo = colon >= 0 ? lower.slice(0, colon) : lower
  const tag = colon >= 0 ? lower.slice(colon + 1) : 'latest'
  const last = repo.split('/').pop() ?? repo
  let engine: string | null = null
  if (last.startsWith('postgres')) engine = 'postgresql'
  else if (last.startsWith('mysql') || last.startsWith('mariadb')) engine = 'mysql'
  else if (last.startsWith('mongo')) engine = 'mongodb'
  else if (last.startsWith('redis')) engine = 'redis'
  else if (last.startsWith('sqlite')) engine = 'sqlite'
  if (!engine) return null
  // Strip everything after the major version digit run; "15-alpine" -> "15".
  const versionMatch = tag.match(/^(\d+(?:\.\d+){0,2})/)
  return {
    engine,
    engineVersion: versionMatch ? versionMatch[1]! : 'unknown',
  }
}

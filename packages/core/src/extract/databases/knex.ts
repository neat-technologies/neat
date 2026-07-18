import {
  findFirst,
  readIfExists,
  parseConnectionString,
  resolveEnvVar,
  type DbConfig,
} from './shared.js'

const CLIENT_TO_ENGINE: Record<string, string> = {
  pg: 'postgresql',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  mysql2: 'mysql',
  sqlite3: 'sqlite',
  'better-sqlite3': 'sqlite',
}

// knexfile.{js,ts} declares a client (one of pg/mysql/sqlite/...) plus a
// connection string or host/port object. We pick whichever shape is in the
// file and ignore environment-driven values we can't resolve statically.
export async function parse(serviceDir: string): Promise<DbConfig[]> {
  const filePath = await findFirst(serviceDir, [
    'knexfile.js',
    'knexfile.ts',
    'knexfile.cjs',
    'knexfile.mjs',
  ])
  if (!filePath) return []
  const content = await readIfExists(filePath)
  if (!content) return []

  const clientMatch = content.match(/client\s*:\s*['"`]([^'"`]+)['"`]/)
  if (!clientMatch) return []
  const engine = CLIENT_TO_ENGINE[clientMatch[1]!.toLowerCase()]
  if (!engine) return []

  const urlMatch = content.match(
    /connection\s*:\s*['"`]([a-z][a-z+]*:\/\/[^'"`]+)['"`]/i,
  )
  if (urlMatch) {
    const config = parseConnectionString(urlMatch[1]!)
    if (config) return [{ ...config, sourceFile: filePath }]
  }

  // `connection: process.env.DATABASE_URL` (bracket form too) — the whole
  // connection is a URL from env. Resolve it from the service's .env so the node
  // keys on the real host and dedups instead of a placeholder (ADR-141, #807).
  // `connection: { host: process.env.DB_HOST }` deliberately does not match — an
  // object of env fields keeps the placeholder rather than a fabricated URL.
  const urlEnvMatch = content.match(
    /connection\s*:\s*process\.env(?:\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/,
  )
  if (urlEnvMatch) {
    const varName = urlEnvMatch[1] ?? urlEnvMatch[2]
    const resolved = varName ? await resolveEnvVar(serviceDir, varName) : null
    const config = resolved ? parseConnectionString(resolved) : null
    if (config) return [{ ...config, sourceFile: filePath }]
  }

  const host = content.match(/host\s*:\s*['"`]([^'"`]+)['"`]/)?.[1]
  if (host) {
    const port = content.match(/port\s*:\s*(\d+)/)?.[1]
    const database = content.match(/database\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? ''
    return [
      {
        host,
        port: port ? Number(port) : undefined,
        database,
        engine,
        engineVersion: 'unknown',
        sourceFile: filePath,
      },
    ]
  }

  return [{ host: `${engine}-knex`, database: '', engine, engineVersion: 'unknown', sourceFile: filePath }]
}

export const knexParser = { name: 'knex', parse }

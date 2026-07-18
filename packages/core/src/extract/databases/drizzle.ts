import {
  findFirst,
  readIfExists,
  parseConnectionString,
  resolveEnvVar,
  schemeToEngine,
  type DbConfig,
} from './shared.js'

const DIALECT_TO_ENGINE: Record<string, string> = {
  postgresql: 'postgresql',
  postgres: 'postgresql',
  pg: 'postgresql',
  mysql: 'mysql',
  mysql2: 'mysql',
  sqlite: 'sqlite',
  'better-sqlite': 'sqlite',
}

// Drizzle's drizzle.config.{ts,js,mjs} declares a `dialect` plus credentials.
// We can't safely eval the file, but the relevant bits are simple key/value
// expressions — regex-extracted to stay sandbox-clean and dep-free.
export async function parse(serviceDir: string): Promise<DbConfig[]> {
  const filePath = await findFirst(serviceDir, [
    'drizzle.config.ts',
    'drizzle.config.js',
    'drizzle.config.mjs',
  ])
  if (!filePath) return []
  const content = await readIfExists(filePath)
  if (!content) return []

  const dialectMatch = content.match(/dialect\s*:\s*['"`]([^'"`]+)['"`]/)
  if (!dialectMatch) return []
  const engine =
    DIALECT_TO_ENGINE[dialectMatch[1]!.toLowerCase()] ?? schemeToEngine(dialectMatch[1]!)
  if (!engine) return []

  const urlMatch = content.match(
    /(?:url|connectionString)\s*:\s*['"`]([a-z][a-z+]*:\/\/[^'"`]+)['"`]/i,
  )
  if (urlMatch) {
    const config = parseConnectionString(urlMatch[1]!)
    if (config) return [{ ...config, sourceFile: filePath }]
  }
  // `url: process.env.DATABASE_URL` (or `connectionString:`, bracket form) — the
  // common env-driven shape. Resolve it from the service's .env so the node keys
  // on the real host and dedups with the dotenv parser instead of a placeholder
  // (ADR-141, #807).
  const urlEnvMatch = content.match(
    /(?:url|connectionString)\s*:\s*process\.env(?:\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/,
  )
  if (urlEnvMatch) {
    const varName = urlEnvMatch[1] ?? urlEnvMatch[2]
    const resolved = varName ? await resolveEnvVar(serviceDir, varName) : null
    const config = resolved ? parseConnectionString(resolved) : null
    if (config) return [{ ...config, sourceFile: filePath }]
  }
  const hostMatch = content.match(/host\s*:\s*['"`]([^'"`]+)['"`]/)
  if (hostMatch) {
    const portMatch = content.match(/port\s*:\s*(\d+)/)
    const dbMatch = content.match(/database\s*:\s*['"`]([^'"`]+)['"`]/)
    return [
      {
        host: hostMatch[1]!,
        port: portMatch ? Number(portMatch[1]) : undefined,
        database: dbMatch?.[1] ?? '',
        engine,
        engineVersion: 'unknown',
        sourceFile: filePath,
      },
    ]
  }
  return [
    { host: `${engine}-drizzle`, database: '', engine, engineVersion: 'unknown', sourceFile: filePath },
  ]
}

export const drizzleParser = { name: 'drizzle', parse }

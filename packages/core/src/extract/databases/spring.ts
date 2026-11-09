import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseAllDocuments } from 'yaml'
import { parseConnectionString, resolveEnvVar, type DbConfig } from './shared.js'

// Spring Boot datasources — the connection axis of Java, the sibling of
// csharp.ts here and of calls/jpa.ts (the table axis). A Spring service names
// its store in `application.yml` / `application.properties`:
//
//   spring:
//     datasource:
//       url: jdbc:mysql://${ORDER_MYSQL_HOST:ts-order-mysql}:${ORDER_MYSQL_PORT:3306}/ts
//
// The keys read are `spring.datasource.url` and `spring.r2dbc.url` (a JDBC /
// R2DBC URL, whose `jdbc:` / `r2dbc:` prefix is dropped before the usual
// connection-string parse) and `spring.data.mongodb.uri`. A `${NAME:default}`
// placeholder resolves from the service's `.env` when it sets NAME, else to its
// default — the value the app runs with when the deployment sets nothing. A
// placeholder with neither leaves the URL unresolved, and nothing is minted.
//
// Only the default profile is read: a document activated by a profile
// (`spring.config.activate.on-profile`, or the older `spring.profiles`) says
// where the app points under that profile, not by default.

const CONFIG_FILES = ['application.yml', 'application.yaml', 'application.properties']
const URL_KEYS = ['spring.datasource.url', 'spring.r2dbc.url', 'spring.data.mongodb.uri']

// A key from a YAML document, nested (`spring: datasource: url:`) or written
// flat (`spring.datasource.url:`), or any mix of the two.
function yamlValue(doc: unknown, key: string): unknown {
  if (!doc || typeof doc !== 'object') return undefined
  const obj = doc as Record<string, unknown>
  if (key in obj) return obj[key]
  const parts = key.split('.')
  for (let i = 1; i < parts.length; i++) {
    const head = parts.slice(0, i).join('.')
    if (head in obj) {
      const v = yamlValue(obj[head], parts.slice(i).join('.'))
      if (v !== undefined) return v
    }
  }
  return undefined
}

function isProfileDocument(doc: unknown): boolean {
  return (
    yamlValue(doc, 'spring.config.activate.on-profile') !== undefined ||
    yamlValue(doc, 'spring.profiles') !== undefined
  )
}

function urlsFromYaml(text: string): string[] {
  const out: string[] = []
  for (const d of parseAllDocuments(text)) {
    if (d.errors.length > 0) continue
    const doc = d.toJS() as unknown
    if (isProfileDocument(doc)) continue
    for (const key of URL_KEYS) {
      const v = yamlValue(doc, key)
      if (typeof v === 'string' && v.trim()) out.push(v.trim())
    }
  }
  return out
}

function urlsFromProperties(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line)
    if (m && URL_KEYS.includes(m[1]!) && m[2]!.trim()) out.push(m[2]!.trim())
  }
  return out
}

// `${NAME:default}` / `${NAME}` → the .env value, else the default; null when a
// placeholder has neither.
async function resolvePlaceholders(serviceDir: string, value: string): Promise<string | null> {
  let out = ''
  let last = 0
  const re = /\$\{([^}:]+)(?::([^}]*))?\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    out += value.slice(last, m.index)
    const fromEnv = await resolveEnvVar(serviceDir, m[1]!)
    const resolved = fromEnv ?? m[2]
    if (resolved === undefined) return null
    out += resolved
    last = m.index + m[0].length
  }
  return out + value.slice(last)
}

export async function parse(serviceDir: string): Promise<DbConfig[]> {
  const out: DbConfig[] = []
  for (const dir of [path.join(serviceDir, 'src', 'main', 'resources'), serviceDir]) {
    for (const name of CONFIG_FILES) {
      const file = path.join(dir, name)
      const text = await fs.readFile(file, 'utf8').catch(() => null)
      if (text === null) continue
      // A malformed config file yields nothing rather than failing the pass (ADR-055).
      try {
        const urls = name.endsWith('.properties') ? urlsFromProperties(text) : urlsFromYaml(text)
        for (const raw of urls) {
          const resolved = await resolvePlaceholders(serviceDir, raw)
          if (!resolved) continue
          const parsed = parseConnectionString(resolved.replace(/^(?:jdbc|r2dbc):/i, ''))
          if (!parsed || !parsed.host) continue
          out.push({ ...parsed, sourceFile: file, hostSource: 'config' })
        }
      } catch {
        continue
      }
    }
  }
  return out
}

export const springDatasourceParser = { name: 'spring-datasource', parse }

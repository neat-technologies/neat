import { promises as fs } from 'node:fs'
import path from 'node:path'
import { maskCommentsInSource } from '../shared.js'
import { walkSourceFiles } from '../calls/shared.js'
import {
  parseConnectionString,
  resolveEnvVar,
  type DbConfig,
  type ParsedConnectionConfig,
} from './shared.js'

// C# datastore clients (ADR-205; id scheme refined by ADR-207) — the connection axis of C#/.NET, the sibling
// of prisma.ts / drizzle.ts here and of calls/efcore.ts (the table axis). Two
// client shapes, both producing a `DatabaseNode` keyed on the resolved peer host
// so the EXTRACTED twin lands on the same `database:<host>` id an OBSERVED
// CONNECTS_TO span already minted (ingest keys a db span on server.address /
// net.peer.name via `databaseId`, ingest.ts) — the whole point being that the
// two layers fuse instead of twinning:
//
//   1. EF Core / Npgsql -> Postgres. A `DbContext.OnConfiguring` (or a DI
//      `AddDbContext`/`AddNpgsql*`) calls `UseNpgsql(<conn>)`. The connection is
//      an ADO.NET keyword string — `Host=postgresql;Username=...;Database=otel`
//      — either a literal or read from an env var / `IConfiguration` key, so the
//      host is recovered by parsing the `Host=` keyword (resolving the env var
//      from the service's `.env`, walking up to the repo root, when it's
//      indirected — the otel-demo puts `DB_CONNECTION_STRING` and `VALKEY_ADDR`
//      in a root `.env`/compose, above each service dir).
//
//   2. StackExchange.Redis -> Redis/Valkey. `ConnectionMultiplexer.Connect(...)`
//      / `ConfigurationOptions.Parse("host:port,opts")` names the endpoint; the
//      host is the token before the first `:` / `,`. Valkey is Redis-wire
//      compatible, so `db.system` is `redis` and the store keys on its own host
//      (`valkey-cart`) exactly like any Redis peer — engine `redis`.
//
// Precision & identity (ADR-207): a config is emitted only when a real client
// call is present AND a host resolves to a plain string (no unresolved `${VAR}`
// left in it). The `DatabaseNode` is keyed on that resolved host ALONE — the
// engine (`postgres`/`redis`) is a node ATTRIBUTE, never part of the id — so the
// id equals the `database:<host>` an OBSERVED span already minted from
// `server.address` (no `-npgsql`/`-stackexchange` driver suffix, which would key
// the twin off the observed peer and never fuse). Every genuinely declared host
// is extracted, config-driven addresses first: the otel-demo cart declares both
// the `VALKEY_ADDR` peer (`valkey-cart`, which fuses) AND a hardcoded
// `"badhost:1234"` fault-probe store, so both mint — `badhost` is a real declared
// connection that simply has no OBSERVED twin (an honest divergence), not a
// phantom to drop. What is NEVER minted is a fabricated placeholder host for a
// client whose connection can't be resolved at all: a made-up host looks fusable
// but isn't, so an unresolvable connection is left as an honest gap. Comment
// bodies are masked before scanning so a connection string inside a `//` / `/* */`
// comment never mints a node (the ADR-065 #2 discipline the regex extractors
// share).

const CS_EXT = '.cs'

// Cheap per-file gates — skip a `.cs` file that names neither client before the
// heavier scan runs, the import-gate discipline the data-axis readers follow.
const NPGSQL_GATE = /\bUseNpgsql\b|\bNpgsql\b/
const REDIS_GATE = /\bConnectionMultiplexer\b|\bStackExchange\.Redis\b|\bConfigurationOptions\.Parse\b|\bAddStackExchangeRedisCache\b/

// An `IConfiguration` / environment read that yields a connection string:
//   Environment.GetEnvironmentVariable("NAME")
//   Configuration["NAME"] / builder.Configuration["NAME"]
//   Configuration.GetConnectionString("NAME")
const ENV_READ_RE =
  /(?:GetEnvironmentVariable|GetConnectionString)\(\s*"([^"]+)"\s*\)|Configuration\s*\[\s*"([^"]+)"\s*\]/g

// A double-quoted string literal (C# `"..."` or verbatim `@"..."`; interpolated
// `$"..."` is skipped by the caller since its host is a runtime value).
const STRING_LITERAL_RE = /@?"([^"\\]*(?:\\.[^"\\]*)*)"/g

// A host token still carrying an interpolation hole (`${VAR}`, `$(cmd)`, a C#
// `{expr}`, or a bare `$`) never resolved to a real peer — reject it so a
// runtime-computed host falls through to the placeholder instead of minting a
// node id with braces in it.
function hostIsUnresolved(host: string): boolean {
  return host === '' || /[${}]/.test(host)
}

// Does a string look like a Postgres keyword / URL connection string?
function looksLikePostgres(s: string): boolean {
  return /(?:^|;)\s*(?:host|server|data\s*source)\s*=/i.test(s) || /^postgres(?:ql)?:\/\//i.test(s)
}

// Does a string look like a StackExchange.Redis endpoint? A bare word is too
// ambiguous (any string literal in the file would match) — require a `host:port`
// pair, a redis option token (`,ssl=`, `,abortConnect=`, …), or a `redis://` URL,
// so a log message or a schema name is never mistaken for a Redis host.
function looksLikeRedis(s: string): boolean {
  return (
    /^rediss?:\/\//i.test(s) ||
    /^[A-Za-z0-9_.-]+:\d+(?:$|,)/.test(s) ||
    /,\s*(?:ssl|abortconnect|allowadmin|connecttimeout|password|user)\s*=/i.test(s)
  )
}

// Host / port / database out of an ADO.NET keyword connection string
// (`Host=postgresql;Port=5432;Database=otel;Username=...`) or a `postgres://` URL.
// Case-insensitive keys, first host of a comma-separated multi-host list, null
// when no host key is present or the host is still an unresolved `${VAR}`.
function parsePostgresConnection(raw: string): ParsedConnectionConfig | null {
  const s = raw.trim()
  if (/^postgres(?:ql)?:\/\//i.test(s)) return parseConnectionString(s)

  const fields = new Map<string, string>()
  for (const part of s.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toLowerCase().replace(/\s+/g, ' ')
    const value = part.slice(eq + 1).trim()
    if (value && !fields.has(key)) fields.set(key, value)
  }
  const hostRaw = fields.get('host') ?? fields.get('server') ?? fields.get('data source')
  if (!hostRaw) return null
  const host = hostRaw.split(',')[0]!.trim()
  if (hostIsUnresolved(host)) return null
  const portRaw = fields.get('port')
  const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : undefined
  const database = fields.get('database') ?? fields.get('db') ?? ''
  return { host, port, database, engine: 'postgresql', engineVersion: 'unknown' }
}

// Host / port out of a StackExchange.Redis endpoint string
// (`valkey-cart:6379,ssl=false,abortConnect=false`) or a `redis://` URL. The
// endpoint is the first comma-separated token; the host is the part before the
// last `:` (an option token like `ssl=false` has no bare host shape and is
// rejected). Null when the leading token is not a host[:port].
function parseRedisEndpoint(raw: string): ParsedConnectionConfig | null {
  const s = raw.trim()
  if (/^rediss?:\/\//i.test(s)) return parseConnectionString(s)

  const first = s.split(',')[0]!.trim()
  const m = first.match(/^([A-Za-z0-9_.-]+)(?::(\d+))?$/)
  if (!m) return null
  const host = m[1]!
  if (hostIsUnresolved(host) || host.includes('=')) return null
  const port = m[2] ? Number(m[2]) : undefined
  return { host, port, database: '', engine: 'redis', engineVersion: 'unknown' }
}

// Resolve an env var / IConfiguration key the way .NET layers configuration:
// the value most often lives in a `.env` at the repo root, ABOVE the service
// dir (the otel-demo keeps `DB_CONNECTION_STRING` / `VALKEY_ADDR` there), so this
// walks up from the service dir checking each level's `.env*` (via the shared
// dotenv reader) and stops at the repo root — a directory holding `.git`. Bounded
// so a detached service dir can't walk the whole filesystem.
async function resolveEnvUpTree(startDir: string, name: string): Promise<string | null> {
  let dir = path.resolve(startDir)
  for (let depth = 0; depth < 12; depth++) {
    const value = await resolveEnvVar(dir, name)
    if (value !== null) return value
    const atRepoRoot = await fs
      .access(path.join(dir, '.git'))
      .then(() => true)
      .catch(() => false)
    const parent = path.dirname(dir)
    if (atRepoRoot || parent === dir) break
    dir = parent
  }
  return null
}

// Replace `${VAR}` / `$VAR` references in an env value with their own resolved
// values (one pass), so `Host=${POSTGRES_HOST}` recovers the real host when the
// referenced var is declared in a reachable `.env`. An unresolved reference is
// left verbatim; a host that still carries `${` is treated as unresolved by the
// parsers above and falls back to the placeholder.
async function interpolateEnvRefs(value: string, dir: string): Promise<string> {
  const refs = new Set<string>()
  for (const m of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    refs.add(m[1] ?? m[2]!)
  }
  let out = value
  for (const name of refs) {
    const resolved = await resolveEnvUpTree(dir, name)
    if (resolved === null) continue
    out = out
      .split(`\${${name}}`)
      .join(resolved)
      .replace(new RegExp(`\\$${name}\\b`, 'g'), resolved)
  }
  return out
}

// Every double-quoted string literal in the (comment-masked) source.
function stringLiterals(masked: string): string[] {
  const out: string[] = []
  STRING_LITERAL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STRING_LITERAL_RE.exec(masked)) !== null) out.push(m[1]!)
  return out
}

// Every env-var / config key referenced in the (comment-masked) source.
function envKeys(masked: string): string[] {
  const out: string[] = []
  ENV_READ_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ENV_READ_RE.exec(masked)) !== null) {
    const key = m[1] ?? m[2]
    if (key) out.push(key)
  }
  return out
}

// Resolve EVERY host a client declares in the service — a service can genuinely
// name more than one peer of an engine, and each real declaration is extracted
// rather than one silently winning. The otel-demo cart is the shape: it connects
// to the config-driven `VALKEY_ADDR` (`valkey-cart`) AND constructs a second store
// against a hardcoded `"badhost:1234"` fault-probe, so both are declared and both
// mint — `valkey-cart` fuses with the OBSERVED peer, `badhost` stands as a
// declared-but-unobserved connection (the honest divergence, not a node to drop).
// Config/env-referenced hosts are listed first (the deployment's real target),
// then matching literals. A host is only skipped when it doesn't parse to a plain
// string; a caller that gets an empty array mints no node (no fabricated
// placeholder). De-dup by `engine:host` is the caller's job (`push`).
async function resolveConfigs(
  literals: string[],
  keys: string[],
  serviceDir: string,
  looksLike: (s: string) => boolean,
  parse: (s: string) => ParsedConnectionConfig | null,
): Promise<ParsedConnectionConfig[]> {
  const out: ParsedConnectionConfig[] = []
  for (const key of keys) {
    const raw = await resolveEnvUpTree(serviceDir, key)
    if (raw === null) continue
    const value = await interpolateEnvRefs(raw, serviceDir)
    if (!looksLike(value)) continue
    const parsed = parse(value)
    if (parsed) out.push(parsed)
  }
  for (const lit of literals) {
    if (!looksLike(lit)) continue
    const parsed = parse(lit)
    if (parsed) out.push(parsed)
  }
  return out
}

// The connection string and the client call can live in different files — cart
// reads `VALKEY_ADDR` in Program.cs but calls `ConnectionMultiplexer.Connect` in
// cartstore/ValkeyCartStore.cs — so scanning is service-wide: literals and config
// keys are pooled across every `.cs` file, and the file holding the client call is
// remembered as the connection's origin (the CONNECTS_TO source, ADR-205). The
// shape gates (`looksLikePostgres` / `looksLikeRedis`) keep the two engines'
// pools disjoint even though they share one literal/key pool.
export async function parse(serviceDir: string): Promise<DbConfig[]> {
  const files = (await walkSourceFiles(serviceDir).catch(() => [])).filter(
    (f) => path.extname(f) === CS_EXT,
  )
  if (files.length === 0) return []

  const sources: Array<{ file: string; content: string }> = []
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8').catch(() => null)
    if (content !== null) sources.push({ file, content })
  }

  // First locate the client calls; the file holding one is the connection origin.
  let pgGateFile: string | null = null
  let redisGateFile: string | null = null
  for (const { file, content } of sources) {
    if (pgGateFile === null && NPGSQL_GATE.test(content)) pgGateFile = file
    if (redisGateFile === null && REDIS_GATE.test(content)) redisGateFile = file
  }
  if (!pgGateFile && !redisGateFile) return []

  // Pool literals and config keys from EVERY `.cs` file, not only the ones holding
  // the client call — the connection string / address is often read in a different
  // file (cart reads `VALKEY_ADDR` in Program.cs, connects in the store). The shape
  // gates keep the two engines' pools disjoint despite the shared pool.
  const literals: string[] = []
  const keys: string[] = []
  for (const { content } of sources) {
    const masked = maskCommentsInSource(content)
    literals.push(...stringLiterals(masked))
    keys.push(...envKeys(masked))
  }

  const out: DbConfig[] = []
  const seenHosts = new Set<string>()
  const push = (config: ParsedConnectionConfig, sourceFile: string): void => {
    const dedupe = `${config.engine}:${config.host}`
    if (seenHosts.has(dedupe)) return
    seenHosts.add(dedupe)
    out.push({ ...config, sourceFile })
  }

  // Every genuinely declared host mints a node; a host that can't be resolved to a
  // real peer mints nothing. The key discipline (ADR-207): never fabricate a
  // placeholder host — a made-up `database:<host>` shares the shape an OBSERVED span
  // carries but never fuses, so an unresolvable connection is an honest gap, not a
  // twin. A host that IS declared but simply doesn't fuse is still real and is kept
  // (the cart's `badhost:1234` fault-probe stands as a declared-but-unobserved edge).
  if (pgGateFile) {
    for (const pg of await resolveConfigs(literals, keys, serviceDir, looksLikePostgres, parsePostgresConnection)) {
      push(pg, pgGateFile)
    }
  }

  if (redisGateFile) {
    for (const redis of await resolveConfigs(literals, keys, serviceDir, looksLikeRedis, parseRedisEndpoint)) {
      push(redis, redisGateFile)
    }
  }

  return out
}

export const csharpParser = { name: 'csharp', parse }

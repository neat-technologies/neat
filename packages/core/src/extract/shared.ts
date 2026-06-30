import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ServiceNode } from '@neat.is/types'

export interface PackageJson {
  name: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: { node?: string }
}

export interface DiscoveredService {
  pkg: PackageJson
  dir: string
  node: ServiceNode
}

export const SERVICE_FILE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py'])
export const CONFIG_FILE_EXTENSIONS = new Set(['.yaml', '.yml'])
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'build',
  '.next',
  // Python virtualenv shapes (issue #344). Walking into a venv pulls in the
  // entire CPython stdlib + every installed package as if it were first-party
  // service code — 20k+ files, none of which the user wrote. The shape names
  // cover the three common venv tools (`venv` / `python -m venv`,
  // `virtualenv`) and the tox + PEP 582 conventions.
  '.venv',
  'venv',
  '__pypackages__',
  '.tox',
  // `site-packages` shows up nested inside venvs that don't carry one of the
  // outer names (system Python on macOS, in-place pyenv layouts). Listing it
  // here means we stop the walk at the boundary even when the wrapper dir
  // wasn't recognisable.
  'site-packages',
])

// Marker file `python -m venv` and `virtualenv` both drop at the venv root.
// Used by the walkers to recognise venvs whose top-level directory doesn't
// happen to match one of the canonical `IGNORED_DIRS` names (issue #344).
// Cached per process to keep the recursion hot path off the fs after the
// first walk; venv contents don't change inside one extract pass.
const PYVENV_MARKER_CACHE = new Map<string, boolean>()

export async function isPythonVenvDir(dir: string): Promise<boolean> {
  const cached = PYVENV_MARKER_CACHE.get(dir)
  if (cached !== undefined) return cached
  try {
    const stat = await fs.stat(path.join(dir, 'pyvenv.cfg'))
    const ok = stat.isFile()
    PYVENV_MARKER_CACHE.set(dir, ok)
    return ok
  } catch {
    PYVENV_MARKER_CACHE.set(dir, false)
    return false
  }
}

export function isConfigFile(name: string): { match: boolean; fileType: string } {
  const ext = path.extname(name)
  if (CONFIG_FILE_EXTENSIONS.has(ext)) return { match: true, fileType: ext.slice(1) }
  // .env, .env.local, .env.production. Bare filename or any dotted-suffix
  // variant; folder names get filtered upstream by walking files only.
  // ADR-065 #4 filters .env.template / .env.example / .env.sample (and the
  // dotted-suffix variants) at the producer level — those are documentation,
  // not runtime config.
  if (name === '.env' || name.startsWith('.env.')) {
    if (isEnvTemplateFile(name)) return { match: false, fileType: '' }
    // NEAT writes `.env.neat` itself during `--apply` (ADR-069 §4). Ingesting
    // it would record our own instrumentation env as if it were the user's
    // declared config — self-pollution. Skip it the same way the template
    // filter skips onboarding docs.
    if (isNeatAuthoredEnvFile(name)) return { match: false, fileType: '' }
    return { match: true, fileType: 'env' }
  }
  return { match: false, fileType: '' }
}

// NEAT-authored artifacts the installer drops into the user's tree during
// `--apply` (ADR-069). Extraction skips them: they're our own runtime hooks,
// not first-party config or source. Ingesting them pollutes the graph with
// NEAT's instrumentation as though the user had written it.
//
//   `.env.neat`         — per-package env carrying `OTEL_SERVICE_NAME`.
//   `otel-init.{ext}`   — generated SDK bootstrap (js/cjs/mjs/ts), including
//                         the framework variants (`src/otel-init.*`,
//                         `server/plugins/otel-init.*`) — basename is stable.
export function isNeatAuthoredEnvFile(name: string): boolean {
  return name === '.env.neat'
}

export function isNeatAuthoredSourceFile(name: string): boolean {
  return /^otel-init\.(?:js|cjs|mjs|ts|tsx)$/i.test(name)
}

// ─────────────────────────────────────────────────────────────────────────
// ADR-065 precision-filter helpers. Pre-emit gates inside the producer pass.
// Filtered candidates are never written to the graph (idempotency intact).
// ─────────────────────────────────────────────────────────────────────────

// ADR-065 #1 — test-scope exclusion. Returns true when the file path matches
// any test-scope pattern. Path is normalised to forward slashes before
// matching so callers can pass either form.
//
// Patterns:
//   - any segment named __tests__, __fixtures__, or integration-tests
//   - basename matches *.spec.{ts,tsx,js,jsx,mjs,cjs,py}
//   - basename matches *.test.{ts,tsx,js,jsx,mjs,cjs,py}
export function isTestPath(filePath: string): boolean {
  const normalised = filePath.replace(/\\/g, '/')
  const segments = normalised.split('/')
  for (const seg of segments) {
    if (seg === '__tests__' || seg === '__fixtures__' || seg === 'integration-tests') {
      return true
    }
  }
  const base = segments[segments.length - 1] ?? ''
  return /\.(spec|test)\.(?:tsx?|jsx?|mjs|cjs|py)$/i.test(base)
}

// ADR-065 #4 — `.env.template` exclusion. Matches:
//   .env.template / .env.example / .env.sample
//   .env.*.template / .env.*.example / .env.*.sample
// These are docs/onboarding artifacts, not runtime config. ConfigNodes are
// bound to runtime existence (ADR-016); templates fail that test.
export function isEnvTemplateFile(name: string): boolean {
  if (
    name === '.env.template' ||
    name === '.env.example' ||
    name === '.env.sample'
  ) {
    return true
  }
  // `.env.*.template` / `.env.*.example` / `.env.*.sample`
  return /^\.env\.[^.]+\.(?:template|example|sample)$/i.test(name)
}

// ADR-065 #2 — comment-body exclusion. Replaces every JS/TS comment span in
// the source with an equal-length run of spaces, preserving line/column for
// downstream line-mapping. Strings that contain `//` sequences (URLs) are
// preserved by tracking the string context as we scan.
//
// Not a full parser — good enough for the medusa-shape failures. The HTTP
// extractor's AST walk already gets comment-awareness for free; this helper
// is for the regex-based extractors (redis, kafka, aws, grpc).
export function maskCommentsInSource(src: string): string {
  const len = src.length
  const out: string[] = new Array(len)
  let i = 0
  // String context: ' " ` (template) — open-quote char, 0 when not in a string.
  let inString: string | 0 = 0
  let escaped = false
  while (i < len) {
    const c = src[i]!
    if (inString !== 0) {
      out[i] = c
      if (escaped) {
        escaped = false
      } else if (c === '\\') {
        escaped = true
      } else if (c === inString) {
        inString = 0
      }
      i++
      continue
    }
    if (c === '/' && i + 1 < len) {
      const next = src[i + 1]!
      if (next === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        let j = i + 2
        while (j < len && src[j] !== '\n') {
          out[j] = ' '
          j++
        }
        i = j
        continue
      }
      if (next === '*') {
        out[i] = ' '
        out[i + 1] = ' '
        let j = i + 2
        while (j < len) {
          if (src[j] === '\n') {
            out[j] = '\n'
            j++
            continue
          }
          if (src[j] === '*' && j + 1 < len && src[j + 1] === '/') {
            out[j] = ' '
            out[j + 1] = ' '
            j += 2
            break
          }
          out[j] = ' '
          j++
        }
        i = j
        continue
      }
    }
    out[i] = c
    if (c === "'" || c === '"' || c === '`') inString = c
    i++
  }
  return out.join('')
}

// ADR-065 #5 — exact hostname match for cross-service URL inference. Returns
// true if `urlString` looks like an actual URL — has an explicit `scheme://`
// or starts with a scheme-relative `//` — and its hostname matches `host`
// exactly (case-insensitive). No `.includes()` containment, and no bare-string
// matching: a literal like `'admin-bundler'` would otherwise parse as
// `http://admin-bundler` and match the basename of every service directory,
// which is how the v0.3.3 medusa pre-check produced 279 false positives.
//
// Accepts a `host` that may include a port (`api.example.com:8080`); in that
// case the URL's hostname AND port must both match.
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i

export function urlMatchesHost(urlString: string, host: string): boolean {
  if (typeof urlString !== 'string' || urlString.length === 0) return false
  // Require the literal to look like a URL — scheme + `://` or scheme-relative
  // `//host`. Bare hostnames are rejected; they're the load-bearing source of
  // false positives.
  if (!URL_LIKE.test(urlString)) return false
  const [wantedHost, wantedPort] = host.split(':')
  let parsed: URL
  try {
    // For scheme-relative `//host/path`, prepend `http:` so URL accepts it.
    const candidate = urlString.startsWith('//') ? `http:${urlString}` : urlString
    parsed = new URL(candidate)
  } catch {
    return false
  }
  if (parsed.hostname.toLowerCase() !== (wantedHost ?? '').toLowerCase()) return false
  if (wantedPort && parsed.port !== wantedPort) return false
  return true
}

// Strip semver range prefixes (^, ~, >=, etc.) and bare "v" so the extracted
// version is usable for compat checks. We don't try to resolve ranges to actual
// installed versions — that's a published-lockfile concern, not extraction's job.
export function cleanVersion(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  return raw.replace(/^[\^~><=v\s]+/, '').trim() || undefined
}

export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw) as T
}

export async function readYaml<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8')
  return parseYaml(raw) as T
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// Thin re-export so existing callers (calls/, configs.ts, databases/, infra/)
// keep their import path. Wire format lives in @neat.is/types/identity.ts per
// ADR-029.
export { extractedEdgeId as makeEdgeId } from '@neat.is/types'

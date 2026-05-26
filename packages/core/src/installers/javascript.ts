/**
 * Node / TypeScript SDK installer (ADR-047 + ADR-069).
 *
 * Detects services by the presence of a `package.json` carrying a `name`
 * field — same shape `extract/services.ts` uses to decide what counts as a
 * Node service. The plan adds four OTel-adjacent packages to `dependencies`
 * (api, sdk-node, auto-instrumentations-node, dotenv), writes a generated
 * `otel-init.{js,ts}` adjacent to the resolved entry, and injects the
 * require/import as the first non-shebang line of that entry. Per-package
 * `.env.neat` carries `OTEL_SERVICE_NAME` (scope-preserved) so dashboards
 * joining OBSERVED spans against the EXTRACTED graph use the same key.
 *
 * Lockfiles are never touched (ADR-047 §4). The apply phase writes only to
 * package.json, otel-init.{js,ts}, and .env.neat (ADR-069 §7). After
 * `--apply`, init prints "run npm install" so the user owns the lockfile
 * commit.
 *
 * Idempotency (ADR-069 §6): the generated otel-init's presence is the
 * primary signal that a package is instrumented end-to-end — when it
 * exists, the apply phase logs `already instrumented` and skips the file
 * write and the entry-point injection together. Existing `.env.neat` files
 * are preserved (never overwritten).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ApplyResult,
  DependencyEdit,
  EntrypointEdit,
  EnvEdit,
  GeneratedFile,
  Installer,
  InstallPlan,
  PlanOptions,
} from './shared.js'
import {
  ASTRO_MIDDLEWARE_JS,
  ASTRO_MIDDLEWARE_TS,
  ASTRO_OTEL_INIT_JS,
  ASTRO_OTEL_INIT_TS,
  NEXT_INSTRUMENTATION_HEADER,
  NEXT_INSTRUMENTATION_JS,
  NEXT_INSTRUMENTATION_NODE_JS,
  NEXT_INSTRUMENTATION_NODE_TS,
  NEXT_INSTRUMENTATION_TS,
  NUXT_OTEL_INIT_JS,
  NUXT_OTEL_INIT_TS,
  NUXT_OTEL_PLUGIN_JS,
  NUXT_OTEL_PLUGIN_TS,
  OTEL_INIT_CJS,
  OTEL_INIT_ESM,
  OTEL_INIT_HEADER,
  OTEL_INIT_STAMP,
  OTEL_INIT_TS,
  REMIX_OTEL_SERVER_JS,
  REMIX_OTEL_SERVER_TS,
  SVELTEKIT_HOOKS_SERVER_JS,
  SVELTEKIT_HOOKS_SERVER_TS,
  SVELTEKIT_OTEL_INIT_JS,
  SVELTEKIT_OTEL_INIT_TS,
  renderEnvNeat,
  renderFrameworkOtelInit,
  renderNextInstrumentationNode,
  renderNodeOtelInit,
} from './templates.js'

// ADR-069 §5 — three OTel packages land in `dependencies`. `dotenv` was a
// fourth from v0.3.6 through v0.4.3; the generated `otel-init` templates
// no longer load `.env.neat` from disk (issue #369), so it's gone from the
// dep set.
const SDK_PACKAGES = [
  { name: '@opentelemetry/api', version: '^1.9.0' },
  { name: '@opentelemetry/sdk-node', version: '^0.57.0' },
  { name: '@opentelemetry/auto-instrumentations-node', version: '^0.55.0' },
] as const

// Issue #376 — non-bundled instrumentations. The auto-instrumentations-node
// set covers HTTP, fetch, and the common DB drivers via the wire protocol,
// but libraries that bypass those wires (Prisma's Rust query engine talks
// to its own engine binary; LangChain wraps model calls in its own SDK)
// need their own instrumentation package registered explicitly. The detected
// entries here compose into the generated otel-init's `instrumentations`
// array — one `instrumentations.push(...)` line per entry — and join the
// package.json dep set so the registration line resolves at runtime.
//
// v0.4.5 scope is Prisma alone (first library that meaningfully widens
// NEAT's OBSERVED coverage on real codebases). The function's interface is
// stable so the v0.5.0 instrumentation registry (ADR-080) can return more
// entries without revisiting the template.
interface NonBundledInstrumentation {
  pkg: string
  version: string
  registration: string
}

// Pull the leading integer out of a semver range. `^6.2.0`, `~6.2.0`, `6.x`,
// `>=6.0.0 <7` all return 6. Anything we can't parse (workspace:*, file:…,
// undefined) returns 0 so the caller falls through to the pre-Prisma-6 path.
export function getMajor(versionRange: string | undefined): number {
  if (!versionRange) return 0
  const match = versionRange.match(/(\d+)/)
  return match ? parseInt(match[1], 10) : 0
}

export function detectNonBundledInstrumentations(
  pkg: PackageJsonShape,
): NonBundledInstrumentation[] {
  const deps = allDeps(pkg)
  const out: NonBundledInstrumentation[] = []
  if ('@prisma/client' in deps) {
    // Issue #381 — `@prisma/instrumentation@^5` doesn't speak Prisma 6's
    // tracing-helper API. Connecting the client throws
    // `this.getGlobalTracingHelper(...).dispatchEngineSpans is not a function`
    // before any user query lands. Mirror the Prisma major so the
    // instrumentation package matches the client surface.
    const prismaMajor = getMajor(deps['@prisma/client'])
    const prismaInstrVersion = prismaMajor >= 6 ? '^6.0.0' : '^5.0.0'
    out.push({
      pkg: '@prisma/instrumentation',
      version: prismaInstrVersion,
      registration:
        "instrumentations.push(new (require('@prisma/instrumentation').PrismaInstrumentation)())",
    })
  }
  return out
}

const OTEL_ENV: EnvEdit = {
  // ADR-069 §4 — endpoint moves into the per-package .env.neat (written
  // by the apply phase). The envEdits surface stays for the dry-run
  // patch render: it documents the key/value the user can inspect in the
  // generated .env.neat.
  file: null,
  key: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  value: 'http://localhost:4318/projects/<project>/v1/traces',
}

interface PackageJsonShape {
  name?: string
  type?: string
  main?: string
  bin?: string | Record<string, string>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

// v0.4.4 — `OTEL_SERVICE_NAME` regains its proper semantic role: the
// ServiceNode id inside the project's graph, not the project name. v0.4.1
// papered over the missing routing key by writing the project basename here;
// the project-scoped OTLP URL (issue #367) means the URL carries the routing
// key and the env var goes back to naming the ServiceNode.
function serviceNodeName(pkg: PackageJsonShape, serviceDir: string): string {
  return pkg.name ?? path.basename(serviceDir)
}

// The URL routing key. When the orchestrator threads a project through we use
// it verbatim; ad-hoc / test usage falls back to the package's own name so
// the generated file is still well-formed.
function projectToken(
  pkg: PackageJsonShape,
  serviceDir: string,
  project: string | undefined,
): string {
  if (project && project.length > 0) return project
  return pkg.name ?? path.basename(serviceDir)
}

// Issue #370 — runtime-kind detection. The installer historically treated
// every JavaScript package as a Node service; Brief's frontend workspace
// showed that wrong assumption write `instrumentation-node/register` into a
// Vite browser bundle and an Expo React Native entry, where the Node SDK
// can't execute. Detection runs after framework dispatch (Next / Remix /
// SvelteKit / Nuxt / Astro all render server-side, so they classify as
// `node`); only the framework-less packages reach the bucket here.
type RuntimeKind = 'node' | 'browser-bundle' | 'react-native'

async function readJsonFile(p: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(p, 'utf8')
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

async function detectRuntimeKind(
  pkgRoot: string,
  pkg: PackageJsonShape,
): Promise<RuntimeKind> {
  const deps = allDeps(pkg)
  if ('react-native' in deps || 'expo' in deps) return 'react-native'
  // Expo apps sometimes carry the SDK only as a transitive dep but always
  // ship an `app.json` carrying an `expo` block — that's the canonical Expo
  // signal.
  const appJson = await readJsonFile(path.join(pkgRoot, 'app.json'))
  if (appJson && typeof appJson === 'object' && 'expo' in (appJson as Record<string, unknown>)) {
    return 'react-native'
  }
  if (
    (await exists(path.join(pkgRoot, 'vite.config.js'))) ||
    (await exists(path.join(pkgRoot, 'vite.config.ts'))) ||
    (await exists(path.join(pkgRoot, 'vite.config.mjs'))) ||
    'vite' in deps
  ) {
    return 'browser-bundle'
  }
  return 'node'
}

// Issue #368 — `OTel deps in package.json` is no longer the signal for
// `already-instrumented`. The hook file is. Each `plan<Framework>` reads its
// canonical hook path off disk via `await exists(...)` before queueing the
// generated-file write, so deps-present-but-hook-absent correctly buckets
// the package as `instrumented` (the installer writes the hook), not
// `already-instrumented`. The next-deps-no-hook fixture in the contract
// suite locks this against regression.

async function readPackageJson(serviceDir: string): Promise<PackageJsonShape | null> {
  try {
    const raw = await fs.readFile(path.join(serviceDir, 'package.json'), 'utf8')
    return JSON.parse(raw) as PackageJsonShape
  } catch {
    return null
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

// Read a file's contents, or null when it doesn't exist. Used by the
// otel-init migration check (file-awareness.md §4) so a single read decides
// between write / migrate / preserve.
async function readFileMaybe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
}

// Decide what to do with the generated otel-init at `file`, given its rendered
// current contents. A missing file is written (skipIfExists honours a race
// where it appears between plan and apply). A NEAT-owned file (carries
// OTEL_INIT_HEADER) on an older template — no current stamp — is regenerated so
// a re-run upgrades the install. A current-stamp NEAT file is already current,
// and a hand-written init (no header) is never touched.
async function planOtelInitGeneration(
  file: string,
  contents: string,
): Promise<GeneratedFile | null> {
  const existing = await readFileMaybe(file)
  if (existing === null) {
    return { file, contents, skipIfExists: true }
  }
  if (existing.includes(OTEL_INIT_HEADER) && !existing.includes(OTEL_INIT_STAMP)) {
    return { file, contents, skipIfExists: false }
  }
  return null
}

async function detect(serviceDir: string): Promise<boolean> {
  const pkg = await readPackageJson(serviceDir)
  return pkg !== null && typeof pkg.name === 'string'
}

// ADR-073 §1 — Next.js detection. A package is Next-flavored when it
// declares `next` as a (dev)dependency AND ships a `next.config.{js,ts,mjs}`
// at the package root. Both are required: a stray `next` import without the
// config file isn't a Next app, and a config file without the dep is dead
// configuration.
const NEXT_CONFIG_CANDIDATES = ['next.config.js', 'next.config.ts', 'next.config.mjs']

async function findNextConfig(serviceDir: string): Promise<string | null> {
  for (const name of NEXT_CONFIG_CANDIDATES) {
    const candidate = path.join(serviceDir, name)
    if (await exists(candidate)) return candidate
  }
  return null
}

function hasNextDependency(pkg: PackageJsonShape): boolean {
  return (
    (pkg.dependencies?.next !== undefined) ||
    (pkg.devDependencies?.next !== undefined)
  )
}

// Read the merged dep + devDep map once per detection step. Framework checks
// only care about presence, not version.
function allDeps(pkg: PackageJsonShape): Record<string, string> {
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
}

// ADR-074 §3 — Remix detection. A package is Remix-flavored when it declares
// `remix` or any `@remix-run/*` package AND ships an entry-server file at one
// of the canonical paths (`app/entry.server.{ts,tsx,js,jsx}`).
const REMIX_ENTRY_CANDIDATES = [
  'app/entry.server.ts',
  'app/entry.server.tsx',
  'app/entry.server.js',
  'app/entry.server.jsx',
]

function hasRemixDependency(pkg: PackageJsonShape): boolean {
  const deps = allDeps(pkg)
  if ('remix' in deps) return true
  for (const name of Object.keys(deps)) {
    if (name.startsWith('@remix-run/')) return true
  }
  return false
}

async function findRemixEntry(serviceDir: string): Promise<string | null> {
  for (const rel of REMIX_ENTRY_CANDIDATES) {
    const candidate = path.join(serviceDir, rel)
    if (await exists(candidate)) return candidate
  }
  return null
}

// ADR-074 §3 — SvelteKit detection. `@sveltejs/kit` dep, plus either an
// existing `src/hooks.server.{ts,js}` or a top-level `svelte.config.{js,ts}`
// (the absent-hooks case where the installer creates the hook file).
const SVELTEKIT_HOOKS_CANDIDATES = ['src/hooks.server.ts', 'src/hooks.server.js']
const SVELTEKIT_CONFIG_CANDIDATES = ['svelte.config.js', 'svelte.config.ts']

function hasSvelteKitDependency(pkg: PackageJsonShape): boolean {
  return '@sveltejs/kit' in allDeps(pkg)
}

async function findSvelteKitHooks(serviceDir: string): Promise<string | null> {
  for (const rel of SVELTEKIT_HOOKS_CANDIDATES) {
    const candidate = path.join(serviceDir, rel)
    if (await exists(candidate)) return candidate
  }
  return null
}

async function findSvelteKitConfig(serviceDir: string): Promise<string | null> {
  for (const rel of SVELTEKIT_CONFIG_CANDIDATES) {
    const candidate = path.join(serviceDir, rel)
    if (await exists(candidate)) return candidate
  }
  return null
}

// ADR-074 §3 — Nuxt detection. `nuxt` dep + `nuxt.config.{ts,js,mjs}`.
const NUXT_CONFIG_CANDIDATES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs']

function hasNuxtDependency(pkg: PackageJsonShape): boolean {
  return 'nuxt' in allDeps(pkg)
}

async function findNuxtConfig(serviceDir: string): Promise<string | null> {
  for (const name of NUXT_CONFIG_CANDIDATES) {
    const candidate = path.join(serviceDir, name)
    if (await exists(candidate)) return candidate
  }
  return null
}

// ADR-074 §3 — Astro detection. `astro` dep + `astro.config.{mjs,ts,js}`.
const ASTRO_CONFIG_CANDIDATES = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']

function hasAstroDependency(pkg: PackageJsonShape): boolean {
  return 'astro' in allDeps(pkg)
}

async function findAstroConfig(serviceDir: string): Promise<string | null> {
  for (const name of ASTRO_CONFIG_CANDIDATES) {
    const candidate = path.join(serviceDir, name)
    if (await exists(candidate)) return candidate
  }
  return null
}

// Parse the leading major version out of a semver range like "^14.0.3" or
// "~15.0" or "15.0.0". Returns null when the range can't be read (workspace
// links, git refs, "*", etc.).
export function parseNextMajor(range: string | undefined): number | null {
  if (!range) return null
  const cleaned = range.trim().replace(/^[\^~>=<\s]+/, '')
  const match = cleaned.match(/^(\d+)/)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) ? n : null
}

async function isTypeScriptProject(serviceDir: string): Promise<boolean> {
  return exists(path.join(serviceDir, 'tsconfig.json'))
}

// ADR-069 §2 + ADR-070 — entry resolution: pkg.main → pkg.bin → scripts.start
// → scripts.dev → src/index.* → src/{server,main,app}.* → root index.*.
// Returns the absolute path to the resolved entry, or null when the package
// is lib-only (no resolvable entry).
const INDEX_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs']
const INDEX_CANDIDATES = INDEX_EXTENSIONS.map((ext) => `index${ext}`)
const SRC_INDEX_CANDIDATES = INDEX_EXTENSIONS.map((ext) => `src/index${ext}`)
const SRC_NAMED_CANDIDATES = ['server', 'main', 'app'].flatMap((name) =>
  INDEX_EXTENSIONS.map((ext) => `src/${name}${ext}`),
)

// ADR-070 — script-entry tokeniser. Launchers and similar wrappers we strip
// before reading the first file-shaped argument. Anything not in this set is
// treated as a candidate entry if it looks like a relative file path.
const SCRIPT_LAUNCHERS = new Set([
  'node',
  'ts-node',
  'tsx',
  'ts-node-dev',
  'nodemon',
  'npx',
  'pnpm',
  'yarn',
  'npm',
  'cross-env',
  'dotenv',
  '--',
])

// True when the token resembles a path inside the package — contains a `/` or
// ends in one of the JS/TS extensions we instrument.
function looksLikeEntryPath(token: string): boolean {
  if (token.length === 0) return false
  if (token.startsWith('-')) return false
  if (token.includes('=')) return false // env-var assignments
  if (token.includes('/')) return true
  return /\.(?:m?[jt]sx?|c[jt]s)$/.test(token)
}

// Bail when the script chains commands or pipes — those scripts mean an
// orchestrator runs multiple things and our heuristic can't pick safely.
function scriptHasShellChain(script: string): boolean {
  return /(?:&&|\|\||;|\|(?!\|))/.test(script)
}

// Pull the first file-shaped argument out of a script invocation, after
// stripping recognised launchers and inline env-var assignments. Returns
// undefined when no candidate surfaces (or when shell chaining bails us out).
export function entryFromScript(script: string | undefined): string | undefined {
  if (!script) return undefined
  if (scriptHasShellChain(script)) return undefined
  const tokens = script.split(/\s+/).filter((t) => t.length > 0)
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (SCRIPT_LAUNCHERS.has(lower)) continue
    // Strip a leading `./` so the existence check resolves cleanly.
    const cleaned = token.startsWith('./') ? token.slice(2) : token
    if (looksLikeEntryPath(cleaned)) return cleaned
  }
  return undefined
}

export async function resolveEntry(
  serviceDir: string,
  pkg: PackageJsonShape,
): Promise<string | null> {
  // 1) pkg.main — but only when it actually exists on disk (ADR-070).
  if (typeof pkg.main === 'string' && pkg.main.length > 0) {
    const candidate = path.resolve(serviceDir, pkg.main)
    if (await exists(candidate)) return candidate
    // Manifest points main at a missing build output (e.g. dist/index.js
    // pre-build). Fall through to bin/scripts/src heuristics rather than
    // marking lib-only.
  }
  // 2) pkg.bin (string or pkg.name-keyed map).
  if (pkg.bin) {
    let binEntry: string | undefined
    if (typeof pkg.bin === 'string') {
      binEntry = pkg.bin
    } else if (pkg.name && typeof pkg.bin[pkg.name] === 'string') {
      binEntry = pkg.bin[pkg.name]
    } else {
      const first = Object.values(pkg.bin)[0]
      if (typeof first === 'string') binEntry = first
    }
    if (binEntry) {
      const candidate = path.resolve(serviceDir, binEntry)
      if (await exists(candidate)) return candidate
    }
  }
  // 3) scripts.start — ADR-070.
  const startEntry = entryFromScript(pkg.scripts?.start)
  if (startEntry) {
    const candidate = path.resolve(serviceDir, startEntry)
    if (await exists(candidate)) return candidate
  }
  // 4) scripts.dev — ADR-070.
  const devEntry = entryFromScript(pkg.scripts?.dev)
  if (devEntry) {
    const candidate = path.resolve(serviceDir, devEntry)
    if (await exists(candidate)) return candidate
  }
  // 5) src/index.* — ADR-070.
  for (const rel of SRC_INDEX_CANDIDATES) {
    const candidate = path.join(serviceDir, rel)
    if (await exists(candidate)) return candidate
  }
  // 6) src/server.*, src/main.*, src/app.* — ADR-070.
  for (const rel of SRC_NAMED_CANDIDATES) {
    const candidate = path.join(serviceDir, rel)
    if (await exists(candidate)) return candidate
  }
  // 7) root index.* — original ADR-069 §3 fallback.
  for (const name of INDEX_CANDIDATES) {
    const candidate = path.join(serviceDir, name)
    if (await exists(candidate)) return candidate
  }
  return null
}

// ADR-069 §1, §3 — dispatch by entry extension + pkg.type.
type EntryFlavor = 'cjs' | 'esm' | 'ts'

export function dispatchEntry(entryFile: string, pkg: PackageJsonShape): EntryFlavor {
  const ext = path.extname(entryFile).toLowerCase()
  if (ext === '.ts' || ext === '.tsx') return 'ts'
  if (ext === '.mjs') return 'esm'
  if (ext === '.cjs') return 'cjs'
  // .js — disambiguate on pkg.type. "module" → ESM, anything else → CJS.
  return pkg.type === 'module' ? 'esm' : 'cjs'
}

// Generated-file basename per flavor.
function otelInitFilename(flavor: EntryFlavor): string {
  if (flavor === 'ts') return 'otel-init.ts'
  if (flavor === 'esm') return 'otel-init.mjs'
  return 'otel-init.cjs'
}

function otelInitContents(flavor: EntryFlavor): string {
  if (flavor === 'ts') return OTEL_INIT_TS
  if (flavor === 'esm') return OTEL_INIT_ESM
  return OTEL_INIT_CJS
}

// Build the injection line per flavor. The relative path is computed against
// the entry's directory so the injection works regardless of the entry's
// depth inside the package.
export function injectionLine(
  flavor: EntryFlavor,
  entryFile: string,
  otelInitFile: string,
): string {
  let rel = path.relative(path.dirname(entryFile), otelInitFile)
  if (!rel.startsWith('.')) rel = `./${rel}`
  // Normalize to forward slashes for cross-platform module specifiers.
  rel = rel.split(path.sep).join('/')
  if (flavor === 'cjs') return `require('${rel}')`
  if (flavor === 'esm') return `import '${rel}'`
  // TS: drop the .ts extension so the resolver doesn't choke on it under
  // either tsc-output or runtime-loader pipelines.
  const tsRel = rel.replace(/\.ts$/, '')
  return `import '${tsRel}'`
}

// Detect whether a given line already matches an injection of our otel-init.
// Used for the entry-point idempotency check (ADR-069 §6).
function lineIsOtelInjection(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  // Match require('./otel-init…') and import './otel-init…' shapes.
  return /(?:require\(|import\s+)['"]\.\/otel-init[^'"]*['"]/.test(trimmed)
}

// `create-next-app --src-dir` puts source under `src/` and Next then resolves
// the instrumentation hook from `src/instrumentation.ts`. Routing the
// generated files to root in that case means the hook never loads. We detect
// src-layout by the presence of `src/app/` or `src/pages/` AND the absence of
// the same at the package root — a project with both is treated as flat, the
// safer default for monorepos that vendor a `src/` subpackage.
async function detectsSrcLayout(serviceDir: string): Promise<boolean> {
  const [hasSrcApp, hasSrcPages, hasRootApp, hasRootPages] = await Promise.all([
    exists(path.join(serviceDir, 'src', 'app')),
    exists(path.join(serviceDir, 'src', 'pages')),
    exists(path.join(serviceDir, 'app')),
    exists(path.join(serviceDir, 'pages')),
  ])
  return (hasSrcApp || hasSrcPages) && !hasRootApp && !hasRootPages
}

// ADR-073 §1 — Next.js apply path. Emits `instrumentation.{ts,js}` and
// `instrumentation.node.{ts,js}` at the package root (or under `src/` for
// `--src-dir` layouts), plus `.env.neat` co-located with them. Skips
// entry-point injection entirely — Next loads the instrumentation file
// through its own runtime hook. Queues a next.config edit only when the
// declared major is < 15 (the flag is on-by-default from Next 15 on).
async function planNext(
  serviceDir: string,
  pkg: PackageJsonShape,
  manifestPath: string,
  nextConfigPath: string,
  project: string | undefined,
): Promise<InstallPlan> {
  const useTs = await isTypeScriptProject(serviceDir)
  const srcLayout = await detectsSrcLayout(serviceDir)
  // Co-locate the generated files with where Next looks for the hook. When
  // src-layout is detected the framework resolves `src/instrumentation.{ts,js}`
  // and we route the .env.neat alongside so an operator reading the codebase
  // finds the wiring in one place. The flat layout keeps the existing root
  // placement.
  const baseDir = srcLayout ? path.join(serviceDir, 'src') : serviceDir
  const instrumentationFile = path.join(baseDir, useTs ? 'instrumentation.ts' : 'instrumentation.js')
  const instrumentationNodeFile = path.join(
    baseDir,
    useTs ? 'instrumentation.node.ts' : 'instrumentation.node.js',
  )
  const envNeatFile = path.join(baseDir, '.env.neat')

  // Dependency edits — `dotenv` is gone repo-wide from v0.4.4 (issue #369),
  // so SDK_PACKAGES has the three OTel packages the apply phase adds and the
  // Next branch shares the same loop as every other framework. Issue #376
  // adds non-bundled instrumentations (Prisma in v0.4.5) — each detected
  // entry contributes one dep + one registration line into the generated
  // instrumentation.node file.
  const existingDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const dependencyEdits: DependencyEdit[] = []
  for (const sdk of SDK_PACKAGES) {
    if (sdk.name in existingDeps) continue
    dependencyEdits.push({
      file: manifestPath,
      kind: 'add',
      name: sdk.name,
      version: sdk.version,
    })
  }
  const nonBundled = detectNonBundledInstrumentations(pkg)
  for (const inst of nonBundled) {
    if (inst.pkg in existingDeps) continue
    dependencyEdits.push({
      file: manifestPath,
      kind: 'add',
      name: inst.pkg,
      version: inst.version,
    })
  }

  // Generated files — instrumentation pair + .env.neat. Existing files are
  // preserved (skipIfExists honours user customisations and keeps the apply
  // phase idempotent per ADR-069 §6). The instrumentation.node template
  // carries `__SERVICE_NAME__` (the ServiceNode id) and `__PROJECT__` (the
  // registered project basename — the URL routing key) placeholders we
  // substitute here so the bundler-survivable `process.env.X ||=` lines land
  // with both values verbatim.
  const svcName = serviceNodeName(pkg, serviceDir)
  const projectName = projectToken(pkg, serviceDir, project)
  const registrations = nonBundled.map((i) => i.registration)
  const generatedFiles: GeneratedFile[] = []
  if (!(await exists(instrumentationFile))) {
    generatedFiles.push({
      file: instrumentationFile,
      contents: useTs ? NEXT_INSTRUMENTATION_TS : NEXT_INSTRUMENTATION_JS,
      skipIfExists: true,
    })
  }
  if (!(await exists(instrumentationNodeFile))) {
    generatedFiles.push({
      file: instrumentationNodeFile,
      contents: renderNextInstrumentationNode(
        useTs ? NEXT_INSTRUMENTATION_NODE_TS : NEXT_INSTRUMENTATION_NODE_JS,
        svcName,
        projectName,
        registrations,
      ),
      skipIfExists: true,
    })
  }
  if (!(await exists(envNeatFile))) {
    generatedFiles.push({
      file: envNeatFile,
      contents: renderEnvNeat(svcName, projectName),
      skipIfExists: true,
    })
  }

  // ADR-073 §1 — `experimental.instrumentationHook: true` is required for
  // Next 13 / 14 and a no-op on Next 15+. Plan the edit only when the
  // declared major is < 15 and the flag isn't already present.
  let nextConfigEdit: InstallPlan['nextConfigEdit']
  const nextRange = pkg.dependencies?.next ?? pkg.devDependencies?.next
  const nextMajor = parseNextMajor(nextRange)
  if (nextMajor !== null && nextMajor < 15) {
    try {
      const raw = await fs.readFile(nextConfigPath, 'utf8')
      if (!raw.includes('instrumentationHook')) {
        nextConfigEdit = {
          file: nextConfigPath,
          reason: `enable experimental.instrumentationHook (Next ${nextMajor} requires the opt-in flag)`,
        }
      }
    } catch {
      // Config disappeared between detect and plan. Skip the edit.
    }
  }

  const empty =
    dependencyEdits.length === 0 &&
    generatedFiles.length === 0 &&
    nextConfigEdit === undefined

  if (empty) {
    return {
      language: 'javascript',
      serviceDir,
      dependencyEdits: [],
      entrypointEdits: [],
      envEdits: [],
      generatedFiles: [],
      framework: 'next',
    }
  }

  return {
    language: 'javascript',
    serviceDir,
    dependencyEdits,
    entrypointEdits: [],
    envEdits: [OTEL_ENV],
    generatedFiles,
    framework: 'next',
    ...(nextConfigEdit ? { nextConfigEdit } : {}),
  }
}

// ── Meta-framework planners (ADR-074 §3). ───────────────────────────────
//
// Each planner mirrors planNext's shape: build dep edits via the same
// SDK_PACKAGES + existing-deps filter, queue generated files for the
// framework-canonical hook surface, record `framework: '<name>'`, never
// inject into pkg.main. Idempotency rides on `skipIfExists` for generated
// files and on a re-read header-grep for the inject-into-existing case.

function buildDependencyEdits(
  pkg: PackageJsonShape,
  manifestPath: string,
): DependencyEdit[] {
  const existingDeps = allDeps(pkg)
  const edits: DependencyEdit[] = []
  for (const sdk of SDK_PACKAGES) {
    if (sdk.name in existingDeps) continue
    edits.push({
      file: manifestPath,
      kind: 'add',
      name: sdk.name,
      version: sdk.version,
    })
  }
  return edits
}

async function queueEnvNeat(
  serviceDir: string,
  pkg: PackageJsonShape,
  project: string | undefined,
  generatedFiles: GeneratedFile[],
): Promise<void> {
  const envNeatFile = path.join(serviceDir, '.env.neat')
  if (!(await exists(envNeatFile))) {
    generatedFiles.push({
      file: envNeatFile,
      contents: renderEnvNeat(
        serviceNodeName(pkg, serviceDir),
        projectToken(pkg, serviceDir, project),
      ),
      skipIfExists: true,
    })
  }
}

function renderFrameworkOtelInitForPkg(
  template: string,
  pkg: PackageJsonShape,
  serviceDir: string,
  project: string | undefined,
): string {
  return renderFrameworkOtelInit(
    template,
    serviceNodeName(pkg, serviceDir),
    projectToken(pkg, serviceDir, project),
  )
}

function fileImportsOtelHook(raw: string, specifiers: readonly string[]): boolean {
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    for (const spec of specifiers) {
      const escaped = spec.replace(/\./g, '\\.')
      const pattern = new RegExp(
        `(?:import\\s+['"]${escaped}['"]|require\\(['"]${escaped}['"]\\))`,
      )
      if (pattern.test(trimmed)) return true
    }
  }
  return false
}

async function planRemix(
  serviceDir: string,
  pkg: PackageJsonShape,
  manifestPath: string,
  entryFile: string,
  project: string | undefined,
): Promise<InstallPlan> {
  const useTs = await isTypeScriptProject(serviceDir)
  const otelServerFile = path.join(
    serviceDir,
    useTs ? 'app/otel.server.ts' : 'app/otel.server.js',
  )

  const dependencyEdits = buildDependencyEdits(pkg, manifestPath)
  const generatedFiles: GeneratedFile[] = []

  if (!(await exists(otelServerFile))) {
    generatedFiles.push({
      file: otelServerFile,
      contents: renderFrameworkOtelInitForPkg(
        useTs ? REMIX_OTEL_SERVER_TS : REMIX_OTEL_SERVER_JS,
        pkg,
        serviceDir,
        project,
      ),
      skipIfExists: true,
    })
  }
  await queueEnvNeat(serviceDir, pkg, project, generatedFiles)

  const entrypointEdits: EntrypointEdit[] = []
  try {
    const raw = await fs.readFile(entryFile, 'utf8')
    if (!fileImportsOtelHook(raw, ['./otel.server'])) {
      const lines = raw.split(/\r?\n/)
      const firstReal = lines[0]?.startsWith('#!') ? lines[1] ?? '' : lines[0] ?? ''
      entrypointEdits.push({
        file: entryFile,
        before: firstReal,
        after: "import './otel.server'",
      })
    }
  } catch {
    // Entry file disappeared between detect and plan; fall through.
  }

  const empty =
    dependencyEdits.length === 0 &&
    generatedFiles.length === 0 &&
    entrypointEdits.length === 0

  if (empty) {
    return {
      language: 'javascript',
      serviceDir,
      dependencyEdits: [],
      entrypointEdits: [],
      envEdits: [],
      generatedFiles: [],
      framework: 'remix',
    }
  }

  return {
    language: 'javascript',
    serviceDir,
    dependencyEdits,
    entrypointEdits,
    envEdits: [OTEL_ENV],
    generatedFiles,
    framework: 'remix',
  }
}

async function planSvelteKit(
  serviceDir: string,
  pkg: PackageJsonShape,
  manifestPath: string,
  hooksFile: string | null,
  project: string | undefined,
): Promise<InstallPlan> {
  const useTs = await isTypeScriptProject(serviceDir)
  const otelInitFile = path.join(
    serviceDir,
    useTs ? 'src/otel-init.ts' : 'src/otel-init.js',
  )
  const resolvedHooksFile =
    hooksFile ??
    path.join(serviceDir, useTs ? 'src/hooks.server.ts' : 'src/hooks.server.js')

  const dependencyEdits = buildDependencyEdits(pkg, manifestPath)
  const generatedFiles: GeneratedFile[] = []
  const entrypointEdits: EntrypointEdit[] = []

  if (!(await exists(otelInitFile))) {
    generatedFiles.push({
      file: otelInitFile,
      contents: renderFrameworkOtelInitForPkg(
        useTs ? SVELTEKIT_OTEL_INIT_TS : SVELTEKIT_OTEL_INIT_JS,
        pkg,
        serviceDir,
        project,
      ),
      skipIfExists: true,
    })
  }
  await queueEnvNeat(serviceDir, pkg, project, generatedFiles)

  if (hooksFile === null) {
    generatedFiles.push({
      file: resolvedHooksFile,
      contents: useTs ? SVELTEKIT_HOOKS_SERVER_TS : SVELTEKIT_HOOKS_SERVER_JS,
      skipIfExists: true,
    })
  } else {
    try {
      const raw = await fs.readFile(hooksFile, 'utf8')
      if (!fileImportsOtelHook(raw, ['./otel-init'])) {
        const lines = raw.split(/\r?\n/)
        const firstReal = lines[0]?.startsWith('#!') ? lines[1] ?? '' : lines[0] ?? ''
        entrypointEdits.push({
          file: hooksFile,
          before: firstReal,
          after: "import './otel-init'",
        })
      }
    } catch {
      // Disappeared between detect and plan; fall through.
    }
  }

  const empty =
    dependencyEdits.length === 0 &&
    generatedFiles.length === 0 &&
    entrypointEdits.length === 0

  if (empty) {
    return {
      language: 'javascript',
      serviceDir,
      dependencyEdits: [],
      entrypointEdits: [],
      envEdits: [],
      generatedFiles: [],
      framework: 'sveltekit',
    }
  }

  return {
    language: 'javascript',
    serviceDir,
    dependencyEdits,
    entrypointEdits,
    envEdits: [OTEL_ENV],
    generatedFiles,
    framework: 'sveltekit',
  }
}

async function planNuxt(
  serviceDir: string,
  pkg: PackageJsonShape,
  manifestPath: string,
  project: string | undefined,
): Promise<InstallPlan> {
  const useTs = await isTypeScriptProject(serviceDir)
  const otelPluginFile = path.join(
    serviceDir,
    useTs ? 'server/plugins/otel.ts' : 'server/plugins/otel.js',
  )
  const otelInitFile = path.join(
    serviceDir,
    useTs ? 'server/plugins/otel-init.ts' : 'server/plugins/otel-init.js',
  )

  const dependencyEdits = buildDependencyEdits(pkg, manifestPath)
  const generatedFiles: GeneratedFile[] = []

  if (!(await exists(otelInitFile))) {
    generatedFiles.push({
      file: otelInitFile,
      contents: renderFrameworkOtelInitForPkg(
        useTs ? NUXT_OTEL_INIT_TS : NUXT_OTEL_INIT_JS,
        pkg,
        serviceDir,
        project,
      ),
      skipIfExists: true,
    })
  }
  if (!(await exists(otelPluginFile))) {
    generatedFiles.push({
      file: otelPluginFile,
      contents: useTs ? NUXT_OTEL_PLUGIN_TS : NUXT_OTEL_PLUGIN_JS,
      skipIfExists: true,
    })
  }
  await queueEnvNeat(serviceDir, pkg, project, generatedFiles)

  const empty = dependencyEdits.length === 0 && generatedFiles.length === 0

  if (empty) {
    return {
      language: 'javascript',
      serviceDir,
      dependencyEdits: [],
      entrypointEdits: [],
      envEdits: [],
      generatedFiles: [],
      framework: 'nuxt',
    }
  }

  return {
    language: 'javascript',
    serviceDir,
    dependencyEdits,
    entrypointEdits: [],
    envEdits: [OTEL_ENV],
    generatedFiles,
    framework: 'nuxt',
  }
}

const ASTRO_MIDDLEWARE_CANDIDATES = ['src/middleware.ts', 'src/middleware.js']

async function findAstroMiddleware(serviceDir: string): Promise<string | null> {
  for (const rel of ASTRO_MIDDLEWARE_CANDIDATES) {
    const candidate = path.join(serviceDir, rel)
    if (await exists(candidate)) return candidate
  }
  return null
}

async function planAstro(
  serviceDir: string,
  pkg: PackageJsonShape,
  manifestPath: string,
  project: string | undefined,
): Promise<InstallPlan> {
  const useTs = await isTypeScriptProject(serviceDir)
  const otelInitFile = path.join(
    serviceDir,
    useTs ? 'src/otel-init.ts' : 'src/otel-init.js',
  )
  const existingMiddleware = await findAstroMiddleware(serviceDir)
  const middlewareFile =
    existingMiddleware ??
    path.join(serviceDir, useTs ? 'src/middleware.ts' : 'src/middleware.js')

  const dependencyEdits = buildDependencyEdits(pkg, manifestPath)
  const generatedFiles: GeneratedFile[] = []
  const entrypointEdits: EntrypointEdit[] = []

  if (!(await exists(otelInitFile))) {
    generatedFiles.push({
      file: otelInitFile,
      contents: renderFrameworkOtelInitForPkg(
        useTs ? ASTRO_OTEL_INIT_TS : ASTRO_OTEL_INIT_JS,
        pkg,
        serviceDir,
        project,
      ),
      skipIfExists: true,
    })
  }
  await queueEnvNeat(serviceDir, pkg, project, generatedFiles)

  if (existingMiddleware === null) {
    generatedFiles.push({
      file: middlewareFile,
      contents: useTs ? ASTRO_MIDDLEWARE_TS : ASTRO_MIDDLEWARE_JS,
      skipIfExists: true,
    })
  } else {
    try {
      const raw = await fs.readFile(existingMiddleware, 'utf8')
      if (!fileImportsOtelHook(raw, ['./otel-init'])) {
        const lines = raw.split(/\r?\n/)
        const firstReal = lines[0]?.startsWith('#!') ? lines[1] ?? '' : lines[0] ?? ''
        entrypointEdits.push({
          file: existingMiddleware,
          before: firstReal,
          after: "import './otel-init'",
        })
      }
    } catch {
      // Disappeared between detect and plan; fall through.
    }
  }

  const empty =
    dependencyEdits.length === 0 &&
    generatedFiles.length === 0 &&
    entrypointEdits.length === 0

  if (empty) {
    return {
      language: 'javascript',
      serviceDir,
      dependencyEdits: [],
      entrypointEdits: [],
      envEdits: [],
      generatedFiles: [],
      framework: 'astro',
    }
  }

  return {
    language: 'javascript',
    serviceDir,
    dependencyEdits,
    entrypointEdits,
    envEdits: [OTEL_ENV],
    generatedFiles,
    framework: 'astro',
  }
}

type FrameworkDispatch = () => Promise<InstallPlan>

// ADR-073 §1 + ADR-074 §3 — framework signal lookup. Returns a thunk that
// invokes the framework-specific planner when a match lands, or null when
// none do. Detection precedence is Next → Remix → SvelteKit → Nuxt → Astro;
// the chain bails on the first match. Pulled out of `plan()` so issue
// #375's lib-only check can see the framework signal upfront — a package
// with no framework hook AND no Node entry buckets as lib-only regardless
// of stray Vite config or Expo deps.
async function findFrameworkDispatch(
  serviceDir: string,
  pkg: PackageJsonShape,
  manifestPath: string,
  project: string | undefined,
): Promise<FrameworkDispatch | null> {
  if (hasNextDependency(pkg)) {
    const nextConfig = await findNextConfig(serviceDir)
    if (nextConfig) {
      return () => planNext(serviceDir, pkg, manifestPath, nextConfig, project)
    }
  }
  if (hasRemixDependency(pkg)) {
    const remixEntry = await findRemixEntry(serviceDir)
    if (remixEntry) {
      return () => planRemix(serviceDir, pkg, manifestPath, remixEntry, project)
    }
  }
  if (hasSvelteKitDependency(pkg)) {
    const hooks = await findSvelteKitHooks(serviceDir)
    const config = await findSvelteKitConfig(serviceDir)
    if (hooks || config) {
      return () => planSvelteKit(serviceDir, pkg, manifestPath, hooks, project)
    }
  }
  if (hasNuxtDependency(pkg)) {
    const nuxtConfig = await findNuxtConfig(serviceDir)
    if (nuxtConfig) {
      return () => planNuxt(serviceDir, pkg, manifestPath, project)
    }
  }
  if (hasAstroDependency(pkg)) {
    const astroConfig = await findAstroConfig(serviceDir)
    if (astroConfig) {
      return () => planAstro(serviceDir, pkg, manifestPath, project)
    }
  }
  return null
}

async function plan(serviceDir: string, opts?: PlanOptions): Promise<InstallPlan> {
  const pkg = await readPackageJson(serviceDir)
  const manifestPath = path.join(serviceDir, 'package.json')
  const project = opts?.project
  const empty: InstallPlan = {
    language: 'javascript',
    serviceDir,
    dependencyEdits: [],
    entrypointEdits: [],
    envEdits: [],
    generatedFiles: [],
  }
  if (!pkg) return empty

  // Issue #375 — classification pipeline order: lib-only → framework →
  // runtime-kind → emit. A package with no framework hook AND no resolvable
  // Node entry is lib-only regardless of stray Vite config or Expo deps. The
  // runtime-kind dispatch only fires for non-framework packages that
  // actually have an entry to instrument; without this ordering, a UI library
  // that ships a `vite.config.ts` for its build pipeline would bucket as
  // browser-bundle and surface in the operator summary as if it were a real
  // SPA the installer was choosing to skip.
  const frameworkDispatch = await findFrameworkDispatch(
    serviceDir,
    pkg,
    manifestPath,
    project,
  )

  // Resolve the Node entry up front so the lib-only check can read both
  // signals together. Skipped on the framework branch — frameworks own their
  // boot path and never need a `pkg.main` injection (the chain returns
  // before this line runs).
  let entryFile: string | null = null
  if (!frameworkDispatch) {
    entryFile = await resolveEntry(serviceDir, pkg)
    if (!entryFile) {
      return { ...empty, libOnly: true }
    }
  }

  if (frameworkDispatch) {
    return frameworkDispatch()
  }

  // Issue #370 — runtime-kind detection sits between the lib-only check and
  // vanilla Node template emission. Browser bundles (Vite) and React Native
  // / Expo packages bucket here so the apply phase skips every write and
  // surfaces the package in the summary instead of injecting a Node SDK hook
  // into code that can't run it.
  const runtimeKind = await detectRuntimeKind(serviceDir, pkg)
  if (runtimeKind !== 'node') {
    return { ...empty, runtimeKind }
  }

  // entryFile resolved above on the non-framework branch; the null path
  // already returned lib-only.
  if (!entryFile) {
    return { ...empty, libOnly: true }
  }
  const flavor = dispatchEntry(entryFile, pkg)
  const otelInitFile = path.join(path.dirname(entryFile), otelInitFilename(flavor))
  const envNeatFile = path.join(serviceDir, '.env.neat')

  // ── Dependency edits (four-deps invariant; ADR-069 §5). ────────────────
  // Issue #376 — non-bundled instrumentations append additional deps when
  // the host package declares libraries whose runtime traffic bypasses the
  // auto-instrumentation set (Prisma's Rust query engine for v0.4.5; the
  // v0.5.0 registry feeds the same loop with more entries).
  const existingDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const dependencyEdits: DependencyEdit[] = []
  for (const sdk of SDK_PACKAGES) {
    if (sdk.name in existingDeps) continue
    dependencyEdits.push({
      file: manifestPath,
      kind: 'add',
      name: sdk.name,
      version: sdk.version,
    })
  }
  const nonBundled = detectNonBundledInstrumentations(pkg)
  for (const inst of nonBundled) {
    if (inst.pkg in existingDeps) continue
    dependencyEdits.push({
      file: manifestPath,
      kind: 'add',
      name: inst.pkg,
      version: inst.version,
    })
  }

  // ── Entry-point injection edit (ADR-069 §3). ───────────────────────────
  const entrypointEdits: EntrypointEdit[] = []
  try {
    const raw = await fs.readFile(entryFile, 'utf8')
    const lines = raw.split(/\r?\n/)
    // Preserve a shebang on line 1 and check line 2 (the first non-shebang
    // line) for an existing injection.
    const firstReal = lines[0]?.startsWith('#!') ? lines[1] ?? '' : lines[0] ?? ''
    if (!lineIsOtelInjection(firstReal)) {
      const inject = injectionLine(flavor, entryFile, otelInitFile)
      // Use the existing first-real line as the `before` marker so the apply
      // phase can splice the injection cleanly even if the file shifts.
      entrypointEdits.push({
        file: entryFile,
        before: firstReal,
        after: inject,
      })
    }
  } catch {
    // Entry file disappeared between resolve and plan (rare). Treat as
    // lib-only.
    return { ...empty, libOnly: true }
  }

  // ── Generated files (ADR-069 §1, §4). ──────────────────────────────────
  // v0.4.4 — the otel-init template carries `__SERVICE_NAME__` (the
  // ServiceNode id) and `__PROJECT__` (the URL routing key) placeholders we
  // substitute here. The .env.neat shape lands with the same pair so an
  // operator can grep for both fields in one place.
  // v0.4.5 — `__INSTRUMENTATION_BLOCK__` substitutes to the registration
  // snippets for any non-bundled instrumentations detected above (Prisma
  // for v0.4.5; the v0.5.0 registry will feed more entries through the same
  // path). Empty list collapses cleanly to nothing.
  const svcName = serviceNodeName(pkg, serviceDir)
  const projectName = projectToken(pkg, serviceDir, project)
  const registrations = nonBundled.map((i) => i.registration)
  const generatedFiles: GeneratedFile[] = []
  const otelInitGen = await planOtelInitGeneration(
    otelInitFile,
    renderNodeOtelInit(otelInitContents(flavor), svcName, projectName, registrations),
  )
  if (otelInitGen) generatedFiles.push(otelInitGen)
  if (!(await exists(envNeatFile))) {
    generatedFiles.push({
      file: envNeatFile,
      contents: renderEnvNeat(svcName, projectName),
      skipIfExists: true,
    })
  }

  // ── Idempotency check (ADR-069 §6). ────────────────────────────────────
  // If the package is already instrumented end-to-end — deps present, entry
  // already injected, generated files already there — return an empty plan.
  if (
    dependencyEdits.length === 0 &&
    entrypointEdits.length === 0 &&
    generatedFiles.length === 0
  ) {
    return empty
  }

  return {
    language: 'javascript',
    serviceDir,
    dependencyEdits,
    entrypointEdits,
    envEdits: [OTEL_ENV],
    generatedFiles,
    entryFile,
    libOnly: false,
  }
}

// ADR-069 §7 + ADR-073 §1 + ADR-074 §3 — allowed write paths. Anything
// outside this set inside an installer's apply phase is a contract violation.
function isAllowedWritePath(serviceDir: string, target: string): boolean {
  const rel = path.relative(serviceDir, target)
  if (rel.startsWith('..')) return false
  const base = path.basename(target)
  if (base === 'package.json') return true
  if (base === '.env.neat') return true
  if (/^otel-init\.(?:js|cjs|mjs|ts)$/.test(base)) return true
  // ADR-073 §1 — Next framework files at the package root, or under src/
  // when create-next-app's --src-dir layout is in use. The instrumentation
  // hook resolves from `src/` in that layout; routing files there is the
  // load-bearing fix for the src-dir shape.
  const relPosix = rel.split(path.sep).join('/')
  if (/^instrumentation(?:\.node)?\.(?:js|cjs|mjs|ts)$/.test(base)) {
    if (relPosix === base) return true
    if (relPosix === `src/${base}`) return true
    return false
  }
  if (/^next\.config\.(?:js|mjs|ts)$/.test(base)) return true
  // ADR-074 §3 — meta-framework hook surfaces.
  if (relPosix === 'app/otel.server.ts' || relPosix === 'app/otel.server.js') return true
  if (/^app\/entry\.server\.(?:tsx?|jsx?)$/.test(relPosix)) return true
  if (relPosix === 'src/otel-init.ts' || relPosix === 'src/otel-init.js') return true
  if (relPosix === 'src/hooks.server.ts' || relPosix === 'src/hooks.server.js') return true
  if (relPosix === 'server/plugins/otel.ts' || relPosix === 'server/plugins/otel.js') return true
  if (relPosix === 'server/plugins/otel-init.ts' || relPosix === 'server/plugins/otel-init.js') return true
  if (relPosix === 'src/middleware.ts' || relPosix === 'src/middleware.js') return true
  return false
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  // Meta-framework branches write to convention-driven subdirs that the user
  // may not have scaffolded yet (`server/plugins/`, `src/`, `app/`). Ensure
  // the parent directory exists before the atomic write; existing parents
  // are a no-op under `recursive: true`.
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, contents, 'utf8')
  await fs.rename(tmp, file)
}

async function apply(installPlan: InstallPlan): Promise<ApplyResult> {
  const { serviceDir } = installPlan
  if (installPlan.libOnly) {
    return {
      serviceDir,
      outcome: 'lib-only',
      reason: 'no resolvable entry point',
      writtenFiles: [],
    }
  }

  // Issue #370 — non-Node runtimes write nothing. The CLI surfaces the
  // outcome in the summary so the operator can see which packages were
  // skipped and why.
  if (installPlan.runtimeKind === 'browser-bundle') {
    return {
      serviceDir,
      outcome: 'browser-bundle',
      reason: 'browser bundle; Node OTel SDK cannot run here',
      writtenFiles: [],
    }
  }
  if (installPlan.runtimeKind === 'react-native') {
    return {
      serviceDir,
      outcome: 'react-native',
      reason: 'React Native / Expo target; Node OTel SDK cannot run here',
      writtenFiles: [],
    }
  }

  // Already-instrumented check: an empty plan means there's nothing to do.
  if (
    installPlan.dependencyEdits.length === 0 &&
    installPlan.entrypointEdits.length === 0 &&
    (installPlan.generatedFiles?.length ?? 0) === 0 &&
    installPlan.nextConfigEdit === undefined
  ) {
    return {
      serviceDir,
      outcome: 'already-instrumented',
      writtenFiles: [],
    }
  }

  // Validate every target we plan to touch against the allowed-path set.
  // Bail out before any write if a violation slipped through.
  const allTargets = new Set<string>()
  for (const d of installPlan.dependencyEdits) allTargets.add(d.file)
  for (const e of installPlan.entrypointEdits) allTargets.add(e.file)
  for (const g of installPlan.generatedFiles ?? []) allTargets.add(g.file)
  if (installPlan.nextConfigEdit) allTargets.add(installPlan.nextConfigEdit.file)
  for (const target of allTargets) {
    // Entry-point edits land in user source files, not the allowed set —
    // they're explicitly carved out below.
    const isEntryEdit = installPlan.entrypointEdits.some((e) => e.file === target)
    if (isEntryEdit) continue
    if (!isAllowedWritePath(serviceDir, target)) {
      throw new Error(
        `javascript installer: refusing to write outside the allowed path set (ADR-069 §7): ${target}`,
      )
    }
  }

  // Snapshot every file we may touch so a partial failure can roll back the
  // batch (ADR-047 §7). Newly-generated files have no prior contents — they
  // get tracked separately so rollback unlinks them instead of restoring.
  const originals = new Map<string, string>()
  const createdFiles: string[] = []
  for (const target of allTargets) {
    if (await exists(target)) {
      try {
        originals.set(target, await fs.readFile(target, 'utf8'))
      } catch {
        // Best-effort. The mutation loop below will throw if this matters.
      }
    }
  }

  const writtenFiles: string[] = []
  try {
    // ── 1. Manifest edits (package.json) ─────────────────────────────────
    const manifestTargets = installPlan.dependencyEdits
      .reduce<Set<string>>((acc, e) => {
        acc.add(e.file)
        return acc
      }, new Set())
    for (const file of manifestTargets) {
      const raw = originals.get(file)
      if (raw === undefined) {
        throw new Error(`javascript installer: cannot read ${file} during apply`)
      }
      const pkg = JSON.parse(raw) as PackageJsonShape
      pkg.dependencies = pkg.dependencies ?? {}
      for (const dep of installPlan.dependencyEdits) {
        if (dep.file !== file) continue
        if (dep.kind === 'add') {
          if (!(dep.name in (pkg.dependencies ?? {}))) {
            pkg.dependencies[dep.name] = dep.version
          }
          // No version bump on existing entries (ADR-069 §6).
        } else {
          delete pkg.dependencies[dep.name]
        }
      }
      const newRaw = JSON.stringify(pkg, null, 2) + '\n'
      await writeAtomic(file, newRaw)
      writtenFiles.push(file)
    }

    // ── 2. Generated files (otel-init, .env.neat) ────────────────────────
    for (const gen of installPlan.generatedFiles ?? []) {
      if (gen.skipIfExists && (await exists(gen.file))) {
        // Skip silently; the contract treats this as part of the
        // already-instrumented path.
        continue
      }
      await writeAtomic(gen.file, gen.contents)
      if (!originals.has(gen.file)) createdFiles.push(gen.file)
      writtenFiles.push(gen.file)
    }

    // ── 3. Entry-point injection (require/import on first non-shebang line)
    for (const ep of installPlan.entrypointEdits) {
      const raw = originals.get(ep.file)
      if (raw === undefined) {
        throw new Error(`javascript installer: cannot read entry ${ep.file} during apply`)
      }
      const lines = raw.split(/\r?\n/)
      const hasShebang = lines[0]?.startsWith('#!') ?? false
      const insertAt = hasShebang ? 1 : 0
      // Idempotency: if the first non-shebang line already matches our
      // injection pattern, skip — never double-inject.
      const firstReal = lines[insertAt] ?? ''
      if (lineIsOtelInjection(firstReal)) continue
      lines.splice(insertAt, 0, ep.after)
      const newRaw = lines.join('\n')
      await writeAtomic(ep.file, newRaw)
      writtenFiles.push(ep.file)
    }

    // ── 4. Next.js config flag (ADR-073 §1) — only present on the Next
    // path when the declared major is < 15 and the flag isn't already
    // mentioned in the file. Best-effort regex insertion into the first
    // config object literal; bails silently when the shape isn't
    // recognisable so we never corrupt a user-customised config.
    if (installPlan.nextConfigEdit) {
      const target = installPlan.nextConfigEdit.file
      const raw = originals.get(target)
      if (raw !== undefined && !raw.includes('instrumentationHook')) {
        const updated = injectInstrumentationHook(raw)
        if (updated !== null) {
          await writeAtomic(target, updated)
          writtenFiles.push(target)
        }
      }
    }
  } catch (err) {
    await rollback(installPlan, originals, createdFiles)
    throw err
  }

  return {
    serviceDir,
    outcome: 'instrumented',
    writtenFiles,
  }
}

async function rollback(
  installPlan: InstallPlan,
  originals: Map<string, string>,
  createdFiles: string[],
): Promise<void> {
  const restored: string[] = []
  const removed: string[] = []
  for (const [file, raw] of originals.entries()) {
    try {
      await fs.writeFile(file, raw, 'utf8')
      restored.push(file)
    } catch {
      // Best-effort: keep going so we restore as much as we can.
    }
  }
  for (const file of createdFiles) {
    try {
      await fs.unlink(file)
      removed.push(file)
    } catch {
      // Best-effort.
    }
  }
  const lines = [
    '# neat-rollback.patch',
    '',
    `# Generated after a partial apply failure in the ${installPlan.language} installer.`,
    '# Files listed below were restored to their pre-apply contents.',
    '',
    ...restored.map((f) => `restored: ${f}`),
    ...removed.map((f) => `removed:  ${f}`),
    '',
  ]
  const rollbackPath = path.join(installPlan.serviceDir, 'neat-rollback.patch')
  await fs.writeFile(rollbackPath, lines.join('\n'), 'utf8')
}

// ADR-073 §1 — best-effort injection of `experimental.instrumentationHook:
// true` into a next.config.{js,ts,mjs}. Returns the rewritten contents on
// success, or null when the config shape isn't recognisable (in which case
// the apply phase leaves the file alone — partial Next coverage is fine,
// silent corruption of a user's config is not).
//
// Recognised shapes:
//   - `module.exports = { ... }` (CJS)
//   - `module.exports = { ... } satisfies NextConfig` (TS-via-CJS)
//   - `export default { ... }` (ESM / TS)
//   - `const nextConfig = { ... }; module.exports = nextConfig` (named CJS)
//   - `const nextConfig: NextConfig = { ... }; export default nextConfig` (TS)
export function injectInstrumentationHook(raw: string): string | null {
  if (raw.includes('instrumentationHook')) return raw

  // Strategy: find the first config object literal whose contents we can
  // edit, then either merge into an existing `experimental: { ... }` block
  // or insert a fresh `experimental: { instrumentationHook: true }` entry.
  //
  // We look for one of four anchors near a top-level `{` and splice from
  // there. The regexes capture the `{` so we can splice right after it.
  const anchors: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /(module\.exports\s*=\s*\{)/, label: 'cjs-default' },
    { pattern: /(export\s+default\s*\{)/, label: 'esm-default' },
    { pattern: /(?:const|let|var)\s+\w+(?:\s*:\s*[^=]+)?\s*=\s*(\{)/, label: 'named-config' },
  ]

  for (const { pattern } of anchors) {
    const match = pattern.exec(raw)
    if (!match) continue
    const insertAfter = match.index + match[0].length
    const before = raw.slice(0, insertAfter)
    const after = raw.slice(insertAfter)
    // Insert a leading newline so the injection sits on its own line and
    // doesn't fight any existing trailing-comma style. Two-space indent
    // covers most code-styled configs.
    const injection = '\n  experimental: { instrumentationHook: true },'
    return `${before}${injection}${after}`
  }

  return null
}

export const javascriptInstaller: Installer = {
  name: 'javascript',
  detect,
  plan,
  apply,
}

// Re-exports used by the contract test surface.
export { NEXT_INSTRUMENTATION_HEADER, OTEL_INIT_HEADER }

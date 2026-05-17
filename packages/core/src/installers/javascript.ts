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
} from './shared.js'
import {
  OTEL_INIT_CJS,
  OTEL_INIT_ESM,
  OTEL_INIT_HEADER,
  OTEL_INIT_TS,
  renderEnvNeat,
} from './templates.js'

const SDK_PACKAGES = [
  { name: '@opentelemetry/api', version: '^1.9.0' },
  { name: '@opentelemetry/sdk-node', version: '^0.57.0' },
  { name: '@opentelemetry/auto-instrumentations-node', version: '^0.55.0' },
  // ADR-069 §5 — dotenv is the fourth dep. The generated otel-init loads
  // .env.neat through it so OTEL_SERVICE_NAME and the endpoint are in scope
  // before the auto-instrumentation hook attaches.
  { name: 'dotenv', version: '^16.4.5' },
] as const

const OTEL_ENV: EnvEdit = {
  // ADR-069 §4 — endpoint moves into the per-package .env.neat (written
  // by the apply phase). The envEdits surface stays for the dry-run
  // patch render: it documents the key/value the user can inspect in the
  // generated .env.neat.
  file: null,
  key: 'OTEL_EXPORTER_OTLP_ENDPOINT',
  value: 'http://localhost:4318',
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

async function detect(serviceDir: string): Promise<boolean> {
  const pkg = await readPackageJson(serviceDir)
  return pkg !== null && typeof pkg.name === 'string'
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

async function plan(serviceDir: string): Promise<InstallPlan> {
  const pkg = await readPackageJson(serviceDir)
  const manifestPath = path.join(serviceDir, 'package.json')
  const empty: InstallPlan = {
    language: 'javascript',
    serviceDir,
    dependencyEdits: [],
    entrypointEdits: [],
    envEdits: [],
    generatedFiles: [],
  }
  if (!pkg) return empty

  // ADR-069 §2 — entry resolution before anything else. No entry → lib-only.
  const entryFile = await resolveEntry(serviceDir, pkg)
  if (!entryFile) {
    return { ...empty, libOnly: true }
  }
  const flavor = dispatchEntry(entryFile, pkg)
  const otelInitFile = path.join(path.dirname(entryFile), otelInitFilename(flavor))
  const envNeatFile = path.join(serviceDir, '.env.neat')

  // ── Dependency edits (four-deps invariant; ADR-069 §5). ────────────────
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
  const generatedFiles: GeneratedFile[] = []
  if (!(await exists(otelInitFile))) {
    generatedFiles.push({
      file: otelInitFile,
      contents: otelInitContents(flavor),
      skipIfExists: true,
    })
  }
  if (!(await exists(envNeatFile))) {
    generatedFiles.push({
      file: envNeatFile,
      contents: renderEnvNeat(pkg.name ?? path.basename(serviceDir)),
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

// ADR-069 §7 — allowed write paths. Anything outside this set inside an
// installer's apply phase is a contract violation.
function isAllowedWritePath(serviceDir: string, target: string): boolean {
  const rel = path.relative(serviceDir, target)
  if (rel.startsWith('..')) return false
  const base = path.basename(target)
  if (base === 'package.json') return true
  if (base === '.env.neat') return true
  if (/^otel-init\.(?:js|cjs|mjs|ts)$/.test(base)) return true
  return false
}

async function writeAtomic(file: string, contents: string): Promise<void> {
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

  // Already-instrumented check: an empty plan means there's nothing to do.
  if (
    installPlan.dependencyEdits.length === 0 &&
    installPlan.entrypointEdits.length === 0 &&
    (installPlan.generatedFiles?.length ?? 0) === 0
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

export const javascriptInstaller: Installer = {
  name: 'javascript',
  detect,
  plan,
  apply,
}

// Re-exports used by the contract test surface.
export { OTEL_INIT_HEADER }

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolve as registryResolve, list as registryList } from '@neat.is/instrumentation-registry'
import {
  detectPackageManager,
  runPackageManagerInstall,
} from '../installers/package-manager.js'

export interface ExtendContext {
  project: string
  scanPath: string
}

export interface LibraryCoverageResult {
  library: string
  coverage: 'bundled' | 'first-party' | 'third-party' | 'http-only' | 'gap'
  installedVersion?: string
  instrumentation_package?: string
  package_version?: string
  registration?: string
  notes?: string
}

export interface ProjectInstrumentationState {
  hookFiles: string[]
  envNeat: boolean
  installedDeps: Record<string, string>
}

export interface ExtensionApplyResult {
  library: string
  filesTouched: string[]
  depsAdded: string[]
  installOutput: string
  alreadyApplied: boolean
}

export interface ExtensionDiff {
  library: string
  filesTouched: string[]
  depsToAdd: string[]
  packageJsonPatch: object
  templatePatch: string
}

interface PackageJson {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

interface ExtendLogEntry {
  timestamp: string
  project: string
  library: string
  instrumentation_package: string
  version: string
  registration_snippet: string
  filesTouched: string[]
  depsAdded: string[]
  installOutput: string
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readPackageJson(scanPath: string): Promise<PackageJson> {
  const pkgPath = path.join(scanPath, 'package.json')
  const raw = await fs.readFile(pkgPath, 'utf8')
  return JSON.parse(raw) as PackageJson
}

// Directories the hook-file walk never descends into: dependency trees, VCS
// metadata, build output, and NEAT's own output dir. None can hold a user's
// instrumentation hook, and node_modules especially would make the walk crawl.
// Every dot-prefixed directory (`.git`, `.next`, `.turbo`, `.vercel`, …) is
// skipped too — a generated hook never lands in one.
const HOOK_WALK_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'neat-out',
])

// Locate every OTel init hook in the project: a file whose basename starts with
// `instrumentation` or `otel-init` in any JS/TS module flavor (js/ts/cjs/mjs).
// The orchestrator writes the hook adjacent to the resolved entry — commonly a
// subdirectory like `src/otel-init.cjs` for an app whose entry is
// `src/index.js` — and the Next branch writes `instrumentation.node.{ts,js}`
// under `src/` for --src-dir layouts, so the search walks the whole tree rather
// than reading the root alone (#823). Paths come back relative to scanPath;
// every caller re-joins them with `path.join(scanPath, file)`.
async function findHookFiles(scanPath: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || HOOK_WALK_SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        if (
          (entry.name.startsWith('instrumentation') || entry.name.startsWith('otel-init')) &&
          /\.(ts|js|cjs|mjs)$/.test(entry.name)
        ) {
          const rel = path.relative(scanPath, path.join(dir, entry.name))
          // Normalise to forward slashes so the returned path is stable across
          // platforms and re-joins cleanly (path.join accepts `/` everywhere).
          found.push(rel.split(path.sep).join('/'))
        }
      }
    }
  }
  await walk(scanPath)
  return found.sort()
}

// Choose which hook file the registration snippet splices into. A project can
// carry several (Next writes instrumentation.{,node,edge}.{ts,js}; a monorepo
// may keep one per package), but only the file that constructs the SDK has an
// insertion point — the edge file registers via `@vercel/otel` and sorts first
// alphabetically, so `hookFiles[0]` would be the wrong target. Prefer the first
// hook file that splices cleanly and hand back its patched contents; fall back
// to the first hook file so the caller still emits a precise "no insertion
// point" error naming a real file.
async function pickPrimaryHookFile(
  scanPath: string,
  hookFiles: string[],
  snippet: string,
): Promise<{ file: string; content: string; patched: string | null }> {
  let fallback: { file: string; content: string } | null = null
  for (const file of hookFiles) {
    const content = await fs.readFile(path.join(scanPath, file), 'utf8')
    const patched = splicedContent(content, snippet)
    if (patched !== null) return { file, content, patched }
    if (fallback === null) fallback = { file, content }
  }
  return { file: fallback!.file, content: fallback!.content, patched: null }
}

function extendLogPath(): string {
  return process.env.NEAT_EXTEND_LOG ?? path.join(os.homedir(), '.neat', 'extend-log.ndjson')
}

async function appendExtendLog(entry: ExtendLogEntry): Promise<void> {
  const logPath = extendLogPath()
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  await fs.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8')
}

// Insert `snippet` into `fileContent` at the instrumentation array.
// Tries __INSTRUMENTATION_BLOCK__ first, then last instrumentations.push(,
// then before new NodeSDK(. Returns null if no insertion point is found.
function splicedContent(fileContent: string, snippet: string): string | null {
  if (fileContent.includes('__INSTRUMENTATION_BLOCK__')) {
    return fileContent.replace('__INSTRUMENTATION_BLOCK__', `${snippet}\n__INSTRUMENTATION_BLOCK__`)
  }

  const lines = fileContent.split('\n')

  let lastPushIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('instrumentations.push(')) lastPushIdx = i
  }
  if (lastPushIdx >= 0) {
    lines.splice(lastPushIdx + 1, 0, snippet)
    return lines.join('\n')
  }

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('new NodeSDK(')) {
      lines.splice(i, 0, snippet)
      return lines.join('\n')
    }
  }

  return null
}

export async function listUninstrumented(ctx: ExtendContext): Promise<LibraryCoverageResult[]> {
  const pkg = await readPackageJson(ctx.scanPath)
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }

  const results: LibraryCoverageResult[] = []
  for (const [library, installedVersion] of Object.entries(allDeps)) {
    const entry = registryResolve(library, installedVersion)
    if (!entry) continue
    if (entry.coverage === 'bundled' || entry.coverage === 'http-only') continue
    results.push({
      library,
      coverage: entry.coverage,
      installedVersion,
      instrumentation_package: entry.instrumentation_package,
      package_version: entry.package_version,
      registration: entry.registration,
      notes: entry.notes,
    })
  }
  return results
}

export function lookupInstrumentation(
  library: string,
  installedVersion?: string,
): LibraryCoverageResult | null {
  const entry = registryResolve(library, installedVersion)
  if (!entry) return null
  return {
    library: entry.library,
    coverage: entry.coverage,
    instrumentation_package: entry.instrumentation_package,
    package_version: entry.package_version,
    registration: entry.registration,
    notes: entry.notes,
  }
}

export async function describeProjectInstrumentation(
  ctx: ExtendContext,
): Promise<ProjectInstrumentationState> {
  const hookFiles = await findHookFiles(ctx.scanPath)
  const envNeat = await fileExists(path.join(ctx.scanPath, '.env.neat'))

  const registryInstrPackages = new Set<string>(
    registryList()
      .map((e) => e.instrumentation_package)
      .filter((p): p is string => !!p),
  )

  const pkg = await readPackageJson(ctx.scanPath)
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }

  const installedDeps: Record<string, string> = {}
  for (const [key, version] of Object.entries(allDeps)) {
    if (key.startsWith('@opentelemetry/') || registryInstrPackages.has(key)) {
      installedDeps[key] = version
    }
  }

  return { hookFiles, envNeat, installedDeps }
}

export async function applyExtension(
  ctx: ExtendContext,
  args: {
    library: string
    instrumentation_package: string
    version: string
    registration_snippet: string
  },
  options?: {
    runInstall?: typeof runPackageManagerInstall
  },
): Promise<ExtensionApplyResult> {
  const hookFiles = await findHookFiles(ctx.scanPath)

  if (hookFiles.length === 0) {
    throw new Error(
      `No instrumentation hook files found in ${ctx.scanPath}. Run \`neat init\` first.`,
    )
  }

  // Idempotency check: scan all hook files for the snippet
  for (const file of hookFiles) {
    const content = await fs.readFile(path.join(ctx.scanPath, file), 'utf8')
    if (content.includes(args.registration_snippet)) {
      return { library: args.library, filesTouched: [], depsAdded: [], installOutput: '', alreadyApplied: true }
    }
  }

  // Resolve the hook file to splice into, and confirm it has an insertion point
  // BEFORE touching package.json — otherwise a snippet that can't splice would
  // leave a dep added with no matching registration.
  const primary = await pickPrimaryHookFile(ctx.scanPath, hookFiles, args.registration_snippet)
  if (primary.patched === null) {
    throw new Error(
      `Could not find instrumentation insertion point in ${hookFiles.join(', ')}. ` +
        'Expected __INSTRUMENTATION_BLOCK__, instrumentations.push(, or new NodeSDK(.',
    )
  }
  const primaryFile = primary.file
  const primaryPath = path.join(ctx.scanPath, primaryFile)
  const filesTouched: string[] = []
  const depsAdded: string[] = []

  // 1. Add dep to package.json if not already present
  const pkgPath = path.join(ctx.scanPath, 'package.json')
  const pkg = await readPackageJson(ctx.scanPath)
  if (!(pkg.dependencies ?? {})[args.instrumentation_package]) {
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [args.instrumentation_package]: args.version }
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    filesTouched.push('package.json')
    depsAdded.push(`${args.instrumentation_package}@${args.version}`)
  }

  // 2. Splice registration snippet into the resolved hook file
  await fs.writeFile(primaryPath, primary.patched, 'utf8')
  filesTouched.push(primaryFile)

  // 3. Run package manager install
  const cmd = await detectPackageManager(ctx.scanPath)
  const installer = options?.runInstall ?? runPackageManagerInstall
  const install = await installer(cmd)
  const installOutput =
    install.exitCode === 0
      ? `${cmd.pm} install succeeded`
      : install.stderr || `${cmd.pm} install failed (exit ${install.exitCode})`

  // 4. Log the apply
  await appendExtendLog({
    timestamp: new Date().toISOString(),
    project: ctx.project,
    library: args.library,
    instrumentation_package: args.instrumentation_package,
    version: args.version,
    registration_snippet: args.registration_snippet,
    filesTouched,
    depsAdded,
    installOutput,
  })

  return { library: args.library, filesTouched, depsAdded, installOutput, alreadyApplied: false }
}

export async function dryRunExtension(
  ctx: ExtendContext,
  args: {
    library: string
    instrumentation_package: string
    version: string
    registration_snippet: string
  },
): Promise<ExtensionDiff> {
  const hookFiles = await findHookFiles(ctx.scanPath)

  if (hookFiles.length === 0) {
    return {
      library: args.library,
      filesTouched: [],
      depsToAdd: [],
      packageJsonPatch: {},
      templatePatch: "No hook files found. Run 'neat init' first.",
    }
  }

  for (const file of hookFiles) {
    const content = await fs.readFile(path.join(ctx.scanPath, file), 'utf8')
    if (content.includes(args.registration_snippet)) {
      return {
        library: args.library,
        filesTouched: [],
        depsToAdd: [],
        packageJsonPatch: {},
        templatePatch: 'Already applied — no changes would be made.',
      }
    }
  }

  const primary = await pickPrimaryHookFile(ctx.scanPath, hookFiles, args.registration_snippet)
  const filesTouched: string[] = []
  const depsToAdd: string[] = []
  let packageJsonPatch: object = {}
  let templatePatch = ''

  const pkg = await readPackageJson(ctx.scanPath)
  if (!(pkg.dependencies ?? {})[args.instrumentation_package]) {
    packageJsonPatch = { dependencies: { [args.instrumentation_package]: args.version } }
    depsToAdd.push(`${args.instrumentation_package}@${args.version}`)
    filesTouched.push('package.json')
  }

  if (primary.patched !== null) {
    filesTouched.push(primary.file)
    templatePatch = `+ ${args.registration_snippet}`
  } else {
    templatePatch = 'Could not find insertion point in hook file.'
  }

  return { library: args.library, filesTouched, depsToAdd, packageJsonPatch, templatePatch }
}

export async function rollbackExtension(
  ctx: ExtendContext,
  args: { library: string },
): Promise<{ undone: boolean; message: string }> {
  const logPath = extendLogPath()

  if (!(await fileExists(logPath))) {
    return { undone: false, message: 'no apply found for library' }
  }

  const raw = await fs.readFile(logPath, 'utf8')
  const entries: ExtendLogEntry[] = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExtendLogEntry)

  const match = [...entries]
    .reverse()
    .find((e) => e.project === ctx.project && e.library === args.library)

  if (!match) {
    return { undone: false, message: 'no apply found for library' }
  }

  // Remove dep from package.json
  const pkgPath = path.join(ctx.scanPath, 'package.json')
  if (await fileExists(pkgPath)) {
    const pkg = await readPackageJson(ctx.scanPath)
    if (pkg.dependencies?.[match.instrumentation_package]) {
      const { [match.instrumentation_package]: _removed, ...rest } = pkg.dependencies
      pkg.dependencies = rest
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    }
  }

  // Remove the registration snippet from hook files (no re-install — user owns the lockfile)
  const hookFiles = await findHookFiles(ctx.scanPath)
  for (const file of hookFiles) {
    const filePath = path.join(ctx.scanPath, file)
    const content = await fs.readFile(filePath, 'utf8')
    if (content.includes(match.registration_snippet)) {
      const filtered = content
        .split('\n')
        .filter((line) => !line.includes(match.registration_snippet))
        .join('\n')
      await fs.writeFile(filePath, filtered, 'utf8')
      break
    }
  }

  return {
    undone: true,
    message: `rolled back ${match.library} (${match.instrumentation_package})`,
  }
}

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

async function findHookFiles(scanPath: string): Promise<string[]> {
  const entries = await fs.readdir(scanPath)
  return entries
    .filter(
      (e) =>
        (e.startsWith('instrumentation') || e.startsWith('otel-init')) &&
        /\.(ts|js)$/.test(e),
    )
    .sort()
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

  const primaryFile = hookFiles[0]!
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

  // 2. Splice registration snippet into hook file
  const hookContent = await fs.readFile(primaryPath, 'utf8')
  const patched = splicedContent(hookContent, args.registration_snippet)
  if (!patched) {
    throw new Error(
      `Could not find instrumentation insertion point in ${primaryFile}. ` +
        'Expected __INSTRUMENTATION_BLOCK__, instrumentations.push(, or new NodeSDK(.',
    )
  }
  await fs.writeFile(primaryPath, patched, 'utf8')
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

  const primaryFile = hookFiles[0]!
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

  const hookContent = await fs.readFile(path.join(ctx.scanPath, primaryFile), 'utf8')
  const patched = splicedContent(hookContent, args.registration_snippet)
  if (patched) {
    filesTouched.push(primaryFile)
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

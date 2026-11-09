import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import semver from 'semver'
import compatData from '../compat.json' with { type: 'json' }

export interface CompatibilityResult {
  compatible: boolean
  reason?: string
  minDriverVersion?: string
}

export interface CompatPair {
  kind?: 'driver-engine'
  driver: string
  engine: string
  minDriverVersion: string
  // The driver constraint only kicks in once the engine is at this major or higher.
  // Older engines (e.g. PostgreSQL 13) accept the older driver fine.
  minEngineVersion?: string
  reason: string
}

export interface NodeEngineConstraint {
  kind?: 'node-engine'
  package: string
  packageMinVersion?: string
  minNodeVersion: string
  reason: string
}

export interface PackageConflict {
  kind?: 'package-conflict'
  package: string
  packageMinVersion?: string
  requires: { name: string; minVersion: string }
  reason: string
}

export interface DeprecatedApi {
  kind?: 'deprecated-api'
  package: string
  packageMaxVersion?: string
  reason: string
}

// A feature-flag store provider (ADR-242). The flag grain is provider-neutral; a
// provider's name is data, read here, and never a branch in the reasoning core.
// `schemaPattern` is the substring of a flag file's `$schema` that names it.
export interface FlagStoreProvider {
  provider: string
  schemaPattern: string
  reason?: string
}

export interface CompatMatrix {
  pairs: CompatPair[]
  nodeEngineConstraints?: NodeEngineConstraint[]
  packageConflicts?: PackageConflict[]
  deprecatedApis?: DeprecatedApi[]
  flagStores?: FlagStoreProvider[]
}

const bundledMatrix = compatData as CompatMatrix
let mergedMatrix: CompatMatrix | null = null
let remoteLoadAttempted = false

const REMOTE_CACHE_DIR = path.join(os.homedir(), '.neat')
const REMOTE_CACHE_PATH = path.join(REMOTE_CACHE_DIR, 'compat-cache.json')
const REMOTE_TTL_MS = 24 * 60 * 60 * 1000

interface RemoteCacheFile {
  fetchedAt: string
  url: string
  matrix: CompatMatrix
}

// Engines like Postgres/MySQL only carry a major in the version field, so semver
// won't always parse them cleanly. Compare as integers when both sides look like
// majors; otherwise fall back to semver.coerce.
function engineMeetsThreshold(engineVersion: string, threshold: string): boolean {
  const e = parseInt(engineVersion, 10)
  const t = parseInt(threshold, 10)
  if (Number.isFinite(e) && Number.isFinite(t)) return e >= t

  const ec = semver.coerce(engineVersion)
  const tc = semver.coerce(threshold)
  if (ec && tc) return semver.gte(ec, tc)

  return false
}

export function checkCompatibility(
  driver: string,
  driverVersion: string,
  engine: string,
  engineVersion: string,
): CompatibilityResult {
  const matrix = currentMatrix()
  const pair = matrix.pairs.find((p) => p.driver === driver && p.engine === engine)
  if (!pair) return { compatible: true }

  if (pair.minEngineVersion && !engineMeetsThreshold(engineVersion, pair.minEngineVersion)) {
    return { compatible: true }
  }

  const driverCoerced = semver.coerce(driverVersion)
  if (!driverCoerced) return { compatible: true }

  if (semver.lt(driverCoerced, pair.minDriverVersion)) {
    return {
      compatible: false,
      reason: pair.reason,
      minDriverVersion: pair.minDriverVersion,
    }
  }

  return { compatible: true }
}

export interface NodeEngineCheck {
  compatible: boolean
  reason?: string
  requiredNodeVersion?: string
}

// True when `serviceNodeRange` (a service's `engines.node`) is guaranteed to
// admit `requiredNodeVersion`. We use a permissive semver compare via `coerce`
// — exact ranges like ">=20" parse fine, exotic ones like "^20 || ^22" pass as
// long as semver can resolve them. If the range can't be parsed at all, we
// don't claim a conflict — under-flag rather than over-flag.
function rangeAdmitsVersion(serviceNodeRange: string, requiredNodeVersion: string): boolean {
  try {
    const required = semver.coerce(requiredNodeVersion)
    if (!required) return true
    // Is every version that satisfies the service's range >= required? If yes,
    // the service guarantees the requirement; if not, there's at least one
    // admissible Node version that won't satisfy the dep — that's the
    // conflict.
    return semver.subset(serviceNodeRange, `>=${required.version}`, {
      includePrerelease: false,
    })
  } catch {
    return true
  }
}

export function checkNodeEngineConstraint(
  constraint: NodeEngineConstraint,
  declaredPackageVersion: string | undefined,
  serviceNodeRange: string | undefined,
): NodeEngineCheck {
  if (constraint.packageMinVersion && declaredPackageVersion) {
    const v = semver.coerce(declaredPackageVersion)
    if (v && semver.lt(v, constraint.packageMinVersion)) {
      return { compatible: true }
    }
  }
  if (!serviceNodeRange) {
    return { compatible: true }
  }
  if (rangeAdmitsVersion(serviceNodeRange, constraint.minNodeVersion)) {
    return { compatible: true }
  }
  return {
    compatible: false,
    reason: constraint.reason,
    requiredNodeVersion: constraint.minNodeVersion,
  }
}

export interface PackageConflictCheck {
  compatible: boolean
  reason?: string
  requires?: { name: string; minVersion: string }
  foundVersion?: string
}

export function checkPackageConflict(
  conflict: PackageConflict,
  declaredPackageVersion: string | undefined,
  declaredRequiredVersion: string | undefined,
): PackageConflictCheck {
  if (!declaredPackageVersion) return { compatible: true }
  if (conflict.packageMinVersion) {
    const v = semver.coerce(declaredPackageVersion)
    if (v && semver.lt(v, conflict.packageMinVersion)) {
      return { compatible: true }
    }
  }
  if (!declaredRequiredVersion) {
    return {
      compatible: false,
      reason: conflict.reason,
      requires: conflict.requires,
    }
  }
  const requiredCoerced = semver.coerce(declaredRequiredVersion)
  if (!requiredCoerced) return { compatible: true }
  if (semver.lt(requiredCoerced, conflict.requires.minVersion)) {
    return {
      compatible: false,
      reason: conflict.reason,
      requires: conflict.requires,
      foundVersion: declaredRequiredVersion,
    }
  }
  return { compatible: true }
}

export function checkDeprecatedApi(
  rule: DeprecatedApi,
  declaredVersion: string | undefined,
): { compatible: boolean; reason?: string } {
  if (declaredVersion === undefined) return { compatible: true }
  if (rule.packageMaxVersion) {
    const v = semver.coerce(declaredVersion)
    const max = semver.coerce(rule.packageMaxVersion)
    if (v && max && semver.gt(v, max)) return { compatible: true }
  }
  return { compatible: false, reason: rule.reason }
}

function currentMatrix(): CompatMatrix {
  return mergedMatrix ?? bundledMatrix
}

function mergeMatrices(a: CompatMatrix, b: CompatMatrix): CompatMatrix {
  return {
    pairs: [...a.pairs, ...(b.pairs ?? [])],
    nodeEngineConstraints: [
      ...(a.nodeEngineConstraints ?? []),
      ...(b.nodeEngineConstraints ?? []),
    ],
    packageConflicts: [...(a.packageConflicts ?? []), ...(b.packageConflicts ?? [])],
    deprecatedApis: [...(a.deprecatedApis ?? []), ...(b.deprecatedApis ?? [])],
    flagStores: [...(a.flagStores ?? []), ...(b.flagStores ?? [])],
  }
}

async function readRemoteCache(url: string): Promise<CompatMatrix | null> {
  try {
    const raw = await fs.readFile(REMOTE_CACHE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as RemoteCacheFile
    if (parsed.url !== url) return null
    const age = Date.now() - new Date(parsed.fetchedAt).getTime()
    if (age > REMOTE_TTL_MS) return null
    return parsed.matrix
  } catch {
    return null
  }
}

async function writeRemoteCache(url: string, matrix: CompatMatrix): Promise<void> {
  const file: RemoteCacheFile = {
    fetchedAt: new Date().toISOString(),
    url,
    matrix,
  }
  try {
    await fs.mkdir(REMOTE_CACHE_DIR, { recursive: true })
    await fs.writeFile(REMOTE_CACHE_PATH, JSON.stringify(file), 'utf8')
  } catch (err) {
    console.warn(`[neat] failed to cache compat matrix: ${(err as Error).message}`)
  }
}

// Loads the bundled matrix and, if `NEAT_COMPAT_URL` is set, merges in a
// remote extension. Falls back to a fresh fetch when the on-disk cache is
// stale (24h TTL) or missing. Returns the merged matrix; subsequent calls are
// memoised.
//
// Async because the fetch happens lazily on first use. Extract phase 2 awaits
// this before iterating pairs; everything else goes through the sync
// `currentMatrix()` view, which is fine because by the time CLI / traversal
// runs, extraction has already loaded.
export async function ensureCompatLoaded(): Promise<CompatMatrix> {
  if (mergedMatrix) return mergedMatrix
  if (remoteLoadAttempted) {
    mergedMatrix = bundledMatrix
    return mergedMatrix
  }
  remoteLoadAttempted = true

  const url = process.env.NEAT_COMPAT_URL
  if (!url) {
    mergedMatrix = bundledMatrix
    return mergedMatrix
  }

  const cached = await readRemoteCache(url)
  if (cached) {
    mergedMatrix = mergeMatrices(bundledMatrix, cached)
    return mergedMatrix
  }

  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const remote = (await res.json()) as CompatMatrix
    await writeRemoteCache(url, remote)
    mergedMatrix = mergeMatrices(bundledMatrix, remote)
    return mergedMatrix
  } catch (err) {
    console.warn(
      `[neat] NEAT_COMPAT_URL fetch failed (${(err as Error).message}); using bundled matrix only`,
    )
    mergedMatrix = bundledMatrix
    return mergedMatrix
  }
}

// Reset the merged-matrix memo. Intended for tests so each test starts with a
// freshly loaded matrix.
export function resetCompatMatrix(): void {
  mergedMatrix = null
  remoteLoadAttempted = false
}

export function compatPairs(): readonly CompatPair[] {
  return currentMatrix().pairs
}

export function nodeEngineConstraints(): readonly NodeEngineConstraint[] {
  return currentMatrix().nodeEngineConstraints ?? []
}

export function packageConflicts(): readonly PackageConflict[] {
  return currentMatrix().packageConflicts ?? []
}

export function deprecatedApis(): readonly DeprecatedApi[] {
  return currentMatrix().deprecatedApis ?? []
}

export function flagStoreProviders(): readonly FlagStoreProvider[] {
  return currentMatrix().flagStores ?? []
}

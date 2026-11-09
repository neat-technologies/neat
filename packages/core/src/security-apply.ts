// The fix-apply step (ADR-274): take a security card's proposed fix.action (G2,
// advisories/fix-action.ts) and apply it deterministically to the manifest and
// lockfile, then re-verify with scan_diff (G1, security-diff.ts) that the card's
// advisory is gone and no new one was introduced. This is the line between NEAT
// flagging a vulnerability and NEAT fixing it.
//
// Scope:
// - Security axis only. scan_diff re-verifies the vulnerability set; the
//   0-regression check (running the project's tests) is the runner, parked.
// - npm only in v0 (package.json + package-lock.json v2/v3). PyPI and Go follow.
// - No package manager is invoked. The manifest and lockfile edits are pure, and
//   a real `npm install` in the user's repo or CI reconciles integrity and the
//   full transitive tree afterward. The lockfile's resolved version is what the
//   extractor reads, so that edit alone lets scan_diff see the fix.
// - Only `bump-to-fixedIn` is applied. `remove-or-replace` has no deterministic
//   target (it is a breaking bump or no fix at all), so it is reported, never
//   guessed, and the caller never mistakes "not handled" for "fixed".

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SecurityCard, SecurityDiff, SecurityFixAction } from '@neat.is/types'
import { scanDiffLocal, type ScanDiffOptions } from './security-diff.js'

export interface FileEdit {
  // Repo-relative path of the edited file.
  file: string
  change: 'manifest-spec' | 'manifest-override' | 'lockfile-version'
  dependency: string
  from: string
  to: string
}

export type ApplyOutcome =
  | { applied: true; action: SecurityFixAction; edits: FileEdit[] }
  | { applied: false; action?: SecurityFixAction; reason: string }

export interface ApplyOptions {
  // The repo-relative directory that holds package.json / package-lock.json.
  // Default: the directory of the card's dependency.manifest.file.
  manifestDir?: string
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  overrides?: Record<string, string>
  [k: string]: unknown
}

interface LockPkg {
  version?: string
  resolved?: string
  integrity?: string
  dependencies?: Record<string, LockPkg>
  [k: string]: unknown
}

interface LockFile {
  packages?: Record<string, LockPkg>
  dependencies?: Record<string, LockPkg>
  [k: string]: unknown
}

const DIRECT_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

// Keep the user's range operator (^, ~, >=, exact pin) and move only the version,
// so an applied fix reads like the bump a maintainer would have made.
function bumpSpec(prev: string, to: string): string {
  const op = (/^[\^~>=< ]+/.exec(prev) ?? [''])[0].trim()
  return `${op}${to}`
}

// npm tarball basenames drop the scope: `@scope/pkg` -> `pkg-<v>.tgz`.
function tarballUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`
}

// Set the resolved version to `to` on every copy of the package in the lockfile,
// and drop integrity so a real install refetches and recomputes it. The resolved
// version is what extraction reads, so scan_diff re-verify sees the fix.
function bumpLockVersion(lock: LockFile, name: string, to: string, lockRel: string): FileEdit[] {
  const edits: FileEdit[] = []
  const segmentIsName = (loc: string) => loc.slice(loc.lastIndexOf('node_modules/') + 'node_modules/'.length) === name
  if (lock.packages) {
    for (const [loc, meta] of Object.entries(lock.packages)) {
      if (!loc.startsWith('node_modules/') && !loc.includes('/node_modules/')) continue
      if (!segmentIsName(loc) || !meta || typeof meta !== 'object') continue
      if (meta.version && meta.version !== to) {
        edits.push({ file: lockRel, change: 'lockfile-version', dependency: name, from: String(meta.version), to })
        meta.version = to
        if (meta.resolved) meta.resolved = tarballUrl(name, to)
        if (meta.integrity) delete meta.integrity
      }
    }
  }
  // v2 lockfiles also carry the legacy nested `dependencies` tree; keep it in step.
  const walk = (deps: Record<string, LockPkg> | undefined) => {
    if (!deps) return
    for (const [n, meta] of Object.entries(deps)) {
      if (!meta || typeof meta !== 'object') continue
      if (n === name && meta.version && meta.version !== to) {
        meta.version = to
        if (meta.resolved) meta.resolved = tarballUrl(name, to)
        if (meta.integrity) delete meta.integrity
      }
      walk(meta.dependencies)
    }
  }
  walk(lock.dependencies)
  return edits
}

/**
 * Apply a card's fix to the working tree. Deterministic, npm-only, no package
 * manager. Returns applied:false with a reason for anything it will not edit, so
 * a caller never reads "not handled" as "fixed".
 */
export async function applyFixAction(scanPath: string, card: SecurityCard, opts: ApplyOptions = {}): Promise<ApplyOutcome> {
  const action = card.fix.action
  const dep = card.dependency
  if (!action) return { applied: false, reason: 'the card carries no fix action' }
  if (action.kind !== 'bump-to-fixedIn') {
    return { applied: false, action, reason: `fix is ${action.kind} (${action.reason}), not a deterministic bump` }
  }
  if (dep.ecosystem !== 'npm') {
    return { applied: false, action, reason: `ecosystem ${dep.ecosystem} is not supported yet (npm only in v0)` }
  }

  const manifestDir = opts.manifestDir ?? path.dirname(dep.manifest.file)
  const pkgRel = path.join(manifestDir, 'package.json')
  const lockRel = path.join(manifestDir, 'package-lock.json')
  const pkgAbs = path.resolve(scanPath, pkgRel)
  const lockAbs = path.resolve(scanPath, lockRel)

  let pkg: PackageJson
  try {
    pkg = JSON.parse(await fs.readFile(pkgAbs, 'utf8')) as PackageJson
  } catch {
    return { applied: false, action, reason: `could not read package.json at ${pkgRel}` }
  }
  let lock: LockFile
  try {
    lock = JSON.parse(await fs.readFile(lockAbs, 'utf8')) as LockFile
  } catch {
    return { applied: false, action, reason: `could not read package-lock.json at ${lockRel}` }
  }

  const edits: FileEdit[] = []

  // Manifest: a direct dependency's spec, or an override that pins a transitive one
  // without needing to resolve which parent version pulls the fix.
  const directField = DIRECT_FIELDS.find((f) => pkg[f] && Object.prototype.hasOwnProperty.call(pkg[f], dep.name))
  if (directField) {
    const field = pkg[directField] as Record<string, string>
    const prev = String(field[dep.name])
    const next = bumpSpec(prev, action.to)
    if (next !== prev) {
      field[dep.name] = next
      edits.push({ file: pkgRel, change: 'manifest-spec', dependency: dep.name, from: prev, to: next })
    }
  } else {
    pkg.overrides = pkg.overrides ?? {}
    const prev = pkg.overrides[dep.name] !== undefined ? String(pkg.overrides[dep.name]) : ''
    if (prev !== action.to) {
      pkg.overrides[dep.name] = action.to
      edits.push({ file: pkgRel, change: 'manifest-override', dependency: dep.name, from: prev, to: action.to })
    }
  }

  edits.push(...bumpLockVersion(lock, dep.name, action.to, lockRel))

  if (edits.length === 0) return { applied: false, action, reason: `already at ${action.to}` }

  await fs.writeFile(pkgAbs, `${JSON.stringify(pkg, null, 2)}\n`)
  await fs.writeFile(lockAbs, `${JSON.stringify(lock, null, 2)}\n`)
  return { applied: true, action, edits }
}

export interface ReverifyResult {
  outcome: ApplyOutcome
  // Present only when the fix was applied.
  reverify?: SecurityDiff
  // The card's advisory is gone (in `removed`) and the change introduced none.
  cleared?: boolean
}

/**
 * Apply the card's fix to the working tree, then scan_diff HEAD (the committed,
 * still-vulnerable state) against the working tree. `cleared` is true when the
 * card's advisory moved to `removed` and no new finding was introduced. Security
 * axis only; the project's own tests are the separate 0-regression check.
 */
export async function applyAndReverify(
  scanPath: string,
  card: SecurityCard,
  opts: ApplyOptions & ScanDiffOptions = {},
): Promise<ReverifyResult> {
  const { manifestDir, ...scanOpts } = opts
  const outcome = await applyFixAction(scanPath, card, manifestDir ? { manifestDir } : {})
  if (!outcome.applied) return { outcome }
  const reverify = await scanDiffLocal(scanPath, { base: 'HEAD' }, scanOpts)
  const cleared = reverify.removed.some((e) => e.advisoryId === card.advisory.id) && reverify.introduced.length === 0
  return { outcome, reverify, cleared }
}

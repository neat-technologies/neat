/**
 * Package-manager detection + install invocation.
 *
 * Issue #381 — the apply phase adds dependencies to package.json but
 * relies on the operator to run `npm install` afterwards. The v0.4.5
 * smoke surfaced this as a hard regression on Brief: the installer
 * adds `@opentelemetry/sdk-node` (and `@prisma/instrumentation` when
 * Prisma is in deps) and the next `npm run dev` fails with
 * `Cannot find module '@opentelemetry/sdk-node'` before the OTel SDK
 * even gets a chance to load.
 *
 * ADR-046's "lockfiles never touched" rule is about NEAT not directly
 * editing lockfile contents; letting the user's own package manager
 * update them as a side effect of `<pm> install` is consistent with
 * that contract. The clarification is documented in
 * docs/contracts/sdk-install.md.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

export interface PackageManagerCommand {
  pm: PackageManager
  // The directory the install command runs in. Monorepo workspaces install
  // from the lockfile root, not the per-package directory, so detection
  // walks up from `serviceDir` and reports the lockfile-owning parent.
  cwd: string
  // The argv passed to spawn(). Each entry is one positional token. Selected
  // to keep install output quiet on the happy path; failures still print
  // because stderr is streamed verbatim.
  args: string[]
}

// Lockfile basename → package manager + the install args we run for it.
// Priority order — first match wins when multiple lockfiles coexist (rare,
// but `package-lock.json` alongside `pnpm-lock.yaml` happens during a
// migration). Bun leads because a project that opted into Bun deliberately
// rejects npm; pnpm and yarn follow for similar reasons; npm is the default
// when nothing else applies.
const LOCKFILE_PRIORITY: ReadonlyArray<{
  lockfile: string
  pm: PackageManager
  args: string[]
}> = [
  { lockfile: 'bun.lockb', pm: 'bun', args: ['install', '--no-summary'] },
  { lockfile: 'pnpm-lock.yaml', pm: 'pnpm', args: ['install', '--no-summary'] },
  { lockfile: 'yarn.lock', pm: 'yarn', args: ['install', '--silent'] },
  {
    lockfile: 'package-lock.json',
    pm: 'npm',
    args: ['install', '--no-audit', '--no-fund', '--prefer-offline'],
  },
]

// Default when no lockfile is present anywhere in the ancestor chain — a
// fresh project the operator hasn't installed yet. npm is the safe pick:
// it's available on every Node install and produces a `package-lock.json`
// the user can later swap out for pnpm/yarn/bun without losing fidelity.
const NPM_FALLBACK_ARGS = ['install', '--no-audit', '--no-fund', '--prefer-offline']

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// Resolve the package-manager command for a service directory. Walks up from
// `serviceDir` looking for a lockfile — the first ancestor that has one
// owns the install. Monorepos (npm/pnpm/yarn workspaces, Bun workspaces)
// land their lockfile at the workspace root, so this returns the root cwd
// even when `serviceDir` is a per-package subdir.
//
// No lockfile anywhere → npm at the service dir. A fresh `create-next-app`
// run sits in this bucket (no install yet, no lockfile to read).
export async function detectPackageManager(
  serviceDir: string,
): Promise<PackageManagerCommand> {
  let dir = path.resolve(serviceDir)
  const stops = new Set<string>()
  for (let i = 0; i < 64; i++) {
    if (stops.has(dir)) break
    stops.add(dir)
    for (const candidate of LOCKFILE_PRIORITY) {
      const lockPath = path.join(dir, candidate.lockfile)
      if (await exists(lockPath)) {
        return { pm: candidate.pm, cwd: dir, args: [...candidate.args] }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { pm: 'npm', cwd: path.resolve(serviceDir), args: [...NPM_FALLBACK_ARGS] }
}

export interface PackageManagerInvocation {
  pm: PackageManager
  cwd: string
  args: string[]
  // 0 → success; non-zero → install failed. Reported in the orchestrator
  // summary so the operator can act before the daemon goes hunting for
  // spans that never arrive.
  exitCode: number
  // Stderr captured from the child process, trimmed. Empty on success.
  // Surfaces the underlying failure cause without dumping the entire
  // install log into the summary.
  stderr: string
}

// Run the install command and resolve with the outcome. Stdout is dropped
// (`<pm> install --silent`-style flags already keep it short); stderr is
// captured so a failure can be relayed up to the orchestrator's summary.
export async function runPackageManagerInstall(
  cmd: PackageManagerCommand,
): Promise<PackageManagerInvocation> {
  return new Promise((resolve) => {
    const child = spawn(cmd.pm, cmd.args, {
      cwd: cmd.cwd,
      // Inherit PATH + HOME so the user's installed managers resolve.
      env: process.env,
      // `false` keeps the parent in control of cleanup if the orchestrator
      // exits before install finishes. Cross-platform-safe.
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      resolve({
        pm: cmd.pm,
        cwd: cmd.cwd,
        args: cmd.args,
        exitCode: 127,
        stderr: stderr + `\n${err.message}`,
      })
    })
    child.on('close', (code) => {
      resolve({
        pm: cmd.pm,
        cwd: cmd.cwd,
        args: cmd.args,
        exitCode: code ?? 1,
        stderr: stderr.trim(),
      })
    })
  })
}

// Guard: fail the run if a test escapes its sandbox and writes to a real location.
//
// Two escapes, both silent (no assertion fails), both seen on real machines:
//
//  1. Into the package tree. The install commands resolve CLAUDE.md from
//     process.cwd() when NEAT_CLAUDE_MD is unset, so a test that drives
//     `skill --apply`, `claude install`, or `hooks --apply` without isolating that
//     env writes an agent-instruction file into packages/core (#1715). It is not
//     gitignored, so a stray commit of it would change how agents behave here.
//
//  2. Into the developer's real home. The same commands fall back to
//     $HOME/.claude/settings.json, and the registry to ~/.neat/projects.json, when
//     their override env vars are unset. A test, or a child process it spawns with a
//     stripped env, then writes into the real home. That is how a dev's
//     ~/.claude/settings.json got a hook pointing at a temp script, and how
//     ~/.neat/projects.json collected test-temp projects (#1721).
//
// vitest.setup.ts points HOME, NEAT_HOME and the override vars at a per-file
// sandbox so an in-process test cannot escape. This guard is the backstop for the
// paths that setup cannot reach (a child that builds its own env), and it runs once
// after the whole suite, so a leak that only shows under the full parallel run still
// fails it. It watches, never writes: the real files are reported, never cleaned.
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The real files a test (or a child it spawns) lands on when it drops its sandbox
// env. Resolved from the real home, which globalSetup runs under.
const REAL_FILES = [
  path.join(os.homedir(), '.neat', 'projects.json'),
  path.join(os.homedir(), '.claude', 'settings.json'),
]

// Untracked, non-ignored files under the package (git honours .gitignore, so the
// build output in dist/ never shows up here). Empty when git is unavailable, e.g.
// a published tarball, where there is nothing to guard.
function untrackedUnderPackage(): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', PKG_DIR], {
      encoding: 'utf8',
      cwd: PKG_DIR,
    })
    return out
      .split('\n')
      .filter((l) => l.startsWith('??'))
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

// Modification time in ms, or null when the file does not exist. Metadata only; the
// file is never opened or changed.
function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

export function setup(): () => void {
  // Files already untracked before the run (a developer's work in progress) are not
  // this run's fault; only new ones fail it.
  const beforeUntracked = new Set(untrackedUnderPackage())
  const beforeMtime = new Map(REAL_FILES.map((f) => [f, mtimeOf(f)] as const))

  return () => {
    const problems: string[] = []

    const leaked = untrackedUnderPackage().filter((f) => !beforeUntracked.has(f))
    if (leaked.length > 0) {
      problems.push(
        `Left ${leaked.length} untracked file(s) in packages/core:\n` +
          leaked.map((f) => `  ${f}`).join('\n'),
      )
    }

    const touched = REAL_FILES.filter((f) => mtimeOf(f) !== (beforeMtime.get(f) ?? null))
    if (touched.length > 0) {
      problems.push(
        `Wrote to the developer's real home:\n` +
          touched.map((f) => `  ${f}`).join('\n'),
      )
    }

    if (problems.length > 0) {
      throw new Error(
        `A test escaped its sandbox:\n\n${problems.join('\n\n')}\n\n` +
          `vitest.setup.ts sandboxes HOME, NEAT_HOME and the install override vars for in-process ` +
          `code. A leak into the real home usually means a test spawned a child (a daemon or the CLI) ` +
          `with a hand-built env that dropped those vars: pass them through, e.g. env: { ...process.env, ... }.`,
      )
    }
  }
}

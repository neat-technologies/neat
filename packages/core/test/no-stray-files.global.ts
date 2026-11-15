// Guard: fail the run if a test leaves an untracked file in the package directory.
//
// The install commands resolve CLAUDE.md from process.cwd() when NEAT_CLAUDE_MD is
// unset (and settings.json from $HOME when NEAT_CLAUDE_SETTINGS is unset), so a
// test that drives `skill --apply`, `claude install`, or `hooks --apply` without
// isolating those env vars writes an agent-instruction file into packages/core
// (#1715). That file is not gitignored, so a stray commit of it would change how
// agents behave in this repo from then on. One leak already slipped through this
// way, visible only under the full parallel suite, so a per-test assertion is not
// enough: this runs once after every test and fails the whole run if any new
// untracked file appeared, naming it so the writer can be isolated.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

export function setup(): () => void {
  // Files already untracked before the run (a developer's work in progress) are not
  // this run's fault; only new ones fail it.
  const before = new Set(untrackedUnderPackage())
  return () => {
    const leaked = untrackedUnderPackage().filter((f) => !before.has(f))
    if (leaked.length > 0) {
      throw new Error(
        `A test left ${leaked.length} untracked file(s) in packages/core:\n` +
          leaked.map((f) => `  ${f}`).join('\n') +
          `\nA test wrote into the package directory instead of a temp dir. If it drives ` +
          `\`skill --apply\`, \`claude install\`, or \`hooks --apply\`, set NEAT_CLAUDE_MD and ` +
          `NEAT_CLAUDE_SETTINGS to temp paths (and use a temp cwd) so the install never touches the repo.`,
      )
    }
  }
}

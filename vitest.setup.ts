// Every test file gets its own `NEAT_HOME`, before a single module loads.
//
// Two separate problems, one fix (#1244).
//
// The registry resolves `~/.neat` per call (`registry.ts`, `daemon.ts`), so
// anything running without `NEAT_HOME` set writes to the developer's real
// registry. Tests that need a sandbox already set it themselves — and then
// restore it with `if (prevHome === undefined) delete process.env.NEAT_HOME`,
// which is the hole: between tests the variable is unset, and a daemon's persist
// loop, a registry watcher or any late async callback that outlives the restore
// resolves the real `~/.neat` and writes there. That is how a developer's
// projects.json came to be rewritten by a test run. Setting it here means
// `prevHome` is never undefined, so those restores put back a sandbox path
// instead of unsetting, with no change to the tests themselves.
//
// It also gives each test *file* its own registry. Vitest runs files in
// parallel, so a shared home means concurrent suites mutating one projects.json
// and watching each other's writes — which is what made the ADR-049 watch tests
// flake. Per-file isolation removes the contention rather than papering over it.
//
// Unconditional on purpose: honouring an inherited `NEAT_HOME` would let a
// developer's shell point the suite back at real state.
//
// This lives at the repo root, not under one package, because the bypass it
// closes was a path problem (#1308). It used to sit in `packages/core/test/`,
// wired only by `packages/core/vitest.config.ts`. Vitest resolves its config
// from the directory it is invoked in, so `npx vitest run packages/core/test/…`
// from the repo root — the default in an agent session or a workspace-rooted
// editor — loaded no config, ran no setup, and used the real `~/.neat`. Every
// package that runs vitest now points at this one file, and
// `vitest.workspace.ts` makes a root invocation resolve to those configs.
// The same reasoning extends to the developer's real HOME (#1721). The install
// paths fall back to real locations when their override env vars are unset:
// claudeMdPath() to process.cwd()/CLAUDE.md, and claudeSettingsPath() to
// $HOME/.claude/settings.json. A test that drives `skill --apply`, `claude install`
// or `hooks --apply` and forgets an override then writes into the real tree. That
// is how a dev's ~/.claude/settings.json got a PreToolUse hook pointing at a temp
// script (#1715): one test missed the overrides, and the write was silent. Pointing
// HOME and all three override vars at this file's sandbox by default means a test
// that forgets one can only write into the sandbox; a test that sets its own
// override still wins, and (as with NEAT_HOME above) a save/restore that captured
// an undefined value now restores the sandbox path instead of deleting it. The
// #1715 guard catches a leak into the package tree after the fact; this stops a
// leak into the real home before it happens.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(os.tmpdir(), 'neat-test-home-'))
process.env.NEAT_HOME = home
process.env.HOME = home
process.env.USERPROFILE = home
process.env.NEAT_CLAUDE_CONFIG = path.join(home, '.claude.json')
process.env.NEAT_CLAUDE_MD = path.join(home, 'CLAUDE.md')
process.env.NEAT_CLAUDE_SETTINGS = path.join(home, '.claude', 'settings.json')

// Sandboxing HOME hides the developer's global git config, so a test that commits
// into a temp repo would have no author identity. Give the sandbox its own global
// config with one; a repo's local config still overrides it. GIT_CONFIG_GLOBAL
// pins the file regardless of HOME or XDG, so the real global config never leaks in.
const gitconfig = path.join(home, '.gitconfig')
process.env.GIT_CONFIG_GLOBAL = gitconfig
try {
  writeFileSync(gitconfig, '[user]\n\tname = neat test\n\temail = neat-test@example.com\n')
} catch {
  // Best effort: a test that needs an identity sets its own.
}

process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // Best effort — a leftover empty tmp dir is not worth failing a run over.
  }
})

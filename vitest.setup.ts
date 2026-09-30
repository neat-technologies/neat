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
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(os.tmpdir(), 'neat-test-home-'))
process.env.NEAT_HOME = home

process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // Best effort — a leftover empty tmp dir is not worth failing a run over.
  }
})

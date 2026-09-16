import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The `neat --version` family reads its answer from the bundled package's
// own package.json. Reading at run time keeps the published bin in lockstep
// with whatever version `tsup` shipped without a build-time substitution.
// `dist/cli.cjs` sits one level below the package root.
export function readPackageVersion(): string {
  const here =
    typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url))
  // dist/ → package root. tsup writes both cjs and mjs to dist/, so the
  // parent-of-parent walk is the same in either format.
  const candidates = [
    path.resolve(here, '../package.json'),
    path.resolve(here, '../../package.json'),
  ]
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8')
      const parsed = JSON.parse(raw) as { name?: string; version?: string }
      if (parsed.name === '@neat.is/core' && typeof parsed.version === 'string') {
        return parsed.version
      }
    } catch {
      // try the next candidate
    }
  }
  return 'unknown'
}

// The ASCII banner. Shared between the CLI's `neat init` discovery report and
// the one-command orchestrator (issue #483) so the artwork lives in exactly
// one place — no duplicated glyphs to drift apart.
export function printBanner(): void {
  console.log('███╗   ██╗███████╗ █████╗ ████████╗')
  console.log('████╗  ██║██╔════╝██╔══██╗╚══██╔══╝')
  console.log('██╔██╗ ██║█████╗  ███████║   ██║   ')
  console.log('██║╚██╗██║██╔══╝  ██╔══██║   ██║   ')
  console.log('██║ ╚████║███████╗██║  ██║   ██║   ')
  console.log('╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝   ╚═╝   ')
  console.log('')
  console.log('  Network Expressive Architecting Tool')
  console.log(`  neat.is  ·  v${readPackageVersion()}  ·  Apache 2.0`)
  console.log('')
}

// True when this run came in through `npx neat.is` rather than a global
// `neat` binary on PATH. npx never puts `neat`/`neatd`/`neat-mcp` on PATH —
// only `npm i -g neat.is` does — so an npx user who copies a bare `neat init`
// example from the help screen hits `command not found`. We render every
// example with the prefix that actually works for how they invoked us.
//
// Two robust signals: npm sets `npm_command` / `npm_execpath` for anything it
// spawns (including `npx`), and an npx run resolves argv[1] under a temporary
// `_npx` cache dir rather than a global bin dir. Either one is enough.
//
// Lives here (not in cli.ts) so the orchestrator's summary can render the same
// prefix without a cli ↔ orchestrator import cycle — the same reason
// `printBanner` / `readPackageVersion` live in this module.
export function isNpxInvocation(): boolean {
  if (process.env.npm_command === 'exec') return true
  const execpath = process.env.npm_execpath ?? ''
  if (execpath.includes('npx')) return true
  const entry = process.argv[1] ?? ''
  if (entry.includes('/_npx/') || entry.includes('\\_npx\\')) return true
  return false
}

// The command prefix every help example renders with. `npx neat.is` for an
// npx run, plain `neat` for a global install.
export function commandPrefix(): string {
  return isNpxInvocation() ? 'npx neat.is' : 'neat'
}

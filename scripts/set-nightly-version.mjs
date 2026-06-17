#!/usr/bin/env node
// Stamp an ephemeral nightly version across the lockstep packages, in CI only.
//
// The TypeScript-nightly shape: `<next-patch>-dev.<YYYYMMDD>`, e.g.
// `0.4.20-dev.20260615` while `0.4.19` is the latest release. The version is a
// prerelease, so `npm install neat.is` (which resolves the highest NON-prerelease
// = the `latest` tag) never picks it up — the `nightly` dist-tag is belt, the
// `-dev` prerelease string is suspenders.
//
// This is run by .github/workflows/nightly.yml and its writes are NEVER
// committed — git history stays clean; only npm carries the `-dev` versions.
// Prints the computed version to stdout so the workflow can capture it.
//
// Scope: the six version-locked packages only. `@neat.is/instrumentation-registry`
// rides its own version line (1.0.0) and is already on the registry, so the dev
// packages keep referencing it via `^1.0.0` and the nightly leaves it untouched.

import { readFileSync, writeFileSync } from 'node:fs'

// The version-locked set (must all share one version). Cross-deps among these
// get pinned to the exact dev version; deps outside it (instrumentation-registry,
// third-party) are left alone.
const LOCKSTEP_NAMES = new Set([
  'neat.is',
  '@neat.is/types',
  '@neat.is/core',
  '@neat.is/mcp',
  '@neat.is/claude-skill',
  '@neat.is/web',
])
const LOCKSTEP_DIRS = ['types', 'core', 'mcp', 'claude-skill', 'web', 'neat.is']
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

// Base = next patch above the current release (the repo's committed version).
const current = JSON.parse(readFileSync('packages/core/package.json', 'utf8')).version
const [major, minor, patch] = current.split('-')[0].split('.').map(Number)
const base = `${major}.${minor}.${patch + 1}`

// UTC date stamp — one nightly per day, so date-only never collides.
const now = new Date()
const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`

const devVersion = `${base}-dev.${stamp}`

for (const dir of LOCKSTEP_DIRS) {
  const file = `packages/${dir}/package.json`
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.version = devVersion
  for (const field of DEP_FIELDS) {
    const deps = pkg[field]
    if (!deps) continue
    for (const name of Object.keys(deps)) {
      // Caret-pin, matching the release convention the ADR-052 lockstep audit
      // enforces. For same-tuple prereleases (all `0.4.20-dev.*`) caret resolves
      // to the highest matching nightly, so a fresh `@nightly` install stays
      // internally consistent.
      if (LOCKSTEP_NAMES.has(name)) deps[name] = `^${devVersion}`
    }
  }
  // Ephemeral reformatting is fine — this file is never committed.
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
}

process.stdout.write(devVersion)

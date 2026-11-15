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

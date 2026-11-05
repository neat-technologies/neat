import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

// Every package we publish carries the repo's Apache-2.0 LICENSE in its tarball
// (npm always packs a LICENSE at the package root, whatever `files` says) and
// declares Apache-2.0 in package.json. A copy that drifts from the root, or a
// new package without one, fails here before it can ship.

const repoRoot = path.resolve(__dirname, '../../..')
const rootLicense = readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8')
const published = readdirSync(path.join(repoRoot, 'packages'))
  .map((dir) => ({ dir, pkgPath: path.join(repoRoot, 'packages', dir, 'package.json') }))
  .filter(({ pkgPath }) => existsSync(pkgPath))
  .map(({ dir, pkgPath }) => ({ dir, pkg: JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string; private?: boolean; license?: string } }))
  .filter(({ pkg }) => !pkg.private)

describe('published package licenses', () => {
  it('finds the publishable packages', () => {
    expect(published.map((p) => p.pkg.name)).toEqual(expect.arrayContaining(['neat.is', '@neat.is/core', '@neat.is/instrumentation-registry']))
  })

  for (const { dir, pkg } of published) {
    it(`${pkg.name} declares Apache-2.0 and ships the root LICENSE`, () => {
      expect(pkg.license).toBe('Apache-2.0')
      const copy = path.join(repoRoot, 'packages', dir, 'LICENSE')
      expect(existsSync(copy)).toBe(true)
      expect(readFileSync(copy, 'utf8')).toBe(rootLicense)
    })
  }
})

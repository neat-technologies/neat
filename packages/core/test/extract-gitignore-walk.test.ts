import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { walkSourceFiles } from '../src/extract/calls/shared.js'
import { clearIgnoreCache } from '../src/extract/gitignore.js'

// #1255 — service discovery honoured `.gitignore` and file enumeration didn't,
// so an ignored directory was skipped when looking for services and then walked
// in full when collecting one service's files. An ignored path is now absent
// from the walk entirely: no FileNode, no recogniser run over it.

const dirs: string[] = []

async function repo(files: Record<string, string>): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-ignore-')))
  dirs.push(root)
  // `.git` marks the repo root, which is where the upward search for
  // `.gitignore` files stops.
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, 'utf8')
  }
  return root
}

const rels = (root: string, found: string[]): string[] =>
  found.map((f) => path.relative(root, f).split(path.sep).join('/')).sort()

beforeEach(() => clearIgnoreCache())
afterEach(async () => {
  clearIgnoreCache()
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

describe('walkSourceFiles honours .gitignore', () => {
  it('leaves an ignored directory out entirely', async () => {
    const root = await repo({
      '.gitignore': 'generated/\n',
      'src/index.js': 'export const a = 1',
      'generated/bundle.js': 'export const b = 2',
    })
    expect(rels(root, await walkSourceFiles(root))).toEqual(['src/index.js'])
  })

  it('leaves an ignored file out', async () => {
    const root = await repo({
      '.gitignore': 'secret.js\n',
      'src/index.js': 'a',
      'src/secret.js': 'b',
    })
    expect(rels(root, await walkSourceFiles(root))).toEqual(['src/index.js'])
  })

  it('applies a nested .gitignore to its own subtree', async () => {
    // The shape a monorepo actually has: each package carries its own rules.
    const root = await repo({
      'packages/a/.gitignore': 'vendor/\n',
      'packages/a/index.js': 'a',
      'packages/a/vendor/dep.js': 'v',
      'packages/b/index.js': 'b',
      'packages/b/vendor/dep.js': 'kept — b has no ignore file',
    })
    expect(rels(root, await walkSourceFiles(root))).toEqual([
      'packages/a/index.js',
      'packages/b/index.js',
      'packages/b/vendor/dep.js',
    ])
  })

  it('lets a deeper .gitignore re-include what an ancestor excluded', async () => {
    // git's own precedence, and `git check-ignore` agrees this file is kept.
    // A boolean `ignores()` per layer cannot express it — it needs the explicit
    // un-ignore that `test()` reports. Note the directory is NOT one of
    // IGNORED_DIRS: those are unconditional and no .gitignore can re-include them.
    const root = await repo({
      '.gitignore': 'generated/\n',
      'packages/a/.gitignore': '!generated/\n',
      'packages/a/generated/keep.js': 'keep',
      'generated/drop.js': 'drop',
      'src/index.js': 'a',
    })
    const found = rels(root, await walkSourceFiles(root))
    expect(found).toContain('packages/a/generated/keep.js')
    expect(found).not.toContain('generated/drop.js')
  })

  it('applies an ancestor rule to a service nested below the repo root', async () => {
    // The walk starts at the service dir, so the root's rules only apply if the
    // chain is loaded upward from there.
    const root = await repo({
      '.gitignore': 'dist/\n',
      'packages/api/index.js': 'a',
      'packages/api/dist/out.js': 'built',
    })
    const found = rels(root, await walkSourceFiles(path.join(root, 'packages/api')))
    expect(found).toEqual(['packages/api/index.js'])
  })

  it('stops climbing at the repo root, so an unrelated parent cannot exclude', async () => {
    const outer = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neat-outer-')))
    dirs.push(outer)
    // A `.gitignore` above the repo, belonging to something else entirely.
    await fs.writeFile(path.join(outer, '.gitignore'), 'src/\n', 'utf8')
    const root = path.join(outer, 'inner')
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src/index.js'), 'a', 'utf8')
    expect(rels(root, await walkSourceFiles(root))).toEqual(['src/index.js'])
  })

  it('is unchanged when there is no .gitignore at all', async () => {
    const root = await repo({ 'src/index.js': 'a', 'lib/util.js': 'b' })
    expect(rels(root, await walkSourceFiles(root))).toEqual(['lib/util.js', 'src/index.js'])
  })

  it('still honours IGNORED_DIRS and excludeDirs alongside it', async () => {
    const root = await repo({
      '.gitignore': 'ignored/\n',
      'src/index.js': 'a',
      'ignored/x.js': 'x',
      'node_modules/pkg/index.js': 'n',
      'nested/index.js': 'nested service',
    })
    const found = rels(root, await walkSourceFiles(root, [path.join(root, 'nested')]))
    expect(found).toEqual(['src/index.js'])
  })
})

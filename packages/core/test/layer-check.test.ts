import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkLayers } from '../../../scripts/check-layers.mjs'

// The layer check (scripts/check-layers.mjs) against small fixture repos: each
// failure mode it promises, and the shrink-only allowlist.

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

type Allow = { upward?: object[]; producerBarrel?: object[]; crossPackage?: object[] }
function repo(files: Record<string, string>, allow: Allow = {}): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'layer-check-'))
  roots.push(root)
  const config = {
    layers: { substrate: 2, producers: 3, queries: 4, surfaces: 5, entry: 6 },
    packages: {
      'packages/core/src': {
        name: '@neat.is/core',
        allowedWorkspaceImports: ['@neat.is/types'],
        map: {
          substrate: ['graph.ts'],
          producers: ['ingest.ts', 'ingest/', 'extract/'],
          queries: ['traverse.ts'],
          surfaces: ['api.ts'],
          entry: ['daemon.ts'],
        },
        producerUnits: { ingest: ['ingest/', 'ingest.ts'], extract: ['extract/'] },
        producerBarrel: 'ingest.ts',
      },
    },
    allowlist: { upward: [], producerBarrel: [], crossPackage: [], ...allow },
  }
  mkdirSync(path.join(root, 'docs/contracts'), { recursive: true })
  writeFileSync(path.join(root, 'docs/contracts/layers.json'), JSON.stringify(config))
  for (const [file, body] of Object.entries(files)) {
    const full = path.join(root, 'packages/core/src', file)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

const clean = {
  'graph.ts': 'export const g = 1\n',
  'ingest.ts': "export * from './ingest/span.js'\n",
  'ingest/span.ts': "import { g } from '../graph.js'\nexport const s = g\n",
  'extract/index.ts': "import { s } from '../ingest/span.js'\nexport const e = s\n",
  'traverse.ts': "import { g } from './graph.js'\nexport const t = g\n",
  'api.ts': "import { t } from './traverse.js'\nexport const a = t\n",
  'daemon.ts': "import { a } from './api.js'\nimport type { X } from '@neat.is/types'\nexport const d = a\n",
}

describe('checkLayers', () => {
  it('passes a repo that only imports downward', () => {
    expect(checkLayers(repo(clean)).problems).toEqual([])
  })

  it('fails an upward import, type-only included', () => {
    const r = repo({ ...clean, 'traverse.ts': 'export const t = 1\n', 'graph.ts': "import type { t } from './traverse.js'\nexport const g = 1\n" })
    expect(checkLayers(r).problems).toEqual([
      'upward: packages/core/src/graph.ts (substrate) imports packages/core/src/traverse.ts (queries)',
    ])
  })

  it('fails a cycle', () => {
    const r = repo({
      ...clean,
      'ingest/span.ts': "import { e } from '../ingest/other.js'\nexport const s = e\n",
      'ingest/other.ts': "import { s } from './span.js'\nexport const e = s\n",
    })
    expect(checkLayers(r).problems).toEqual(['cycle: packages/core/src/ingest/other.ts <-> packages/core/src/ingest/span.ts'])
  })

  it("fails a producer importing the ingest barrel, but not ingest's own files", () => {
    const r = repo({ ...clean, 'extract/index.ts': "import { s } from '../ingest.js'\nexport const e = s\n" })
    expect(checkLayers(r).problems).toEqual([
      'producer barrel: packages/core/src/extract/index.ts imports packages/core/src/ingest.ts; import the helper from ingest/<file> instead',
    ])
  })

  it('fails an undeclared workspace package and an unplaced file', () => {
    const r = repo({ ...clean, 'api.ts': "import { x } from '@neat.is/action/src/graph.mjs'\nexport const a = x\n", 'stray.ts': 'export {}\n' })
    expect(checkLayers(r).problems.sort()).toEqual([
      'cross-package: packages/core/src/api.ts imports @neat.is/action, which @neat.is/core does not declare',
      'unplaced: packages/core/src/stray.ts has no layer in docs/contracts/layers.json',
    ])
  })

  it('accepts allowlisted violations, and fails an allowlist entry that no longer exists', () => {
    const files = { ...clean, 'traverse.ts': 'export const t = 1\n', 'graph.ts': "import { t } from './traverse.js'\nexport const g = t\n" }
    const upward = [{ from: 'packages/core/src/graph.ts', to: 'packages/core/src/traverse.ts' }]
    expect(checkLayers(repo(files, { upward })).problems).toEqual([])
    expect(checkLayers(repo({ ...clean, 'traverse.ts': 'export const t = 1\n' }, { upward })).problems).toEqual([
      'stale allowlist (upward): packages/core/src/graph.ts -> packages/core/src/traverse.ts no longer exists; remove it',
    ])
  })
})

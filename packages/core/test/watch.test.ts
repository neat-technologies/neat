import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { classifyChange } from '../src/watch.js'

const sep = path.sep

describe('classifyChange', () => {
  it('routes package.json to services + aliases + databases', () => {
    const phases = classifyChange(`packages${sep}service-a${sep}package.json`)
    expect([...phases].sort()).toEqual(['aliases', 'databases', 'services'])
  })

  it('routes Python manifests to the same trio', () => {
    expect([...classifyChange(`svc${sep}requirements.txt`)].sort()).toEqual([
      'aliases',
      'databases',
      'services',
    ])
    expect([...classifyChange(`svc${sep}pyproject.toml`)].sort()).toEqual([
      'aliases',
      'databases',
      'services',
    ])
  })

  it('routes JS/TS/Python source to imports + calls', () => {
    expect([...classifyChange(`src${sep}index.ts`)].sort()).toEqual(['calls', 'imports'])
    expect([...classifyChange(`src${sep}index.js`)].sort()).toEqual(['calls', 'imports'])
    expect([...classifyChange(`src${sep}page.tsx`)].sort()).toEqual(['calls', 'imports'])
    expect([...classifyChange(`app${sep}main.py`)].sort()).toEqual(['calls', 'imports'])
  })

  it('routes .env / prisma / knex / ormconfig to databases + configs', () => {
    expect([...classifyChange(`service-b${sep}.env`)].sort()).toEqual(['configs', 'databases'])
    expect([...classifyChange(`service-b${sep}.env.production`)].sort()).toEqual([
      'configs',
      'databases',
    ])
    expect([...classifyChange(`prisma${sep}schema.prisma`)].sort()).toEqual([
      'configs',
      'databases',
    ])
    // knexfile.ts also looks like JS source — its imports/calls rerun is a
    // no-op for the file but cheap, so we accept the overlap.
    expect([...classifyChange(`knexfile.ts`)].sort()).toEqual([
      'calls',
      'configs',
      'databases',
      'imports',
    ])
    expect([...classifyChange(`ormconfig.json`)].sort()).toEqual(['configs', 'databases'])
  })

  it('routes Dockerfile / compose / Terraform to infra + aliases', () => {
    expect([...classifyChange('Dockerfile')].sort()).toEqual(['aliases', 'infra'])
    expect([...classifyChange('docker-compose.yml')].sort()).toEqual([
      'aliases',
      'infra',
    ])
    expect([...classifyChange('docker-compose.prod.yaml')].sort()).toEqual([
      'aliases',
      'infra',
    ])
    expect([...classifyChange(`infra${sep}main.tf`)].sort()).toEqual(['aliases', 'infra'])
  })

  it('routes k8s yaml under k8s/ to infra + aliases + db/configs', () => {
    // k8s manifests are yaml — we add infra+aliases via the dir hint AND
    // databases+configs via the generic .yaml fallback. Belt-and-suspenders is
    // fine; the phases dedupe via Set.
    const phases = classifyChange(`k8s${sep}deployment.yaml`)
    expect(phases.has('infra')).toBe(true)
    expect(phases.has('aliases')).toBe(true)
  })

  it('returns an empty set for files with no known mapping', () => {
    expect([...classifyChange(`README.md`)]).toEqual([])
    expect([...classifyChange(`assets${sep}logo.png`)]).toEqual([])
  })

  it('case-insensitive for Dockerfile and friends', () => {
    expect([...classifyChange('dockerfile')].sort()).toEqual(['aliases', 'infra'])
    expect([...classifyChange('Dockerfile')].sort()).toEqual(['aliases', 'infra'])
  })
})

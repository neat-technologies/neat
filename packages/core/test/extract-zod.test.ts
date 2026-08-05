import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zodShapesFromFile } from '../src/extract/zod-shapes.js'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, InfraNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  fileId,
  infraId,
} from '@neat.is/types'

// ADR-170 — Zod-as-contract. A top-level `z.object({…})` / `z.enum([…])` literal
// bound to a module-level const is minted as an `InfraNode` of kind `zod-schema`
// with its declared fields folded on as `ColumnAttr`. Composed / computed forms
// are left unclaimed. The recognizer is a pure function; the phase mints the node.

const SVC = '/svc'

describe('zodShapesFromFile — declared shapes from top-level z.object / z.enum', () => {
  const shapes = (content: string) =>
    zodShapesFromFile({ path: '/svc/src/schemas.ts', content }, SVC)

  it('reads a z.object literal as a zod-schema with its top-level fields (verbatim)', () => {
    const out = shapes(`
      import { z } from 'zod'
      export const UserSchema = z.object({
        id: z.string(),
        email: z.string().email(),
        userId: z.number(),
      })
    `)
    expect(out).toHaveLength(1)
    expect(out[0]!.infraId).toBe('infra:zod-schema:UserSchema')
    expect(out[0]!.name).toBe('UserSchema')
    // Field names are the JS keys, read verbatim — there is no DB-name remap here,
    // the declared field IS the contract. `userId` stays `userId`.
    expect(out[0]!.fields).toEqual(['id', 'email', 'userId'])
    expect(out[0]!.evidence.file).toBe('src/schemas.ts')
  })

  it('reads a z.enum literal — its string members are the declared set', () => {
    const out = shapes(`
      import { z } from 'zod'
      export const Role = z.enum(['admin', 'user', 'guest'])
    `)
    expect(out).toHaveLength(1)
    expect(out[0]!.infraId).toBe('infra:zod-schema:Role')
    expect(out[0]!.fields).toEqual(['admin', 'user', 'guest'])
  })

  it('claims the top-level object only — a nested inline z.object is not expanded or minted', () => {
    const out = shapes(`
      import { z } from 'zod'
      export const Profile = z.object({
        name: z.string(),
        address: z.object({ city: z.string(), zip: z.string() }),
      })
    `)
    // One schema (Profile). The inner z.object is anonymous, so it is neither a
    // schema of its own nor expanded — `address` is a single top-level field.
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('Profile')
    expect(out[0]!.fields).toEqual(['name', 'address'])
  })

  it('leaves a composed .extend() / .merge() form unclaimed', () => {
    const out = shapes(`
      import { z } from 'zod'
      const Base = z.object({ id: z.string() })
      export const Extended = Base.extend({ name: z.string() })
      export const Merged = Base.merge(z.object({ age: z.number() }))
    `)
    // Base is claimed (a plain literal); the composed forms are not.
    expect(out.map((s) => s.name).sort()).toEqual(['Base'])
  })

  it('leaves a spread or computed-key object unclaimed rather than claiming a partial set', () => {
    const out = shapes(`
      import { z } from 'zod'
      const Base = z.object({ id: z.string() })
      const key = 'dynamic'
      export const Spread = z.object({ ...Base.shape, extra: z.string() })
      export const Computed = z.object({ [key]: z.string() })
    `)
    expect(out.map((s) => s.name).sort()).toEqual(['Base'])
  })

  it('recognizes the `zod` namespace alias, not only `z`', () => {
    const out = shapes(`
      import * as zod from 'zod'
      export const Thing = zod.object({ a: zod.string(), b: zod.number() })
    `)
    expect(out).toHaveLength(1)
    expect(out[0]!.infraId).toBe('infra:zod-schema:Thing')
    expect(out[0]!.fields).toEqual(['a', 'b'])
  })

  it('returns nothing for a file that does not import zod', () => {
    expect(shapes('export const x = 1\n')).toEqual([])
  })
})

// The phase proves the actual deliverable: the InfraNode of kind `zod-schema`
// with fields as ColumnAttr, and the `file ──CONTAINS──▶ zod-schema` ownership
// edge. Runs the whole pipeline (extractFromDirectory) so the index.ts wiring and
// the per-service `zod` dep gate are exercised end to end.
describe('addZodShapes phase — mints the zod-schema InfraNode with ColumnAttr', () => {
  let dir: string
  const PKG = 'zod-fixture-svc'

  beforeEach(async () => {
    resetGraph()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-zod-'))
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: PKG, version: '1.0.0', dependencies: { zod: '^3.23.0' } }),
    )
    await fs.mkdir(path.join(dir, 'src'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'src', 'schemas.ts'),
      `import { z } from 'zod'
export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  age: z.number(),
})
`,
    )
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('mints infra:zod-schema:<name> at kind zod-schema with EXTRACTED columns', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, dir)

    const id = infraId('zod-schema', 'UserSchema')
    expect(graph.hasNode(id)).toBe(true)
    const node = graph.getNodeAttributes(id) as InfraNode
    expect(node.type).toBe(NodeType.InfraNode)
    expect(node.kind).toBe('zod-schema')
    expect(node.name).toBe('UserSchema')
    expect(node.provider).toBe('self')

    const columnNames = (node.columns ?? []).map((c) => c.name)
    expect(columnNames).toEqual(['id', 'email', 'age'])
    for (const col of node.columns ?? []) {
      expect(col.provenances).toEqual([Provenance.EXTRACTED])
      expect(col.confidence).toBeGreaterThan(0)
    }
  })

  it('owns the schema by its file through a CONTAINS edge', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, dir)

    const fileNodeId = fileId(PKG, 'src/schemas.ts')
    const schemaId = infraId('zod-schema', 'UserSchema')
    const edgeId = extractedEdgeId(fileNodeId, schemaId, EdgeType.CONTAINS)
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.type).toBe(EdgeType.CONTAINS)
    expect(edge.provenance).toBe(Provenance.EXTRACTED)
    expect(edge.source).toBe(fileNodeId)
    expect(edge.target).toBe(schemaId)
  })
})

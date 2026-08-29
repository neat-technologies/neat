/**
 * Schema-snapshot regression test (ADR-031, contract #4).
 *
 * Introspects every binding schema in @neat.is/types, produces a normalized JSON
 * tree, and compares against packages/core/test/audits/schemas.snapshot.json.
 *
 * If this test fails:
 *   1. The change is GROWTH (new optional field, new enum value, etc.):
 *      run `npm run test -- --update test/audits/schema-snapshot.test.ts`
 *      (or set UPDATE_SNAPSHOT=1) to regenerate the snapshot, commit the
 *      updated JSON in the same PR.
 *   2. The change is SHAPE (rename, type change, removal): open an ADR
 *      explaining why and how persist.ts will migrate old snapshots, then
 *      regenerate the snapshot.
 *
 * The snapshot diff is the audit trail for every schema change.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  BlastRadiusResultSchema,
  DivergenceResultSchema,
  DivergenceSchema,
  EdgeTypeSchema,
  ErrorEventSchema,
  GraphEdgeSchema,
  GraphNodeSchema,
  IncidentCardSchema,
  NodeTypeSchema,
  PolicyFileSchema,
  PolicyViolationSchema,
  ProvenanceSchema,
  RootCauseResultSchema,
  TransitiveDependenciesResultSchema,
} from '@neat.is/types'

const SNAPSHOT_PATH = join(__dirname, 'schemas.snapshot.json')

// Binding schemas — anything consumers depend on lives here. If a schema
// belongs in this list, drift fails CI. If it doesn't, treat the schema as
// internal and out of the snapshot's scope.
const BINDING_SCHEMAS: Record<string, z.ZodTypeAny> = {
  ProvenanceSchema,
  EdgeTypeSchema,
  NodeTypeSchema,
  GraphEdgeSchema,
  GraphNodeSchema,
  ErrorEventSchema,
  RootCauseResultSchema,
  BlastRadiusResultSchema,
  IncidentCardSchema,
  TransitiveDependenciesResultSchema,
  PolicyFileSchema,
  PolicyViolationSchema,
  DivergenceSchema,
  DivergenceResultSchema,
}

// Walk a Zod schema and produce a stable JSON description. Captures field
// presence, optionality, types, enum values, discriminator keys, and
// load-bearing refinements (min/max/integer/positive). Excludes cosmetic
// metadata like `.describe()` text.
function describeSchema(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodOptional) {
    return { _optional: describeSchema(schema._def.innerType) }
  }
  if (schema instanceof z.ZodNullable) {
    return { _nullable: describeSchema(schema._def.innerType) }
  }
  if (schema instanceof z.ZodDefault) {
    return { _default: describeSchema(schema._def.innerType) }
  }
  // Unwrap ZodEffects (refine / superRefine / transform) so the inner schema
  // surfaces in the snapshot. Without this, schemas like PolicyFileSchema
  // (which uses .superRefine() for id-uniqueness) collapse to "_other:
  // ZodEffects" and the snapshot can't catch shape drift on the inner object.
  if (schema instanceof z.ZodEffects) {
    return { _refined: describeSchema(schema._def.schema) }
  }
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(shape).sort()) {
      out[key] = describeSchema(shape[key]!)
    }
    return { _object: out }
  }
  if (schema instanceof z.ZodEnum) {
    return { _enum: [...(schema as z.ZodEnum<[string, ...string[]]>).options].sort() }
  }
  if (schema instanceof z.ZodLiteral) {
    return { _literal: (schema as z.ZodLiteral<unknown>).value }
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const def = schema._def
    const options: Record<string, unknown> = {}
    for (const opt of def.options as readonly z.ZodTypeAny[]) {
      const shape = (opt as z.ZodObject<z.ZodRawShape>).shape
      const disc = shape[def.discriminator] as z.ZodLiteral<string> | undefined
      const key = disc instanceof z.ZodLiteral ? String(disc.value) : '_unknown'
      options[key] = describeSchema(opt)
    }
    return { _discriminated: { discriminator: def.discriminator, options } }
  }
  if (schema instanceof z.ZodUnion) {
    const def = schema._def
    return { _union: (def.options as readonly z.ZodTypeAny[]).map(describeSchema) }
  }
  if (schema instanceof z.ZodArray) {
    return { _array: describeSchema(schema._def.type) }
  }
  if (schema instanceof z.ZodRecord) {
    return { _record: describeSchema(schema._def.valueType) }
  }
  if (schema instanceof z.ZodString) {
    const checks = schema._def.checks ?? []
    const refinements = checks.map((c) => c.kind).sort()
    return refinements.length ? { _string: refinements } : '_string'
  }
  if (schema instanceof z.ZodNumber) {
    const checks = schema._def.checks ?? []
    const refinements = checks.map((c) => c.kind).sort()
    return refinements.length ? { _number: refinements } : '_number'
  }
  if (schema instanceof z.ZodBoolean) {
    return '_boolean'
  }
  if (schema instanceof z.ZodAny) {
    return '_any'
  }
  if (schema instanceof z.ZodUnknown) {
    return '_unknown'
  }
  return { _other: schema._def.typeName ?? 'unknown' }
}

function buildCurrentSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}
  for (const name of Object.keys(BINDING_SCHEMAS).sort()) {
    snapshot[name] = describeSchema(BINDING_SCHEMAS[name]!)
  }
  return snapshot
}

describe('Schema snapshot (ADR-031)', () => {
  it('matches the committed snapshot at packages/core/test/audits/schemas.snapshot.json', () => {
    const current = buildCurrentSnapshot()
    const currentJson = JSON.stringify(current, null, 2) + '\n'

    if (process.env.UPDATE_SNAPSHOT === '1' || !existsSync(SNAPSHOT_PATH)) {
      writeFileSync(SNAPSHOT_PATH, currentJson, 'utf8')
      console.log(`Schema snapshot written to ${SNAPSHOT_PATH}`)
      return
    }

    const committed = readFileSync(SNAPSHOT_PATH, 'utf8')
    if (committed === currentJson) return

    // Drift. Surface the diff in the failure message so the developer can
    // tell at a glance whether it's growth (new field/enum value) or shape
    // (rename, removal, type change).
    expect.fail(
      [
        'Schema drift detected — the @neat.is/types schemas have changed since the snapshot was taken.',
        '',
        'If the change is GROWTH (new optional field, new enum value, additive only):',
        '  Re-run with UPDATE_SNAPSHOT=1 to regenerate, commit the updated snapshot.',
        '',
        'If the change is SHAPE (rename, removal, type change):',
        '  Open an ADR documenting why and how persist.ts will migrate old snapshots,',
        '  then regenerate.',
        '',
        'See ADR-031 / docs/contracts/schema.md.',
        '',
        '--- COMMITTED ---',
        committed,
        '--- CURRENT ---',
        currentJson,
      ].join('\n'),
    )
  })
})

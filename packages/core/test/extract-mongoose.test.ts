import { describe, it, expect } from 'vitest'
import { mongooseEndpointsFromFile, pluralizeCollection } from '../src/extract/calls/mongoose.js'
import type { SourceFile } from '../src/extract/calls/shared.js'

// extract/calls/mongoose.ts (ADR-147). The collection-grained static twin the
// OBSERVED mongodb spans (ADR-148) fuse onto. Fidelity of the pluralizer IS the
// fusion key — a name our derivation gets wrong fuses onto nothing.

const SVC = '/svc'
function file(content: string, p = '/svc/models/order.ts'): SourceFile {
  return { path: p, content }
}
function collections(eps: ReturnType<typeof mongooseEndpointsFromFile>): string[] {
  return eps.filter((e) => e.kind === 'mongodb-collection').map((e) => e.name).sort()
}

describe('mongoose pluralizer (verbatim mongoose-legacy-pluralize)', () => {
  // Cross-checked against the real package across 67 names, 0 mismatches. These
  // are the quirks a "smart" English pluralizer would get wrong — the ones that
  // make fidelity load-bearing.
  const cases: Array<[string, string]> = [
    ['Order', 'orders'],
    ['Person', 'people'],
    ['Category', 'categories'],
    ['City', 'cities'],
    ['Mouse', 'mice'],
    ['Child', 'children'],
    ['Analysis', 'analyses'],
    ['Datum', 'data'],
    ['Quiz', 'quizzes'],
    ['Box', 'boxes'],
    ['UserProfile', 'userprofiles'],
    ['APIKey', 'apikeys'],
    // The confidently-wrong-if-"smart" cases:
    ['Goose', 'gooses'],
    ['Leaf', 'leafs'],
    ['Hero', 'heros'],
    ['Data', 'datas'],
    // Uncountables — unchanged:
    ['Status', 'status'],
    ['Series', 'series'],
    ['News', 'news'],
    ['Sheep', 'sheep'],
  ]
  for (const [name, coll] of cases) {
    it(`${name} → ${coll}`, () => expect(pluralizeCollection(name)).toBe(coll))
  }
})

describe('mongooseEndpointsFromFile', () => {
  it('derives the collection from a default mongoose.model() via the pluralizer', () => {
    const eps = mongooseEndpointsFromFile(
      file(`import mongoose from 'mongoose'\nconst Order = mongoose.model('Order', orderSchema)\n`),
      SVC,
    )
    expect(collections(eps)).toEqual(['orders'])
    expect(eps[0]!.kind).toBe('mongodb-collection')
    expect(eps[0]!.confidenceKind).toBe('verified-call-site')
    expect(eps[0]!.evidence.file).toBe('models/order.ts')
    expect(eps[0]!.evidence.line).toBeGreaterThan(0)
  })

  it('honors an explicit third-arg collection literal over the pluralized name', () => {
    const eps = mongooseEndpointsFromFile(
      file(`import { model } from 'mongoose'\nconst Log = model('Log', schema, 'audit_logs')\n`),
      SVC,
    )
    expect(collections(eps)).toEqual(['audit_logs'])
  })

  it('honors a schema collection option, not the pluralized model name', () => {
    const eps = mongooseEndpointsFromFile(
      file(
        `import mongoose from 'mongoose'\n` +
          `const s = new mongoose.Schema({ name: String }, { collection: 'orders_v2' })\n` +
          `const Order = mongoose.model('Order', s)\n`,
      ),
      SVC,
    )
    // 'orders' (the pluralized guess) must NOT appear — the option wins.
    expect(collections(eps)).toEqual(['orders_v2'])
  })

  it('reads the collection literal from the native driver', () => {
    const eps = mongooseEndpointsFromFile(
      file(`import { MongoClient } from 'mongodb'\nawait db.collection('orders').insertOne(doc)\n`, '/svc/repo.ts'),
      SVC,
    )
    expect(collections(eps)).toEqual(['orders'])
  })

  it('falls back to the model grain when the third-arg collection is computed', () => {
    const eps = mongooseEndpointsFromFile(
      file(`import mongoose from 'mongoose'\nconst M = mongoose.model('Order', schema, collName)\n`),
      SVC,
    )
    // No fabricated collection name — the coarser mongodb-model grain instead.
    expect(collections(eps)).toEqual([])
    expect(eps.map((e) => `${e.kind}:${e.name}`)).toEqual(['mongodb-model:Order'])
  })

  it('returns the raw model name when pluralization is disabled in-file', () => {
    const eps = mongooseEndpointsFromFile(
      file(`import mongoose from 'mongoose'\nmongoose.pluralize(null)\nconst Order = mongoose.model('Order', schema)\n`),
      SVC,
    )
    expect(collections(eps)).toEqual(['Order'])
  })

  it('claims nothing without a mongoose or mongodb import', () => {
    const eps = mongooseEndpointsFromFile(
      file(`const Order = model('Order', schema)\nawait db.collection('orders').find()\n`),
      SVC,
    )
    expect(eps).toEqual([])
  })

  it('dedups a collection referenced from several call sites in one file', () => {
    const eps = mongooseEndpointsFromFile(
      file(
        `import mongoose from 'mongoose'\n` +
          `const Order = mongoose.model('Order', s)\n` +
          `await Order.find()\n` +
          `await mongoose.connection.collection('orders').countDocuments()\n`,
      ),
      SVC,
    )
    expect(collections(eps)).toEqual(['orders'])
  })

  it('names several distinct collections in a repository module', () => {
    const eps = mongooseEndpointsFromFile(
      file(
        `import mongoose from 'mongoose'\n` +
          `export const User = mongoose.model('User', userSchema)\n` +
          `export const Category = mongoose.model('Category', catSchema)\n` +
          `export const Goose = mongoose.model('Goose', gooseSchema)\n`,
        '/svc/models/index.ts',
      ),
      SVC,
    )
    expect(collections(eps)).toEqual(['categories', 'gooses', 'users'])
  })
})

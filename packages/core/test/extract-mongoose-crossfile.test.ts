import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mongooseCrossFileEndpoints } from '../src/extract/calls/mongoose.js'
import type { SourceFile } from '../src/extract/calls/shared.js'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { EdgeType, infraId, type GraphEdge } from '@neat.is/types'

// ADR-149 — cross-file model→collection resolution. A query in routes/ is
// attributed to the collection of a model defined in models/, resolved through
// the import graph. The resolver hits the filesystem, so these write a real
// service tree and run the whole-program pass over its files.

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function service(files: Record<string, string>): Promise<{ dir: string; sources: SourceFile[] }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-mongo-xfile-'))
  const dir = await fs.realpath(base)
  dirs.push(dir)
  const sources: SourceFile[] = []
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
    sources.push({ path: abs, content })
  }
  return { dir, sources }
}

// "<relative query file> → <collection>" pairs, sorted, for compact assertions.
function attributed(eps: Awaited<ReturnType<typeof mongooseCrossFileEndpoints>>): string[] {
  return eps.map((e) => `${e.evidence.file} → ${e.name}`).sort()
}

describe('mongooseCrossFileEndpoints (ADR-149)', () => {
  it('attributes a default/whole-module import of a single-model file', async () => {
    const { dir, sources } = await service({
      'models/order.js':
        `const mongoose = require('mongoose')\n` +
        `const Order = mongoose.model('Order', new mongoose.Schema({ name: String }))\n` +
        `module.exports = Order\n`,
      'routes/orders.js': `const Order = require('../models/order')\nasync function h() { return Order.find({}) }\n`,
    })
    expect(attributed(await mongooseCrossFileEndpoints(sources, dir))).toEqual(['routes/orders.js → orders'])
  })

  it('attributes a named import from a multi-model barrel', async () => {
    const { dir, sources } = await service({
      'models/index.js':
        `const mongoose = require('mongoose')\n` +
        `const User = mongoose.model('User', new mongoose.Schema({}))\n` +
        `const Post = mongoose.model('Post', new mongoose.Schema({}))\n` +
        `module.exports = { User, Post }\n`,
      'routes/users.js': `const { User } = require('../models')\nUser.findOne({ id: 1 })\n`,
    })
    expect(attributed(await mongooseCrossFileEndpoints(sources, dir))).toEqual(['routes/users.js → users'])
  })

  it('resolves ESM default import + export default', async () => {
    const { dir, sources } = await service({
      'models/order.ts':
        `import mongoose from 'mongoose'\n` +
        `const Order = mongoose.model('Order', new mongoose.Schema({}))\n` +
        `export default Order\n`,
      'routes/orders.ts': `import Order from '../models/order'\nawait Order.updateOne({}, {})\n`,
    })
    expect(attributed(await mongooseCrossFileEndpoints(sources, dir))).toEqual(['routes/orders.ts → orders'])
  })

  it('resolves namespace access — models.User.find()', async () => {
    const { dir, sources } = await service({
      'models/index.js':
        `const mongoose = require('mongoose')\n` +
        `const User = mongoose.model('User', new mongoose.Schema({}))\n` +
        `module.exports = { User }\n`,
      'services/user.js': `const models = require('../models')\nmodels.User.deleteMany({})\n`,
    })
    expect(attributed(await mongooseCrossFileEndpoints(sources, dir))).toEqual(['services/user.js → users'])
  })

  it('applies the pluralizer quirk across files (Goose → gooses)', async () => {
    const { dir, sources } = await service({
      'models/goose.js':
        `const mongoose = require('mongoose')\n` +
        `module.exports = mongoose.model('Goose', new mongoose.Schema({}))\n`,
      'routes/geese.js': `const Goose = require('../models/goose')\nGoose.find()\n`,
    })
    expect(attributed(await mongooseCrossFileEndpoints(sources, dir))).toEqual(['routes/geese.js → gooses'])
  })

  it('honors a whole-program pluralize(null) flag from a bootstrap file', async () => {
    const { dir, sources } = await service({
      'db.js': `const mongoose = require('mongoose')\nmongoose.pluralize(null)\nmodule.exports = mongoose\n`,
      'models/order.js':
        `const mongoose = require('mongoose')\n` +
        `module.exports = mongoose.model('Order', new mongoose.Schema({}))\n`,
      'routes/orders.js': `const Order = require('../models/order')\nOrder.find()\n`,
    })
    // pluralize(null) → the collection is the raw model name, not 'orders'.
    expect(attributed(await mongooseCrossFileEndpoints(sources, dir))).toEqual(['routes/orders.js → Order'])
  })

  it('does not double-count a model defined and queried in the same file', async () => {
    const { dir, sources } = await service({
      'models/order.js':
        `const mongoose = require('mongoose')\n` +
        `const Order = mongoose.model('Order', new mongoose.Schema({}))\n` +
        `Order.find()\n` +
        `module.exports = Order\n`,
    })
    // The in-file pass owns this one; cross-file emits nothing.
    expect(await mongooseCrossFileEndpoints(sources, dir)).toEqual([])
  })

  it('claims nothing for a node_modules import that happens to look like a query', async () => {
    const { dir, sources } = await service({
      'models/order.js': `const mongoose = require('mongoose')\nmodule.exports = mongoose.model('Order', new mongoose.Schema({}))\n`,
      'util.js': `const _ = require('lodash')\n_.find([], (x) => x)\n`,
    })
    // lodash doesn't resolve to a model file → no phantom edge from `_.find`.
    expect(await mongooseCrossFileEndpoints(sources, dir)).toEqual([])
  })

  it('end-to-end: the query file → collection edge lands in the extracted graph', async () => {
    const { dir } = await service({
      'package.json': JSON.stringify({ name: 'orders', version: '1.0.0', dependencies: { mongoose: '^8.0.0' } }),
      'models/order.js':
        `const mongoose = require('mongoose')\n` +
        `module.exports = mongoose.model('Order', new mongoose.Schema({ name: String }))\n`,
      'routes/orders.js': `const Order = require('../models/order')\nasync function h() { return Order.find({}) }\n`,
    })
    resetGraph()
    const g = getGraph()
    await extractFromDirectory(g, dir)

    const collection = infraId('mongodb-collection', 'orders')
    expect(g.filterNodes((id) => id.startsWith('infra:mongodb-collection:'))).toEqual([collection])

    // A CALLS edge to the collection originates from the ROUTES file, not just
    // the model-definition file — the cross-file attribution the whole feature
    // is about.
    const sources = g
      .filterEdges((_id, e: GraphEdge) => e.type === EdgeType.CALLS && e.target === collection)
      .map((id) => (g.getEdgeAttributes(id) as GraphEdge).source)
    expect(sources.some((s) => s.includes('routes/orders.js'))).toBe(true)
  })
})

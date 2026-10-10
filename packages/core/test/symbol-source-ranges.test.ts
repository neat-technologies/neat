import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeType, SymbolSpanSchema, symbolId, type SymbolNode } from '@neat.is/types'
import { buildApi } from '../src/api.js'
import { extractFromDirectory } from '../src/extract.js'
import { getGraph, resetGraph } from '../src/graph.js'

const roots: string[] = []
const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'symbols-polyglot',
)

async function project(source: string | Buffer): Promise<{ root: string; file: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-symbol-range-'))
  roots.push(root)
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"range-svc","version":"1.0.0"}')
  const file = path.join(root, 'src', 'entry.ts')
  await fs.mkdir(path.dirname(file))
  await fs.writeFile(file, source)
  return { root, file }
}

function symbol(name: string): SymbolNode {
  return getGraph().getNodeAttributes(symbolId('range-svc', 'src/entry.ts', name)) as SymbolNode
}

function selected(bytes: Buffer, node: SymbolNode): string {
  const { startByte, endByte } = node.span
  expect(startByte).toBeDefined()
  expect(endByte).toBeDefined()
  return bytes.subarray(startByte!, endByte!).toString('utf8')
}

afterEach(async () => {
  resetGraph()
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true })
})

describe('precise static symbol ranges (ADR-234)', () => {
  it('exposes in-file byte intervals through every supported language extractor', async () => {
    resetGraph()
    await extractFromDirectory(getGraph(), fixtures)
    const cases = [
      ['orders-py', 'orders-py', 'orders.py'],
      ['orders-go', 'orders-go', 'orders.go'],
      ['orders-rb', 'orders-rb', 'orders.rb'],
      ['quote-php', 'quote-php', 'quote.php'],
      ['cart', 'cart-csharp', 'cart.cs'],
      ['cart-java', 'cart-java', 'CartService.java'],
      ['fraud-kotlin', 'fraud-kotlin', 'FraudService.kt'],
      ['shipping', 'shipping-rust', 'shipping.rs'],
      ['currency', 'currency-cpp', 'currency.cpp'],
    ] as const
    for (const [service, directory, relPath] of cases) {
      const nodes: SymbolNode[] = []
      getGraph().forEachNode((_id, value) => {
        const node = value as SymbolNode
        if (
          node.type === NodeType.SymbolNode &&
          node.service === service &&
          node.relPath === relPath
        ) {
          nodes.push(node)
        }
      })
      expect(nodes.length, `no symbols for ${service}/${relPath}`).toBeGreaterThan(0)
      const bytes = await fs.readFile(path.join(fixtures, directory, relPath))
      for (const node of nodes) {
        const slice = selected(bytes, node)
        expect(slice.length, node.id).toBeGreaterThan(0)
        expect(node.span.endByte!, node.id).toBeLessThanOrEqual(bytes.length)
      }
    }
  })

  it('separates same-line siblings and nested definitions after non-ASCII and CRLF', async () => {
    const source = [
      'const café = "☕";',
      'function alpha(){return 1} function beta(){return 2}',
      'function outer(){function inner(){return 3}; return inner()}',
      '',
    ].join('\r\n')
    const { root, file } = await project(source)
    await extractFromDirectory(getGraph(), root)
    const bytes = await fs.readFile(file)
    const alpha = symbol('alpha')
    const beta = symbol('beta')
    const outer = symbol('outer')
    const inner = symbol('inner')

    for (const node of [alpha, beta, outer, inner]) {
      expect(node.type).toBe(NodeType.SymbolNode)
      expect(SymbolSpanSchema.safeParse(node.span).success).toBe(true)
    }
    expect(alpha.span.startLine).toBe(beta.span.startLine)
    expect(selected(bytes, alpha)).toBe('function alpha(){return 1}')
    expect(selected(bytes, beta)).toBe('function beta(){return 2}')
    expect(alpha.span.endByte).toBeLessThan(beta.span.startByte!)
    expect(selected(bytes, inner)).toBe('function inner(){return 3}')
    expect(selected(bytes, outer)).toContain(selected(bytes, inner))
    expect(outer.span.startByte).toBeLessThan(inner.span.startByte!)
    expect(outer.span.endByte).toBeGreaterThan(inner.span.endByte!)
    expect(alpha.span.startByte).toBe(
      Buffer.byteLength(source.slice(0, source.indexOf('function alpha'))),
    )

    const app = await buildApi({ graph: getGraph(), scanPath: root })
    try {
      const response = await app.inject({ method: 'GET', url: '/graph' })
      expect(response.statusCode).toBe(200)
      const transported = (response.json().nodes as SymbolNode[]).find((node) => node.id === alpha.id)
      expect(transported?.span).toEqual(alpha.span)
      expect(transported?.span.startByte).toBe(alpha.span.startByte)
      expect(transported?.span.endByte).toBe(alpha.span.endByte)
    } finally {
      await app.close()
    }
  })

  it('refreshes coordinates after a new extraction and matches the pinned Git commit bytes', async () => {
    const { root, file } = await project('function target(){return 1}\n')
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'add', '.'])
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=NEAT Test',
      '-c',
      'user.email=test@neat.is',
      'commit',
      '-qm',
      'baseline',
    ])
    const firstSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    await extractFromDirectory(getGraph(), root)
    const first = { ...symbol('target').span }
    const committed = execFileSync('git', ['-C', root, 'show', `${firstSha}:src/entry.ts`])
    expect(selected(committed, symbol('target'))).toBe('function target(){return 1}')

    await fs.writeFile(file, 'const café = "☕";\r\nfunction target(){return 22}\r\n')
    execFileSync('git', ['-C', root, 'add', '.'])
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=NEAT Test',
      '-c',
      'user.email=test@neat.is',
      'commit',
      '-qm',
      'changed',
    ])
    const secondSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    await extractFromDirectory(getGraph(), root)
    const updated = symbol('target')
    const second = execFileSync('git', ['-C', root, 'show', `${secondSha}:src/entry.ts`])
    expect(updated.span.startByte).toBeGreaterThan(first.startByte!)
    expect(updated.span.startLine).toBe(2)
    expect(selected(second, updated)).toBe('function target(){return 22}')
  })

  it('does not publish a symbol update for an unchanged extraction', async () => {
    const { root, file } = await project('function target(){return 1}\n')
    await extractFromDirectory(getGraph(), root)
    const id = symbol('target').id
    let updates = 0
    const onUpdate = ({ key }: { key: string }) => { if (key === id) updates++ }
    getGraph().on('nodeAttributesUpdated', onUpdate)
    try {
      await extractFromDirectory(getGraph(), root)
      expect(updates).toBe(0)
      await fs.writeFile(file, 'const café = "☕";\nfunction target(){return 1}\n')
      await extractFromDirectory(getGraph(), root)
      expect(updates).toBe(1)
    } finally {
      getGraph().off('nodeAttributesUpdated', onUpdate)
    }
  })

  it('omits unsafe byte coordinates for undecodable UTF-8 and retains line compatibility', async () => {
    const { root } = await project(
      Buffer.concat([
        Buffer.from('const x = "'),
        Buffer.from([0xff]),
        Buffer.from('";\nfunction target(){return 1}\n'),
      ]),
    )
    await extractFromDirectory(getGraph(), root)
    const range = symbol('target').span
    expect(range.startLine).toBe(2)
    expect(range.endLine).toBe(2)
    expect(range.startByte).toBeUndefined()
    expect(range.endByte).toBeUndefined()
    expect(SymbolSpanSchema.safeParse(range).success).toBe(true)
    expect(SymbolSpanSchema.safeParse({ startLine: 2, endLine: 2, startByte: 1 }).success).toBe(
      false,
    )
    expect(
      SymbolSpanSchema.safeParse({ startLine: 2, endLine: 2, startByte: 2, endByte: 2 }).success,
    ).toBe(false)
  })

  it('omits precise coordinates when the file has a syntax error', async () => {
    const { root } = await project('function target(){return 1}\nfunction broken(\n')
    await extractFromDirectory(getGraph(), root)
    const span = symbol('target').span
    expect(span.startLine).toBe(1)
    expect(span.startByte).toBeUndefined()
    expect(span.endByte).toBeUndefined()
  })
})

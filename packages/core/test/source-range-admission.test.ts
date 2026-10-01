import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NodeType, SerializedGraphSchema, symbolId, type SymbolNode } from '@neat.is/types'
import { buildApi } from '../src/api.js'
import { extractFromDirectory } from '../src/extract.js'
import { getGraph, resetGraph } from '../src/graph.js'

const roots: string[] = []
afterEach(async () => {
  resetGraph()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('serves exact pinned commit and UTF-8 symbol ranges in one authenticated graph response', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'neat-source-range-admission-'))
  roots.push(root)
  const file = path.join(root, 'src', 'entry.ts')
  await mkdir(path.dirname(file))
  await writeFile(path.join(root, 'package.json'), '{"name":"range-svc","version":"1.0.0"}')
  await writeFile(file, 'const café="☕";\r\nfunction alpha(){return 1} function beta(){return 2}\r\n')
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'add', '.'])
  execFileSync('git', ['-C', root, '-c', 'user.name=NEAT Test', '-c', 'user.email=test@neat.is', 'commit', '-qm', 'pinned'])
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  expect(sha).toMatch(/^[0-9a-f]{40}$/)
  const repository = 'acme/app'
  await extractFromDirectory(getGraph(), root, { sourceCommit: { repository, sha } })

  const app = await buildApi({ graph: getGraph(), authToken: 'READ_TOKEN' })
  try {
    const response = await app.inject({
      method: 'GET', url: '/graph', headers: { authorization: 'Bearer READ_TOKEN' },
    })
    expect(response.statusCode).toBe(200)
    const wire = SerializedGraphSchema.parse(response.json())
    expect(wire.sourceBaseline).toEqual({ status: 'ready', repository, sha })
    const committed = execFileSync('git', ['-C', root, 'show', `${sha}:src/entry.ts`])
    expect(committed.equals(await readFile(file))).toBe(true)
    const symbols = wire.nodes.filter((node): node is SymbolNode => node.type === NodeType.SymbolNode)
    const alpha = symbols.find((node) => node.id === symbolId('range-svc', 'src/entry.ts', 'alpha'))
    const beta = symbols.find((node) => node.id === symbolId('range-svc', 'src/entry.ts', 'beta'))
    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()
    const slice = (node: SymbolNode) => committed.subarray(node.span.startByte!, node.span.endByte!).toString('utf8')
    expect(slice(alpha!)).toBe('function alpha(){return 1}')
    expect(slice(beta!)).toBe('function beta(){return 2}')
    expect(alpha!.span.startLine).toBe(beta!.span.startLine)
    expect(alpha!.span.endByte!).toBeLessThan(beta!.span.startByte!)
  } finally {
    await app.close()
  }
})

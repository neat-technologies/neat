import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractFromDirectory } from '../src/extract.js'
import { makeGraph, type NeatGraph } from '../src/graph.js'
import { EVENT_BUS_CHANNEL, eventBus } from '../src/events.js'

// A pass's working state — the error / dropped / skipped sinks, and the source
// stamped on every FileNode (ADR-233) — is module-level. Two passes running at
// once, as a hosted daemon's repo-sync and a PR verdict can, must not see each
// other's. extractFromDirectory runs them one at a time.

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})

async function repo(name: string, files: number): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `neat-serial-${name}-`)))
  dirs.push(dir)
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  await fs.mkdir(path.join(dir, 'src'))
  for (let i = 0; i < files; i++) {
    await fs.writeFile(path.join(dir, 'src', `f${i}.js`), `function f${i}(){return ${i}}\nmodule.exports=f${i}\n`)
  }
  return dir
}

function fileSources(graph: NeatGraph): Set<string | undefined> {
  const out = new Set<string | undefined>()
  graph.forEachNode((_id, attrs) => {
    const a = attrs as { type?: string; source?: string }
    if (a.type === 'FileNode') out.add(a.source)
  })
  return out
}

describe('extraction passes', () => {
  it('stamp each concurrent pass’s FileNodes with its own source, never the other’s', async () => {
    const [a, b] = await Promise.all([repo('alpha', 40), repo('beta', 40)])
    const ga = makeGraph()
    const gb = makeGraph()
    const gc = makeGraph()
    await Promise.all([
      extractFromDirectory(ga, a, { source: 'acme/alpha' }),
      extractFromDirectory(gb, b, { source: 'acme/beta' }),
      extractFromDirectory(gc, a),
    ])
    expect(fileSources(ga)).toEqual(new Set(['acme/alpha']))
    expect(fileSources(gb)).toEqual(new Set(['acme/beta']))
    expect(fileSources(gc)).toEqual(new Set([undefined]))
  })

  it('run in the order they were asked for, and a failed pass does not stall the next', async () => {
    const a = await repo('gamma', 3)
    const order: string[] = []
    const first = extractFromDirectory(makeGraph(), path.join(a, 'missing-dir')).then(
      () => order.push('first'),
      () => order.push('first-failed'),
    )
    const second = extractFromDirectory(makeGraph(), a).then(() => order.push('second'))
    await Promise.all([first, second])
    expect(order[1]).toBe('second')
  })

  it('stay quiet on the event bus when asked to', async () => {
    const a = await repo('delta', 2)
    const seen: string[] = []
    const listener = (e: { type: string }) => seen.push(e.type)
    eventBus.on(EVENT_BUS_CHANNEL, listener)
    try {
      await extractFromDirectory(makeGraph(), a, { announce: false })
      expect(seen).not.toContain('extraction-complete')
      await extractFromDirectory(makeGraph(), a)
      expect(seen).toContain('extraction-complete')
    } finally {
      eventBus.off(EVENT_BUS_CHANNEL, listener)
    }
  })
})

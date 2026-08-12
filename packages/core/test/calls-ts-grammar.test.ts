import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import TypeScript from 'tree-sitter-typescript'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { callsFromSource } from '../src/extract/calls/http.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'ts-grammar-calls')

// #883 — the http-call extractor parsed every non-Python file with the
// JavaScript grammar, so a `.ts` file rode tree-sitter-javascript. That grammar
// bails on a handful of TypeScript-only shapes into an ERROR node that swallows
// a nearby URL literal — the call site is skipped with no throw, and CALLS
// quietly undercounts on a valid `.ts` file. The extractor now routes `.ts` /
// `.tsx` through tree-sitter-typescript.
describe('#883 — .ts CALLS extraction under the TypeScript grammar', () => {
  beforeEach(() => resetGraph())

  // The two shapes the JS grammar can't parse: a `<T>expr` type assertion and a
  // `const` type parameter. Each carries a URL literal to the `orders` host.
  const cases: Record<string, string> = {
    'angle-bracket type assertion': `const u = <string>'https://orders/charge'\n`,
    'const type parameter':
      `function id<const T>(x: T) { return x }\n` +
      `const u = id('https://orders/charge')\n`,
  }

  for (const [name, src] of Object.entries(cases)) {
    it(`${name}: the JS grammar drops the host, the TS grammar keeps it`, () => {
      const js = new Parser()
      js.setLanguage(JavaScript)
      const ts = new Parser()
      ts.setLanguage(TypeScript.typescript)
      const hosts = new Set(['orders'])
      // Root cause: under the JS grammar the literal is gone.
      expect(callsFromSource(src, js, hosts).map((s) => s.host)).toEqual([])
      // The fix: the TS grammar recovers it.
      expect(callsFromSource(src, ts, hosts).map((s) => s.host)).toEqual(['orders'])
    })
  }

  it('extractFromDirectory mints the file→service CALLS edge from a .ts caller with TS-only syntax', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)
    // billing/client.ts names `https://orders/charge` inside a `<string>` type
    // assertion. Before the fix the JS grammar dropped that literal and this
    // edge was silently absent; now it lands.
    expect(graph.hasEdge('CALLS:file:billing:client.ts->service:orders')).toBe(true)
  })
})

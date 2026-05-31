import { describe, it, expect } from 'vitest'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import { callsFromSource } from '../src/extract/calls/http.js'

// #431 — tree-sitter's node binding copies a string passed to `parser.parse`
// into a ~32K-code-unit scratch buffer and throws a bare "Invalid argument"
// once the source is larger. NEAT's own cli.ts / ingest.ts /
// installers/javascript.ts all clear 40K, so the http-call extractor silently
// skipped them while dogfooding. callsFromSource feeds the source through the
// callback form, which sidesteps the buffer, so files of any size parse.
describe('callsFromSource on files past the tree-sitter string limit', () => {
  function makeJsParser(): Parser {
    const p = new Parser()
    p.setLanguage(JavaScript)
    return p
  }

  it('parses a source larger than the 32K buffer and still finds the host', () => {
    const parser = makeJsParser()
    // Pad past the limit with filler statements, then name a known host on a
    // line that only the parser (not a substring scan) can place correctly.
    const filler = 'const noise = 1\n'.repeat(4000) // ~64K, well past 32768
    const source = `${filler}const url = 'https://payments.example/charge'\n`
    const hosts = new Set(['payments.example'])

    const sites = callsFromSource(source, parser, hosts)

    expect(sites).toHaveLength(1)
    expect(sites[0].host).toBe('payments.example')
    // The line is recovered from the AST, not guessed — it sits just after the
    // 4000 filler lines.
    expect(sites[0].line).toBe(4001)
  })

  it('handles multibyte content past the limit (buffer counts code units)', () => {
    const parser = makeJsParser()
    const comment = '// 😀 ünïcödé padding\n'.repeat(3000) // multibyte, > 32K units
    const source = `${comment}const u = 'https://billing.example/x'\n`
    const sites = callsFromSource(source, parser, new Set(['billing.example']))
    expect(sites.map((s) => s.host)).toEqual(['billing.example'])
  })
})

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import TypeScript from 'tree-sitter-typescript'
import { EdgeType, extractedEdgeId, symbolId } from '@neat.is/types'
import { collectSymbolDefs } from '../src/extract/symbols.js'
import { extractFromDirectory } from '../src/extract.js'
import { getGraph, resetGraph } from '../src/graph.js'

// #1553: JS defines most library and Express functions by assignment, wrapped in a
// call, or as a named callback. Each is minted under what the source binds it to.
const defs = (src: string, lang: unknown = JavaScript) => {
  const p = new Parser()
  p.setLanguage(lang as Parser.Language)
  return collectSymbolDefs(p.parse(src).rootNode).map((d) => `${d.kind} ${d.qualname} L${d.startLine}`)
}

describe('JS functions bound by assignment, wrapped in a call, or passed as a named callback (#1553)', () => {
  it('mints every form in the issue repro', () => {
    expect(
      defs(`function declared() {}
const arrow = () => 1
res.location = function location(url) { return url }
exports.handler = function (req) { return req }
module.exports = function main() {}
module.exports.helper = async function helper() {}
var pick = flatRest(function(object, paths) { return object })
router.get('/x', function namedHandler(req, res) {})
`),
    ).toEqual([
      'function declared L1',
      'function arrow L2',
      'function res.location L3',
      'function exports.handler L4',
      'function main L5',
      'function module.exports.helper L6',
      'function pick L7',
      'function namedHandler L8',
    ])
  })

  it('names an assignment by its target, and a whole-module export by the function when it has a name', () => {
    expect(defs(`module.exports = function () {}\nexports = function run() {}\nFoo.prototype.bar = function () {}\nthis.go = () => 1\nlater = function () {}`)).toEqual([
      'function module.exports L1',
      'function run L2',
      'function Foo.prototype.bar L3',
      'function this.go L4',
      'function later L5',
    ])
  })

  it('reads through nested wrappers and async arrows', () => {
    expect(defs(`const a = memoize(debounce(() => 1))\nexports.h = asyncHandler(async (req, res) => {})`)).toEqual([
      'function a L1',
      'function exports.h L2',
    ])
  })

  it('mints no name it would have to invent', () => {
    expect(
      defs(`router.get('/x', function (req, res) {})
app.use((req, res, next) => next())
handlers[name] = function () {}
const { a, b } = wrap(function () {})
;[1].forEach(function () {})`),
    ).toEqual([])
  })

  it('does not read a value-returning call as a definition', () => {
    expect(
      defs(`const total = items.reduce((a, b) => a + b, 0)
const doubled = items.map(function (x) { return x * 2 })
const v = useMemo(() => compute(), [])
const t = setTimeout(() => {}, 10)
const s = schema.refine((x) => x)
const n = compute(1, () => {})`),
    ).toEqual([])
  })

  it('counts a call-wrapped binding once, not again under the wrapped function’s own name', () => {
    expect(defs(`var pick = flatRest(function pick2(o) { return o })\nres.send = function send() {}`)).toEqual([
      'function pick L1',
      'function res.send L2',
    ])
  })

  it('never takes a qualname an existing definition holds, so that symbol keeps its id', () => {
    // Sharing `dup` would give the declaration an ordinal (`#dup~0`), changing its id.
    expect(defs(`function dup() {}\napp.use(function dup() {})\nclass K {}\nK = wrap(function () {})`)).toEqual([
      'function dup L1',
      'class K L3',
    ])
  })

  it('reads TypeScript the same way', () => {
    expect(defs(`export const h = withAuth(async (req: Req): Promise<void> => {})\nres.json = function json(body: unknown) {}`, TypeScript.typescript)).toEqual([
      'function h L1',
      'function res.json L2',
    ])
  })
})

describe('the new symbols in the graph (#1553)', () => {
  let dir: string
  beforeEach(() => {
    resetGraph()
    dir = mkdtempSync(path.join(tmpdir(), 'neat-1553-'))
    mkdirSync(path.join(dir, 'lib'))
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bound-svc', version: '1.0.0', dependencies: { express: '^4.19.0' } }))
    writeFileSync(
      path.join(dir, 'lib', 'app.js'),
      `var pick = flatRest(function (o, keys) { return o })
function load(id) { return pick({ id }, ['id']) }
res.location = function location(url) { return load(url) }
router.get('/x', function listOrders(req, res) { return load(req.id) })
`,
    )
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('mints the nodes and resolves same-file calls to and from them', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, dir)
    const sym = (q: string) => symbolId('bound-svc', 'lib/app.js', q)
    for (const q of ['pick', 'load', 'res.location', 'listOrders']) expect(graph.hasNode(sym(q)), q).toBe(true)

    expect(graph.hasEdge(extractedEdgeId(sym('load'), sym('pick'), EdgeType.CALLS))).toBe(true)
    expect(graph.hasEdge(extractedEdgeId(sym('res.location'), sym('load'), EdgeType.CALLS))).toBe(true)
    // A call inside the named route callback belongs to the callback, its innermost enclosing symbol.
    expect(graph.hasEdge(extractedEdgeId(sym('listOrders'), sym('load'), EdgeType.CALLS))).toBe(true)
  })
})

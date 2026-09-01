import path from 'node:path'
import Parser from 'tree-sitter'
import Python from 'tree-sitter-python'
import { infraId } from '@neat.is/types'
import { snippet, type ExternalEndpoint, type SourceFile } from './shared.js'

// Raw TCP socket dependencies in Python: `socket.socket(...)` paired with a
// `<sock>.connect((host, port))`. Frameworked clients have their own recognizers
// (gRPC stubs, `redis://` URLs, SQLAlchemy models, ...); this catches the bare-socket
// dependency those miss — a service that speaks a custom line protocol to a datastore
// over `socket.connect((host, port))`, which otherwise leaves NO EXTRACTED edge at all,
// so a runtime connection-refused on that hop has no static twin to fuse onto and the
// dependency is invisible past the last instrumented call.
//
// Precision — gated on both `import socket` AND a `socket.socket(...)` constructor in
// the file, then only a `.connect(...)` whose single positional argument is a 2-element
// address TUPLE. That tuple is socket.connect's distinctive signature: a DB driver or
// ORM `.connect()` takes a URL or keyword arguments, never a bare `(host, port)` pair,
// so the tuple shape is what separates a real socket connect from an unrelated
// `.connect()` method call.
//
// Target naming honors "evidence is never fabricated": a string-literal host resolves
// to a named `infra:socket:<host>[:<port>]` endpoint; a non-literal host — a variable or
// env-driven address, e.g. `s.connect((host, port))` where `host` came from
// `os.environ` — is not guessed, it lands on a stable `infra:socket:env` sentinel, the
// same honest-sentinel discipline calls/supabase.ts uses for `process.env`-driven URLs.
// Resolving an env-var name or its .env value to the concrete host is a follow-on.

const SOCKET_IMPORT_RE = /(?:^|\n)\s*(?:import\s+socket\b|from\s+socket\s+import\b)/

const PARSE_CHUNK = 16384

function makePyParser(): Parser {
  const p = new Parser()
  p.setLanguage(Python)
  return p
}

function parseSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index: number) =>
    index >= source.length ? '' : source.slice(index, index + PARSE_CHUNK),
  )
}

function namedChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (c) out.push(c)
  }
  return out
}

function walk(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  visit(node)
  for (const c of namedChildren(node)) walk(c, visit)
}

function pyStaticStringText(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'string') return null
  for (const child of namedChildren(node)) {
    if (child.type === 'interpolation') return null // f-string — not a static literal
    if (child.type === 'string_content') return child.text
  }
  return ''
}

// The file constructs a raw socket: `socket.socket(...)`, or a `from socket import
// socket` then a bare `socket(...)`. This gate keeps a `.connect(tuple)` on some other
// object from ever being read as a socket connect.
function hasSocketConstructor(root: Parser.SyntaxNode): boolean {
  let found = false
  walk(root, (n) => {
    if (found || n.type !== 'call') return
    const t = n.childForFieldName('function')?.text
    if (t === 'socket.socket' || t === 'socket') found = true
  })
  return found
}

export function socketEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  if (!SOCKET_IMPORT_RE.test(file.content)) return []
  const tree = parseSource(makePyParser(), file.content)
  if (!hasSocketConstructor(tree.rootNode)) return []

  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()

  walk(tree.rootNode, (node) => {
    if (node.type !== 'call') return
    const fn = node.childForFieldName('function')
    if (fn?.type !== 'attribute' || fn.childForFieldName('attribute')?.text !== 'connect') return
    const args = node.childForFieldName('arguments')
    const first = args ? namedChildren(args).find((a) => a.type !== 'keyword_argument') : undefined
    // socket.connect's one positional argument is the address TUPLE `(host, port)` —
    // the discriminator that separates it from an unrelated `.connect()`.
    if (!first || first.type !== 'tuple') return
    const elems = namedChildren(first)
    if (elems.length < 2) return

    const hostNode = elems[0]!
    const host = hostNode.type === 'string' ? pyStaticStringText(hostNode) : null
    const portNode = elems[1]!
    const port = portNode.type === 'integer' ? portNode.text : null
    // Literal host → named endpoint; non-literal (variable / env-driven) → honest
    // sentinel, never a guessed host.
    const name = host ? (port ? `${host}:${port}` : host) : 'env'
    if (seen.has(name)) return
    seen.add(name)

    const line = node.startPosition.row + 1
    out.push({
      infraId: infraId('socket', name),
      name,
      kind: 'socket',
      edgeType: 'CALLS',
      // A verified `socket.socket(...)` + `.connect((host, port))` call site.
      confidenceKind: 'verified-call-site',
      evidence: {
        file: path.relative(serviceDir, file.path),
        line,
        snippet: snippet(file.content, line),
      },
    })
  })

  return out
}

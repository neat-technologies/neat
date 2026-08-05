import type { GraphNode, InfraNode } from '@neat.is/types'
import { NodeType } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import type { DiscoveredService } from './shared.js'
import { findFirst, readIfExists } from './databases/shared.js'

// firestore.rules guard-set producer (ADR-169). A **standalone** extract phase —
// not a `calls/` producer — that reads each service's checked-in `firestore.rules`
// as a declared artifact and folds a `guardedFields` set onto the
// `firestore-collection` InfraNodes the F1 recognizer (ADR-167) mints in the calls
// phase. Reading a checked-in rules file as text is the same read-polyglot-as-data
// discipline `calls/prisma.ts` follows for `schema.prisma`.
//
// The `field-guard` policy (ADR-169, packages/core/src/policy.ts) is the consumer:
// it asserts every client-written column on a collection appears in that
// collection's `guardedFields`. The load-bearing rule is honesty about what the
// scanner can and cannot reduce — a guard that is condition-based,
// function-indirected, or otherwise not an explicit field list leaves the
// collection INDETERMINATE (no `guardedFields` folded), and the policy then stays
// silent rather than firing a false positive.

export const FIRESTORE_COLLECTION_KIND = 'firestore-collection'

// The write-family rule methods. A guard only matters on the write path — a read
// rule constrains no field the code writes, so it never contributes.
const WRITE_METHODS = new Set(['write', 'create', 'update'])

// Strip `//` line and `/* */` block comments, honoring string literals so a `/`
// inside a quoted path or message is not mistaken for a comment.
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  let inStr: string | null = null
  while (i < n) {
    const ch = src[i]!
    const next = src[i + 1]
    if (inStr) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === inStr) inStr = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = ch
      out += ch
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

function segmentsFromMatchPath(pathToken: string): string[] {
  return pathToken.split('/').filter((s) => s.length > 0)
}

// Normalize a sequence of match-path segments to the collection join key: strip
// the standard `/databases/{db}/documents` root wrapper, drop `{wildcard}`
// document-id segments, lowercase the remaining collection names, join with `/`.
// A nested `/users/{userId}/posts/{postId}` becomes `users/posts`. Field names in
// the graph are lowercased by `foldColumns`, so the key is lowercased too, keeping
// the join case-insensitive.
function collectionKeyFromSegments(segments: string[]): string {
  let segs = segments
  if (
    segs.length >= 3 &&
    segs[0] === 'databases' &&
    /^\{.*\}$/.test(segs[1]!) &&
    segs[2] === 'documents'
  ) {
    segs = segs.slice(3)
  }
  return segs
    .filter((seg) => !/^\{.*\}$/.test(seg))
    .map((seg) => seg.toLowerCase())
    .join('/')
}

// A `firestore-collection` InfraNode's `name` is its collection path (F1 names it
// from the code call site). Normalize it the same way as the rules match path so
// the two join, regardless of whether F1 carries wildcard segments verbatim.
function collectionKeyFromName(name: string): string {
  return collectionKeyFromSegments(name.split('/').filter((s) => s.length > 0))
}

// Pull the explicit field-name literals out of a rule condition — the string
// arguments to `keys().hasAll([...])` / `hasOnly([...])` / `hasAny([...])`. These
// are the fields the rules explicitly name; any other condition shape (a function
// call, an `request.auth` check, a comparison) names no field and contributes
// nothing. Field names are lowercased to match `foldColumns`.
function fieldsFromCondition(cond: string): string[] {
  const out: string[] = []
  const callRe = /\b(?:hasAll|hasOnly|hasAny)\s*\(\s*\[([^\]]*)\]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = callRe.exec(cond)) !== null) {
    const inner = m[1]!
    const litRe = /'([^']*)'|"([^"]*)"/g
    let lm: RegExpExecArray | null
    while ((lm = litRe.exec(inner)) !== null) {
      const val = lm[1] ?? lm[2] ?? ''
      if (val.length > 0) out.push(val.toLowerCase())
    }
  }
  return out
}

// Parse a `firestore.rules` file into a map of collection key → the explicit set
// of guarded fields on its write path. Pure over the file content so a test can
// drive it without touching the filesystem, mirroring `prismaColumnsFromSchema`.
//
// A collection appears in the result ONLY when at least one write-family rule
// reduces to an explicit field list AND no write-family rule on the same
// collection is non-reducible. Any condition-based / function-indirected write
// guard poisons the collection to INDETERMINATE — it is omitted, and the check
// stays silent. This is the conservative choice: we opine only where the rules
// give us an explicit set to opine with.
export function parseFirestoreRules(content: string): Map<string, string[]> {
  const src = stripComments(content)

  // One positional scan interleaving, in document order: a `match <path> {`
  // opener (which consumes its own brace), an `allow …;` statement, a bare `{`
  // (a `service {` / `function …() {` block), and a `}` closer. The wildcard
  // `{userId}` inside a match path is matched as part of the path, so it is not
  // mistaken for the block-opening brace.
  const tokenRe = /match\s+((?:\/(?:\{[^}]*\}|[^\s/{}]+))+)\s*\{|allow\b([^;{}]*);|(\{)|(\})/g

  interface Frame {
    depth: number
    segs: string[]
  }
  const matchStack: Frame[] = []
  let depth = 0

  const determinate = new Map<string, Set<string>>()
  const indeterminate = new Set<string>()

  const currentKey = (): string =>
    collectionKeyFromSegments(matchStack.flatMap((f) => f.segs))

  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(src)) !== null) {
    if (m[1] !== undefined) {
      // `match <path> {` — opens a block and consumes its brace.
      depth++
      matchStack.push({ depth, segs: segmentsFromMatchPath(m[1]) })
      continue
    }
    if (m[2] !== undefined) {
      // `allow <methods> [: if <cond>] ;`
      const body = m[2]
      const colon = body.indexOf(':')
      const methodsPart = colon === -1 ? body : body.slice(0, colon)
      const methods = methodsPart
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
      if (!methods.some((mm) => WRITE_METHODS.has(mm))) continue
      const key = currentKey()
      if (key.length === 0) continue
      const cond = colon === -1 ? '' : body.slice(colon + 1)
      const fields = fieldsFromCondition(cond)
      if (fields.length > 0) {
        const set = determinate.get(key) ?? new Set<string>()
        for (const f of fields) set.add(f)
        determinate.set(key, set)
      } else {
        // A write-family rule with no reducible field list — condition-based or
        // function-indirected. Indeterminate.
        indeterminate.add(key)
      }
      continue
    }
    if (m[3] !== undefined) {
      // A bare `{` (a `service {` / `function {` block).
      depth++
      continue
    }
    if (m[4] !== undefined) {
      // A `}` closer. Pop the match frame opened at this depth, if any.
      if (matchStack.length > 0 && matchStack[matchStack.length - 1]!.depth === depth) {
        matchStack.pop()
      }
      depth--
      continue
    }
  }

  const out = new Map<string, string[]>()
  for (const [key, set] of determinate) {
    if (indeterminate.has(key)) continue
    out.set(key, [...set].sort())
  }
  return out
}

// Standalone extract phase (ADR-169). Reads every service's `firestore.rules` and
// folds the parsed `guardedFields` onto the matching `firestore-collection`
// InfraNodes. Adds no nodes or edges — it only enriches existing ones — so it
// contributes nothing to the extract counts. Inert until the F1 recognizer
// (ADR-167) has minted `firestore-collection` nodes; when it hasn't, there is
// nothing to fold onto and this is a no-op. Mutation is allowed here — extract/*
// is a lifecycle authority (lifecycle.md §3).
export async function addFirestoreRules(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  // Merge every service's parsed rules into one collection-key → guarded-fields
  // map. A monorepo can hold a single `firestore.rules` governing collections
  // named across services; folding by collection key keeps the join independent
  // of which service's calls minted the node.
  const guards = new Map<string, Set<string>>()
  for (const service of services) {
    const rulesPath = await findFirst(service.dir, ['firestore.rules'])
    if (!rulesPath) continue
    const content = await readIfExists(rulesPath)
    if (!content) continue
    for (const [key, fields] of parseFirestoreRules(content)) {
      const set = guards.get(key) ?? new Set<string>()
      for (const f of fields) set.add(f)
      guards.set(key, set)
    }
  }
  if (guards.size === 0) return { nodesAdded: 0, edgesAdded: 0 }

  graph.forEachNode((id, attrs) => {
    const node = attrs as GraphNode
    if (node.type !== NodeType.InfraNode) return
    if (node.kind !== FIRESTORE_COLLECTION_KIND) return
    const fields = guards.get(collectionKeyFromName(node.name))
    if (!fields || fields.size === 0) return
    graph.replaceNodeAttributes(id, {
      ...node,
      guardedFields: [...fields].sort(),
    } as InfraNode)
  })

  return { nodesAdded: 0, edgesAdded: 0 }
}

import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import { infraId } from '@neat.is/types'
import { GRAMMAR_BY_EXT, parseSource } from '../symbols.js'
import { snippet, type ExternalEndpoint, type SourceFile } from './shared.js'

// Firestore call sites (ADR-167). The collection-grained analog of
// calls/supabase.ts (`.from('table')`) and calls/mongoose.ts (`.collection(...)`):
// it names the collection a file reads or writes so a Firebase/Next.js app's
// datastore surface — collections, and the fields the code writes — becomes
// first-class in the graph at the same grain as `sql-table` + `ColumnAttr`.
//
//   // modular (firebase/firestore)
//   import { getFirestore, collection, doc, addDoc, setDoc, query, where } from 'firebase/firestore'
//   const db = getFirestore(app)
//   collection(db, 'orders')                        // → collection 'orders'
//   doc(db, 'orders', id)                            // → collection 'orders'
//   collection(doc(db, 'users', id), 'posts')        // → 'users/{}/posts'
//   addDoc(collection(db, 'orders'), { total, status })   // → written fields
//   query(collection(db, 'orders'), where('status', '==', s))  // → read field
//
//   // namespaced / admin (firebase-admin/firestore)
//   import admin from 'firebase-admin'
//   const db = admin.firestore()
//   db.collection('orders').doc(id).set({ total })   // → collection + written field
//   db.collection('orders').where('status', '==', s) // → read field
//
// Firestore has no least-privilege telemetry path (ADR-128 makes its runtime an
// explicit connector non-goal), so its value is EXTRACTED-only. The load-bearing
// distinction for the field-guard policy (ADR-169) is whether a write comes from
// the client SDK (`firebase/firestore`, governed by security rules) or the admin
// SDK (`firebase-admin/firestore`, which bypasses rules entirely) — recorded per
// written field as `sdkWrites`.
//
// Classification is import-aware, the same discipline calls/supabase.ts uses: the
// producer is gated on a firebase import, and `collection(` / `.collection(` are
// only claimed when scoped to a recognized Firestore client var (or an inline
// client factory) — a bare `collection(...)` could be Mongoose's native driver.
// A computed or interpolated path segment is left unclaimed rather than guessed.

const FIRESTORE_CLIENT_IMPORT_RE =
  /(?:from\s+['"`]|require\(\s*['"`])firebase\/firestore['"`]/
const FIRESTORE_ADMIN_IMPORT_RE =
  /(?:from\s+['"`]|require\(\s*['"`])firebase-admin(?:\/firestore)?['"`]/

type SdkWrite = 'client' | 'admin'

function parserForExt(ext: string): Parser {
  const p = new Parser()
  p.setLanguage(GRAMMAR_BY_EXT[ext] ?? JavaScript)
  return p
}

function namedChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = []
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (c) out.push(c)
  }
  return out
}

// The literal text inside a `string` node (quotes stripped). Null for a template /
// interpolated string — never guessed at (identical to drizzle.ts).
function stringLiteralText(node: Parser.SyntaxNode | null): string | null {
  if (!node || node.type !== 'string') return null
  for (const child of namedChildren(node)) {
    if (child.type === 'string_fragment') return child.text
  }
  return '' // an empty '' literal has no string_fragment child
}

function callArgs(call: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const args = call.childForFieldName('arguments')
  return args ? namedChildren(args) : []
}

// A `getFirestore(...)` / `initializeFirestore(...)` call, or an `X.firestore()`
// namespaced/admin client — the factory shapes a Firestore client comes from.
function isFirestoreClientFactory(node: Parser.SyntaxNode | null): boolean {
  if (node?.type !== 'call_expression') return false
  const fn = node.childForFieldName('function')
  if (fn?.type === 'identifier') return fn.text === 'getFirestore' || fn.text === 'initializeFirestore'
  if (fn?.type === 'member_expression') return fn.childForFieldName('property')?.text === 'firestore'
  return false
}

// Variables assigned from a Firestore client factory in this file, e.g.
// `const db = getFirestore(app)` / `const db = admin.firestore()`. We scope the
// `collection(db, …)` and `db.collection(…)` matching to these so an unrelated
// `.collection` (Mongoose's native driver, an array helper) never mints a phantom
// collection — the same scoping calls/supabase.ts applies to `.from()`.
function firestoreClientVars(root: Parser.SyntaxNode): Set<string> {
  const vars = new Set<string>()
  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name')
      let value = node.childForFieldName('value')
      if (value?.type === 'await_expression') value = namedChildren(value)[0] ?? null
      if (name?.type === 'identifier' && isFirestoreClientFactory(value)) {
        vars.add(name.text)
      }
    }
    for (const c of namedChildren(node)) walk(c)
  }
  walk(root)
  return vars
}

function isClientExpr(node: Parser.SyntaxNode | null, clientVars: Set<string>): boolean {
  if (!node) return false
  if (node.type === 'identifier') return clientVars.has(node.text)
  return isFirestoreClientFactory(node)
}

// Resolve a modular `collection(...)` / `doc(...)` call to its ordered Firestore
// path segments, where a collection name is its literal string and a document id
// collapses to '{}' (the path-template placeholder — the collection template is
// the same whatever the doc id). Returns null when the base is not a recognized
// client or any collection-position segment is computed/interpolated: left
// unclaimed, never guessed. Segments alternate collection(0)/doc(1)/collection(2)…
function resolveModular(node: Parser.SyntaxNode, clientVars: Set<string>): string[] | null {
  const fn = node.childForFieldName('function')
  if (fn?.type !== 'identifier' || (fn.text !== 'collection' && fn.text !== 'doc')) return null
  const args = callArgs(node)
  const first = args[0]
  if (!first) return null

  let segs: string[]
  if (first.type === 'call_expression') {
    const base = resolveModular(first, clientVars)
    if (base === null) return null
    segs = [...base]
  } else if (isClientExpr(first, clientVars)) {
    segs = []
  } else {
    return null // first arg is not a firestore client — not our call
  }

  for (let i = 1; i < args.length; i++) {
    const isCollectionPos = segs.length % 2 === 0
    if (isCollectionPos) {
      const lit = stringLiteralText(args[i]!)
      if (lit === null) return null // computed collection name → unclaimed
      segs.push(lit)
    } else {
      segs.push('{}') // a document id — literal or computed alike → placeholder
    }
  }
  return segs
}

// Resolve a namespaced `<client>.collection('x')` / `.doc(id)` chain to its
// ordered path segments, the same segment model as the modular resolver.
function resolveNamespaced(node: Parser.SyntaxNode, clientVars: Set<string>): string[] | null {
  if (node.type !== 'call_expression') return null
  const fn = node.childForFieldName('function')
  if (fn?.type !== 'member_expression') return null
  const prop = fn.childForFieldName('property')?.text
  if (prop !== 'collection' && prop !== 'doc') return null
  const obj = fn.childForFieldName('object')

  let base: string[]
  if (obj?.type === 'call_expression') {
    const inner = resolveNamespaced(obj, clientVars)
    if (inner === null) return null
    base = inner
  } else if (isClientExpr(obj, clientVars)) {
    base = []
  } else {
    return null
  }

  if (prop === 'doc') return [...base, '{}']
  const lit = stringLiteralText(callArgs(node)[0] ?? null)
  if (lit === null) return null // computed collection name → unclaimed
  return [...base, lit]
}

// The collection path a resolved segment list names: a `collection(...)` call
// ends on a collection (odd length), a `doc(...)` call ends on a document — drop
// its trailing id to get the collection it belongs to. Joined with '/'.
function collectionPathOf(node: Parser.SyntaxNode, segs: string[] | null): string | null {
  if (segs === null || segs.length === 0) return null
  const fn = node.childForFieldName('function')
  const prop =
    fn?.type === 'identifier'
      ? fn.text
      : fn?.type === 'member_expression'
        ? fn.childForFieldName('property')?.text
        : null
  const collSegs = prop === 'doc' ? segs.slice(0, -1) : segs
  if (collSegs.length === 0) return null
  return collSegs.join('/')
}

// The collection path any collection/doc reference (modular or namespaced) names.
function collectionPathFromCall(node: Parser.SyntaxNode, clientVars: Set<string>): string | null {
  const modular = resolveModular(node, clientVars)
  if (modular !== null) return collectionPathOf(node, modular)
  const namespaced = resolveNamespaced(node, clientVars)
  if (namespaced !== null) return collectionPathOf(node, namespaced)
  return null
}

// Descend a namespaced query/write receiver chain (`.where().orderBy()`, or a
// bare collection/doc ref) to the collection it targets.
function receiverColl(node: Parser.SyntaxNode | null, clientVars: Set<string>): string | null {
  let cur: Parser.SyntaxNode | null = node
  while (cur?.type === 'call_expression') {
    const fn = cur.childForFieldName('function')
    if (fn?.type !== 'member_expression') return null
    const prop = fn.childForFieldName('property')?.text
    if (prop === 'collection' || prop === 'doc') return collectionPathFromCall(cur, clientVars)
    cur = fn.childForFieldName('object') // skip query methods (where/orderBy/limit/…)
  }
  return null
}

// The collection a modular `query(collRef, …)` reads — arg0 is the collection ref
// or a nested `query(...)`.
function modularQueryColl(node: Parser.SyntaxNode, clientVars: Set<string>): string | null {
  const fn = node.childForFieldName('function')
  if (fn?.type !== 'identifier') return null
  if (fn.text === 'query') {
    const arg0 = callArgs(node)[0]
    return arg0?.type === 'call_expression' ? modularQueryColl(arg0, clientVars) : null
  }
  if (fn.text === 'collection' || fn.text === 'doc') return collectionPathFromCall(node, clientVars)
  return null
}

// A property name, the way drizzle.ts reads it: a bare `status:` or quoted
// `'status':` key, or a `{ status }` shorthand. A computed / spread key is skipped
// (returns null / not a pair) rather than guessed at.
function keyName(key: Parser.SyntaxNode | null): string | null {
  if (!key) return null
  if (key.type === 'property_identifier') return key.text
  if (key.type === 'string') return stringLiteralText(key)
  return null
}

function objectKeys(obj: Parser.SyntaxNode | undefined): string[] {
  if (obj?.type !== 'object') return []
  const out: string[] = []
  for (const child of namedChildren(obj)) {
    if (child.type === 'pair') {
      const k = keyName(child.childForFieldName('key'))
      if (k) out.push(k)
    } else if (child.type === 'shorthand_property_identifier') {
      out.push(child.text)
    }
    // spread_element / computed key → left unclaimed
  }
  return out
}

const MODULAR_WRITES = new Set(['addDoc', 'setDoc', 'updateDoc'])
const NAMESPACED_WRITES = new Set(['add', 'set', 'update'])
const READ_CLAUSES = new Set(['where', 'orderBy'])

export function firestoreEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  const hasClient = FIRESTORE_CLIENT_IMPORT_RE.test(file.content)
  const hasAdmin = FIRESTORE_ADMIN_IMPORT_RE.test(file.content)
  if (!hasClient && !hasAdmin) return []

  // The writing SDK is the file's imported Firestore SDK: a file uses one SDK
  // (`getFirestore` resolves to client under firebase/firestore, admin under
  // firebase-admin/firestore; `admin.firestore()` is admin). When a file imports
  // both — rare — the per-write SDK is genuinely ambiguous, so we leave the tag
  // off (the field still lands as a column); ADR-169 reads `sdkWrites ?? []`, so
  // an untagged write degrades to silence, never a false positive.
  const fileSdk: SdkWrite | null =
    hasClient && !hasAdmin ? 'client' : hasAdmin && !hasClient ? 'admin' : null

  const tree = parseSource(parserForExt(path.extname(file.path)), file.content)
  const clientVars = firestoreClientVars(tree.rootNode)

  const collLine = new Map<string, number>() // path → first evidence line
  const writes = new Map<string, Map<string, Set<SdkWrite>>>() // path → field → sdks
  const reads = new Map<string, Set<string>>() // path → read field names

  const noteColl = (p: string, line: number): void => {
    if (!collLine.has(p)) collLine.set(p, line)
  }
  const noteWrite = (p: string, fields: string[], line: number): void => {
    if (fields.length === 0) return
    noteColl(p, line)
    let byField = writes.get(p)
    if (!byField) {
      byField = new Map()
      writes.set(p, byField)
    }
    for (const f of fields) {
      let sdks = byField.get(f)
      if (!sdks) {
        sdks = new Set()
        byField.set(f, sdks)
      }
      if (fileSdk) sdks.add(fileSdk)
    }
  }
  const noteRead = (p: string, field: string, line: number): void => {
    noteColl(p, line)
    let s = reads.get(p)
    if (!s) {
      s = new Set()
      reads.set(p, s)
    }
    s.add(field)
  }

  const walk = (node: Parser.SyntaxNode): void => {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function')
      const line = node.startPosition.row + 1

      // A collection / doc reference — the collection node itself.
      const collPath = collectionPathFromCall(node, clientVars)
      if (collPath) noteColl(collPath, line)

      if (fn?.type === 'identifier') {
        // Modular write: setDoc(ref, {…}) / updateDoc(ref, {…}) / addDoc(ref, {…}).
        if (MODULAR_WRITES.has(fn.text)) {
          const args = callArgs(node)
          const ref = args[0]
          const p = ref?.type === 'call_expression' ? collectionPathFromCall(ref, clientVars) : null
          if (p) noteWrite(p, objectKeys(args[1]), line)
        }
        // Modular read: query(collRef, where('field', …), orderBy('field')).
        if (fn.text === 'query') {
          const p = modularQueryColl(node, clientVars)
          if (p) {
            for (const arg of callArgs(node)) {
              if (arg.type !== 'call_expression') continue
              const cfn = arg.childForFieldName('function')
              if (cfn?.type === 'identifier' && READ_CLAUSES.has(cfn.text)) {
                const field = stringLiteralText(callArgs(arg)[0] ?? null)
                if (field) noteRead(p, field, arg.startPosition.row + 1)
              }
            }
          }
        }
      } else if (fn?.type === 'member_expression') {
        const prop = fn.childForFieldName('property')?.text
        const receiver = fn.childForFieldName('object')
        // Namespaced write: <ref>.set({…}) / .update({…}) / .add({…}).
        if (prop && NAMESPACED_WRITES.has(prop)) {
          const p = receiverColl(receiver, clientVars)
          if (p) noteWrite(p, objectKeys(callArgs(node)[0]), line)
        }
        // Namespaced read: <ref>.where('field', …) / .orderBy('field').
        if (prop && READ_CLAUSES.has(prop)) {
          const p = receiverColl(receiver, clientVars)
          const field = stringLiteralText(callArgs(node)[0] ?? null)
          if (p && field) noteRead(p, field, line)
        }
      }
    }
    for (const c of namedChildren(node)) walk(c)
  }
  walk(tree.rootNode)

  const out: ExternalEndpoint[] = []
  for (const [collPath, line] of collLine) {
    const byField = writes.get(collPath)
    const readFields = reads.get(collPath)
    // Union of written + read field names → columns (the existing columns fold in
    // calls/index.ts lands these with EXTRACTED provenance).
    const columnSet = new Set<string>()
    if (byField) for (const f of byField.keys()) columnSet.add(f)
    if (readFields) for (const f of readFields) columnSet.add(f)

    // Per-written-field SDK tags → the seam ADR-169 joins on. Only fields with a
    // known writing SDK carry a tag; an ambiguous (both-imports) write is a column
    // with no tag.
    let sdkWrites: Record<string, SdkWrite[]> | undefined
    if (byField) {
      for (const [field, sdks] of byField) {
        if (sdks.size === 0) continue
        if (!sdkWrites) sdkWrites = {}
        sdkWrites[field] = [...sdks].sort()
      }
    }

    out.push({
      infraId: infraId('firestore-collection', collPath),
      name: collPath,
      kind: 'firestore-collection',
      edgeType: 'CALLS',
      // A firebase import is in scope and the call is scoped to a recognized
      // Firestore client — a framework-aware recognizer matched the SDK shape.
      // Verified-call-site tier (ADR-066), the grade calls/supabase.ts emits at.
      confidenceKind: 'verified-call-site',
      ...(columnSet.size > 0 ? { columns: [...columnSet] } : {}),
      ...(sdkWrites ? { sdkWrites } : {}),
      evidence: {
        file: path.relative(serviceDir, file.path),
        line,
        snippet: snippet(file.content, line),
      },
    })
  }
  return out
}

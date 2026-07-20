import path from 'node:path'
import { infraId } from '@neat.is/types'
import { lineOf, snippet, type ExternalEndpoint, type SourceFile } from './shared.js'

// MongoDB collection call sites (ADR-147). The collection-grained analog of
// calls/supabase.ts: it names the collection a file reads or writes so a
// production-observed mongodb operation (ADR-148 mints the OBSERVED side from
// the driver's OTel spans) has a file-grained static twin to fuse onto.
//
//   import mongoose from 'mongoose'
//   const Order = mongoose.model('Order', orderSchema)   // → collection 'orders'
//   const Log   = mongoose.model('Log', s, 'audit_logs') // → collection 'audit_logs'
//
//   import { MongoClient } from 'mongodb'
//   db.collection('orders').insertOne(doc)               // → collection 'orders'
//
// A Mongoose query names a *model* (`Order`), not a collection; the collection
// is derived. The derivation reuses Mongoose's own pluralizer VERBATIM (below)
// because the real collection is named by it — `Goose` → `gooses`, not `geese`
// — so our string matches the one the OBSERVED span carries. Fidelity is the
// fusion key, not a nicety (ADR-147). The native-driver path is exact: the
// collection is the string literal.

const MONGOOSE_IMPORT_RE = /(?:from\s+['"`]|require\(\s*['"`])mongoose['"`]/
const MONGODB_IMPORT_RE = /(?:from\s+['"`]|require\(\s*['"`])mongodb['"`]/

// `mongoose.pluralize(null)` / `pluralize(false)` disables pluralization
// globally — `toCollectionName` then returns the model name unchanged (case
// preserved). Detected per-file; the project-wide flavour is a cross-file
// follow-up (ADR-147).
const PLURALIZE_DISABLED_RE = /\bpluralize\s*\(\s*(?:null|false)\s*\)/

const UNCOUNTABLES = new Set([
  'advice', 'energy', 'excretion', 'digestion', 'cooperation', 'health', 'justice', 'labour',
  'machinery', 'equipment', 'information', 'pollution', 'sewage', 'paper', 'money', 'species',
  'series', 'rain', 'rice', 'fish', 'sheep', 'moose', 'deer', 'news', 'expertise', 'status', 'media',
])

// Ported verbatim from mongoose-legacy-pluralize@2.0.0 (byte-identical to
// mongoose 9.x lib/helpers/pluralize.js). Ordered; the first matching rule
// wins. Do not "correct" the quirks — an English-accurate pluralizer would
// produce names Mongoose never generates and fuse onto nothing.
const PLURALIZE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/human$/gi, 'humans'],
  [/(m)an$/gi, '$1en'],
  [/(pe)rson$/gi, '$1ople'],
  [/(child)$/gi, '$1ren'],
  [/^(ox)$/gi, '$1en'],
  [/(ax|test)is$/gi, '$1es'],
  [/(octop|vir)us$/gi, '$1i'],
  [/(alias|status)$/gi, '$1es'],
  [/(bu)s$/gi, '$1ses'],
  [/(buffal|tomat|potat)o$/gi, '$1oes'],
  [/([ti])um$/gi, '$1a'],
  [/sis$/gi, 'ses'],
  [/(?:([^f])fe|([lr])f)$/gi, '$1$2ves'],
  [/(hive)$/gi, '$1s'],
  [/([^aeiouy]|qu)y$/gi, '$1ies'],
  [/(x|ch|ss|sh)$/gi, '$1es'],
  [/(matr|vert|ind)ix|ex$/gi, '$1ices'],
  [/([m|l])ouse$/gi, '$1ice'],
  [/(kn|w|l)ife$/gi, '$1ives'],
  [/(quiz)$/gi, '$1zes'],
  [/s$/gi, 's'],
  [/([^a-z])$/, '$1'],
  [/$/gi, 's'],
]

// The pluralizer, mirroring the source: lowercase the whole name, short-circuit
// on uncountables, else apply the first matching rule. `.match`/`.replace` are
// used (not `.test`) exactly as the source does, so the `/g` flags carry no
// lastIndex statefulness across calls.
export function pluralizeCollection(name: string): string {
  const str = name.toLowerCase()
  if (UNCOUNTABLES.has(str)) return str
  for (const [re, repl] of PLURALIZE_RULES) {
    if (str.match(re)) return str.replace(re, repl)
  }
  return str
}

// `const s = new Schema({...}, { collection: 'orders_v2' })` — schema vars that
// pin their collection explicitly. Scanned so a `model('Order', s)` using such a
// schema resolves to the pinned name rather than the pluralized model name.
function schemaCollectionVars(content: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:mongoose\s*\.\s*)?Schema\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const windowText = content.slice(m.index, m.index + 2000)
    const opt = /\bcollection\s*:\s*['"`]([\w.-]+)['"`]/.exec(windowText)
    if (opt) out.set(m[1]!, opt[1]!)
  }
  return out
}

interface Resolved {
  name: string
  kind: 'mongodb-collection' | 'mongodb-model'
}

// Resolve a `model('<Name>', <rest>)` call to the collection it targets, in the
// precedence Mongoose itself uses: an explicit third-arg literal, then a schema
// var's `collection` option, then the pluralized model name. A third arg that
// is a bare identifier is a computed collection we can't read — fall back to the
// coarser `mongodb-model` grain rather than guess a name (ADR-147).
function resolveModel(
  modelName: string,
  rest: string,
  schemaColl: Map<string, string>,
  pluralizeOn: boolean,
): Resolved {
  const trimmed = rest.trim()
  const literalThird = /,\s*['"`]([\w.-]+)['"`]\s*$/.exec(trimmed)
  if (literalThird) return { name: literalThird[1]!, kind: 'mongodb-collection' }

  const firstIdent = /^([A-Za-z_$][\w$]*)/.exec(trimmed)?.[1]
  if (firstIdent && schemaColl.has(firstIdent)) {
    return { name: schemaColl.get(firstIdent)!, kind: 'mongodb-collection' }
  }
  if (/,\s*[A-Za-z_$][\w$]*\s*$/.test(trimmed)) {
    return { name: modelName, kind: 'mongodb-model' }
  }
  return { name: pluralizeOn ? pluralizeCollection(modelName) : modelName, kind: 'mongodb-collection' }
}

export function mongooseEndpointsFromFile(file: SourceFile, serviceDir: string): ExternalEndpoint[] {
  const hasMongoose = MONGOOSE_IMPORT_RE.test(file.content)
  const hasMongodb = MONGODB_IMPORT_RE.test(file.content)
  if (!hasMongoose && !hasMongodb) return []

  const content = file.content
  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()

  const emit = (r: Resolved, matchText: string): void => {
    const key = `${r.kind}/${r.name}`
    if (seen.has(key)) return
    seen.add(key)
    const line = lineOf(content, matchText)
    out.push({
      infraId: infraId(r.kind, r.name),
      name: r.name,
      kind: r.kind,
      edgeType: 'CALLS',
      confidenceKind: 'verified-call-site',
      evidence: { file: path.relative(serviceDir, file.path), line, snippet: snippet(content, line) },
    })
  }

  // Mongoose models — `[x.]model('Name'[, schema[, 'coll']])`. `mongoose`
  // required (native-only files never register models).
  if (hasMongoose) {
    const pluralizeOn = !PLURALIZE_DISABLED_RE.test(content)
    const schemaColl = schemaCollectionVars(content)
    const modelRe = /(?:\b\w+\s*\.\s*)?\bmodel\s*\(\s*['"`]([\w$]+)['"`]\s*(?:,\s*([\s\S]{0,300}?))?\)/g
    let m: RegExpExecArray | null
    while ((m = modelRe.exec(content)) !== null) {
      emit(resolveModel(m[1]!, m[2] ?? '', schemaColl, pluralizeOn), m[0])
    }
  }

  // Native driver — `<db>.collection('orders')`. The literal is the collection.
  // `mongoose.connection.collection('x')` is the same shape, so a mongoose-only
  // file reaches this too.
  const collRe = /\.\s*collection\s*\(\s*['"`]([\w.$-]+)['"`]\s*\)/g
  let c: RegExpExecArray | null
  while ((c = collRe.exec(content)) !== null) {
    emit({ name: c[1]!, kind: 'mongodb-collection' }, c[0])
  }

  return out
}

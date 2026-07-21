import path from 'node:path'
import { infraId } from '@neat.is/types'
import { resolveJsImport } from '../imports.js'
import { lineOf, snippet, toPosix, type ExternalEndpoint, type SourceFile } from './shared.js'

// MongoDB collection call sites (ADR-147 in-file, ADR-149 cross-file). The
// collection-grained analog of calls/supabase.ts: it names the collection a file
// reads or writes so a production-observed mongodb operation (ADR-148 mints the
// OBSERVED side from the driver's OTel spans) has a file-grained static twin to
// fuse onto.
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
//
// The model is usually registered in `models/Order.js` and queried across
// `routes/`, `services/` — so `mongooseCrossFileEndpoints` (ADR-149) resolves a
// query binding to its defining file through the import graph imports.ts already
// resolves, and names the collection at the *query* site too.

const MONGOOSE_IMPORT_RE = /(?:from\s+['"`]|require\(\s*['"`])mongoose['"`]/
const MONGODB_IMPORT_RE = /(?:from\s+['"`]|require\(\s*['"`])mongodb['"`]/

// `mongoose.pluralize(null)` / `pluralize(false)` disables pluralization
// globally — `toCollectionName` then returns the model name unchanged (case
// preserved).
const PLURALIZE_DISABLED_RE = /\bpluralize\s*\(\s*(?:null|false)\s*\)/

const UNCOUNTABLES = new Set([
  'advice', 'energy', 'excretion', 'digestion', 'cooperation', 'health', 'justice', 'labour',
  'machinery', 'equipment', 'information', 'pollution', 'sewage', 'paper', 'money', 'species',
  'series', 'rain', 'rice', 'fish', 'sheep', 'moose', 'deer', 'news', 'expertise', 'status', 'media',
])

// Ported verbatim from mongoose-legacy-pluralize@2.0.0 (byte-identical to
// mongoose 9.x lib/helpers/pluralize.js). Ordered; the first matching rule wins.
// Do not "correct" the quirks — an English-accurate pluralizer would produce
// names Mongoose never generates and fuse onto nothing.
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

export function pluralizeCollection(name: string): string {
  const str = name.toLowerCase()
  if (UNCOUNTABLES.has(str)) return str
  for (const [re, repl] of PLURALIZE_RULES) {
    if (str.match(re)) return str.replace(re, repl)
  }
  return str
}

// The Mongoose Model query/write methods (statics + instance) plus the pre-v7
// names still common in older code. A `<binding>.<one-of-these>(` call is a
// collection access. Used cross-file to attribute a query to its collection.
const MODEL_METHODS = [
  'find', 'findOne', 'findById', 'findByIdAndUpdate', 'findByIdAndDelete', 'findOneAndUpdate',
  'findOneAndDelete', 'findOneAndReplace', 'countDocuments', 'estimatedDocumentCount', 'distinct',
  'aggregate', 'exists', 'where', 'populate', 'watch', 'hydrate', 'create', 'insertMany', 'insertOne',
  'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'bulkWrite', 'bulkSave', 'save',
  // pre-v7, removed in current mongoose but present in older codebases:
  'count', 'update', 'remove', 'findOneAndRemove', 'findByIdAndRemove',
]
const MODEL_METHODS_ALT = MODEL_METHODS.join('|')

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

interface ModelDef {
  modelName: string
  varName: string | null // the `const X =` the registration was assigned to, if any
  resolved: Resolved
  matchText: string
}

// Every `[const X = ][obj.]model('Name'[, schema[, 'coll']])` registration in a
// file, with its resolved collection. Shared by the in-file emitter and the
// cross-file registry.
function collectModelDefs(content: string, pluralizeOn: boolean): ModelDef[] {
  const schemaColl = schemaCollectionVars(content)
  const out: ModelDef[] = []
  const re =
    /(?:(?:const|let|var)\s+(\w+)\s*=\s*)?(?:await\s+)?(?:\b\w+\s*\.\s*)?\bmodel\s*\(\s*['"`]([\w$]+)['"`]\s*(?:,\s*([\s\S]{0,300}?))?\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    out.push({
      modelName: m[2]!,
      varName: m[1] ?? null,
      resolved: resolveModel(m[2]!, m[3] ?? '', schemaColl, pluralizeOn),
      matchText: m[0],
    })
  }
  return out
}

function endpoint(
  r: Resolved,
  file: SourceFile,
  serviceDir: string,
  matchText: string,
): ExternalEndpoint {
  const line = lineOf(file.content, matchText)
  return {
    infraId: infraId(r.kind, r.name),
    name: r.name,
    kind: r.kind,
    edgeType: 'CALLS',
    confidenceKind: 'verified-call-site',
    evidence: { file: path.relative(serviceDir, file.path), line, snippet: snippet(file.content, line) },
  }
}

// ── in-file (ADR-147) ──────────────────────────────────────────────────────

export function mongooseEndpointsFromFile(file: SourceFile, serviceDir: string): ExternalEndpoint[] {
  const hasMongoose = MONGOOSE_IMPORT_RE.test(file.content)
  const hasMongodb = MONGODB_IMPORT_RE.test(file.content)
  if (!hasMongoose && !hasMongodb) return []

  const content = file.content
  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()
  const push = (r: Resolved, matchText: string): void => {
    const key = `${r.kind}/${r.name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(endpoint(r, file, serviceDir, matchText))
  }

  if (hasMongoose) {
    const pluralizeOn = !PLURALIZE_DISABLED_RE.test(content)
    for (const def of collectModelDefs(content, pluralizeOn)) push(def.resolved, def.matchText)
  }

  // Native driver — `<db>.collection('orders')`. The literal is the collection.
  const collRe = /\.\s*collection\s*\(\s*['"`]([\w.$-]+)['"`]\s*\)/g
  let c: RegExpExecArray | null
  while ((c = collRe.exec(content)) !== null) {
    push({ name: c[1]!, kind: 'mongodb-collection' }, c[0])
  }

  return out
}

// ── cross-file (ADR-149) ───────────────────────────────────────────────────

// A file's model exports: the collection reachable via each named export, and
// via the default / whole-module export (`module.exports = Order`).
interface FileExports {
  byName: Map<string, string>
  default?: string
}

// A binding imported into a query file. `named` maps a local name to a specific
// export; `default`/`whole`/`namespace` bind the module object itself.
interface ImportBinding {
  local: string
  kind: 'named' | 'default' | 'namespace' | 'whole'
  exportName?: string
  specifier: string
}

function parseDestructure(inner: string, specifier: string, out: ImportBinding[]): void {
  for (const raw of inner.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const asM = /^(\w+)\s+as\s+(\w+)$/.exec(part) // ESM: A as C
    const colonM = /^(\w+)\s*:\s*(\w+)$/.exec(part) // CJS: A: C
    if (asM) out.push({ local: asM[2]!, kind: 'named', exportName: asM[1]!, specifier })
    else if (colonM) out.push({ local: colonM[2]!, kind: 'named', exportName: colonM[1]!, specifier })
    else {
      const id = /^(\w+)$/.exec(part)
      if (id) out.push({ local: id[1]!, kind: 'named', exportName: id[1]!, specifier })
    }
  }
}

function parseImportBindings(content: string): ImportBinding[] {
  const out: ImportBinding[] = []

  const esm = /import\s+([^;'"`\n]+?)\s+from\s*['"`]([^'"`]+)['"`]/g
  let m: RegExpExecArray | null
  while ((m = esm.exec(content)) !== null) {
    const clause = m[1]!.trim()
    const spec = m[2]!
    const ns = /^\*\s+as\s+(\w+)$/.exec(clause)
    if (ns) {
      out.push({ local: ns[1]!, kind: 'namespace', specifier: spec })
      continue
    }
    const named = /\{([^}]*)\}/.exec(clause)
    if (named) parseDestructure(named[1]!, spec, out)
    const def = /^(\w+)\s*(?:,|$)/.exec(clause) // leading default binding, before any `{`
    if (def && !clause.startsWith('{')) out.push({ local: def[1]!, kind: 'default', specifier: spec })
  }

  const cjs = /(?:const|let|var)\s+(\{[^}]*\}|\w+)\s*=\s*require\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  while ((m = cjs.exec(content)) !== null) {
    const lhs = m[1]!
    const spec = m[2]!
    if (lhs.startsWith('{')) parseDestructure(lhs.slice(1, -1), spec, out)
    else out.push({ local: lhs, kind: 'whole', specifier: spec }) // require() default IS module.exports
  }

  return out
}

// A defining file's exports, keyed for both named and default/whole-module
// import. `byName` treats every model var as a possible named export — valid
// source can only import a name it actually exported, so a non-exported var is
// never asked for. The default is the single-model file's model, or the one
// named in `module.exports = X` / `export default X`.
function fileExportsOf(content: string, pluralizeOn: boolean): FileExports | null {
  const defs = collectModelDefs(content, pluralizeOn).filter((d) => d.resolved.kind === 'mongodb-collection')
  if (defs.length === 0) return null

  const byVar = new Map<string, string>()
  for (const d of defs) if (d.varName) byVar.set(d.varName, d.resolved.name)

  const byName = new Map(byVar)
  let def: string | undefined

  const named = /(?:module\.exports|export\s+default)\s*=\s*(\w+)\b/.exec(content)
  if (named && byVar.has(named[1]!)) def = byVar.get(named[1]!)
  if (!def) {
    const inline =
      /(?:module\.exports|export\s+default)\s*=\s*(?:await\s+)?(?:\w+\s*\.\s*)?model\s*\(\s*['"`]([\w$]+)['"`]/.exec(content)
    if (inline) def = pluralizeOn ? pluralizeCollection(inline[1]!) : inline[1]!
  }
  // Single-model file: a default/whole-module import binds to its one model.
  if (!def && byVar.size === 1) def = [...byVar.values()][0]!

  return { byName, ...(def ? { default: def } : {}) }
}

/**
 * Cross-file model→collection resolution (ADR-149). Names the collection at the
 * *query* site — `routes/orders.js` calling `Order.find()` on a model defined in
 * `models/Order.js` — by resolving the imported binding to its defining file
 * through the same import resolution `imports.ts` uses, then attributing the
 * query methods on that binding. Emits onto the same `mongodb-collection` node
 * the in-file and observed paths use, so all three fuse.
 *
 * `files` should be the same masked (comment-stripped) SourceFiles the per-file
 * pass sees. Returns endpoints whose evidence points at the query site.
 */
export async function mongooseCrossFileEndpoints(
  files: SourceFile[],
  serviceDir: string,
): Promise<ExternalEndpoint[]> {
  const mongooseFiles = files.filter((f) => MONGOOSE_IMPORT_RE.test(f.content))
  if (mongooseFiles.length === 0) return []

  // A single `pluralize(null)` anywhere flips derivation for the whole service.
  const pluralizeOn = !files.some((f) => PLURALIZE_DISABLED_RE.test(f.content))

  // Registry: service-relative posix path → its model exports.
  const registry = new Map<string, FileExports>()
  for (const f of mongooseFiles) {
    const fx = fileExportsOf(f.content, pluralizeOn)
    if (fx) registry.set(toPosix(path.relative(serviceDir, f.path)), fx)
  }
  if (registry.size === 0) return []

  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()

  for (const f of files) {
    const bindings = parseImportBindings(f.content)
    if (bindings.length === 0) continue

    // Bindings that ARE a model (named/default import) → `local.method()`.
    const directColl = new Map<string, string>()
    // Whole-module / namespace bindings → `local.Export.method()`.
    const nsExports = new Map<string, FileExports>()

    for (const b of bindings) {
      const resolvedRel = await resolveJsImport(b.specifier, path.dirname(f.path), serviceDir, null)
      if (!resolvedRel) continue
      const fx = registry.get(resolvedRel)
      if (!fx) continue
      if (b.kind === 'named' && b.exportName) {
        const coll = fx.byName.get(b.exportName)
        if (coll) directColl.set(b.local, coll)
      } else if (b.kind === 'default') {
        if (fx.default) directColl.set(b.local, fx.default)
      } else {
        // whole (require) or namespace — could be the model itself or the module object.
        if (fx.default) directColl.set(b.local, fx.default)
        nsExports.set(b.local, fx)
      }
    }
    if (directColl.size === 0 && nsExports.size === 0) continue

    // A binding defined *in this file* is the in-file pass's job — don't double-count.
    const localDefs = new Set(
      collectModelDefs(f.content, pluralizeOn)
        .map((d) => d.varName)
        .filter((v): v is string => v !== null),
    )

    const emit = (collection: string, matchText: string): void => {
      const key = `${f.path}::${collection}`
      if (seen.has(key)) return
      seen.add(key)
      out.push(endpoint({ name: collection, kind: 'mongodb-collection' }, f, serviceDir, matchText))
    }

    for (const [local, collection] of directColl) {
      if (localDefs.has(local)) continue
      const qre = new RegExp(`\\b${local}\\s*\\.\\s*(?:${MODEL_METHODS_ALT})\\s*\\(`, 'g')
      let qm: RegExpExecArray | null
      while ((qm = qre.exec(f.content)) !== null) emit(collection, qm[0])
    }
    for (const [local, fx] of nsExports) {
      const qre = new RegExp(`\\b${local}\\s*\\.\\s*(\\w+)\\s*\\.\\s*(?:${MODEL_METHODS_ALT})\\s*\\(`, 'g')
      let qm: RegExpExecArray | null
      while ((qm = qre.exec(f.content)) !== null) {
        const coll = fx.byName.get(qm[1]!)
        if (coll) emit(coll, qm[0])
      }
    }
  }

  return out
}

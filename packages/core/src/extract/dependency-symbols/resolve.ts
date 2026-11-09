import path from 'node:path'

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

// A relative import inside the package, resolved against the package's own files
// the way resolveJsImport resolves one on disk: the literal path, a `.ts` sibling
// for a `.js` specifier, then each extension, then a directory index. A bare
// specifier is another package and resolves to nothing here.
export function resolveInPackage(files: ReadonlySet<string>, specifier: string, fromRelPath: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelPath), specifier))
  if (base.startsWith('../')) return null
  const ext = path.posix.extname(base)
  const candidates: string[] = []
  if (ext === '.js' || ext === '.jsx') candidates.push(base.slice(0, -ext.length) + (ext === '.jsx' ? '.tsx' : '.ts'))
  if (ext) candidates.push(base)
  for (const e of JS_EXTS) candidates.push(base + e)
  for (const e of JS_EXTS) candidates.push(`${base}/index${e}`)
  return candidates.find((c) => files.has(c)) ?? null
}

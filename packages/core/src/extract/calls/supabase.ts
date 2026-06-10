import path from 'node:path'
import { infraId } from '@neat.is/types'
import { lineOf, snippet, type ExternalEndpoint, type SourceFile } from './shared.js'

// Supabase clients in JS/TS:
//
//   import { createClient } from '@supabase/supabase-js'
//   const supabase = createClient(process.env.SUPABASE_URL, key)
//   const db = createClient('https://abc.supabase.co', key)
//   supabase.from('orders').select()
//   db.auth.getUser()
//
//   import { createServerClient } from '@supabase/ssr'
//   const supabase = createServerClient(url, key, { cookies })
//
// Supabase apps talk to *.supabase.co exclusively through these client
// constructors. The HTTP-call extractor never sees the host: it lives behind
// `createClient`, and in the common case the URL is `process.env.SUPABASE_URL`
// (or `EXPO_PUBLIC_SUPABASE_URL`), not a literal. So a production-observed
// `service → *.supabase.co` CALLS edge arrives with no declared twin and shows
// up as a false `missing-extracted` divergence. This extractor closes that gap.
//
// Classification is import-aware, the same discipline grpc.ts / aws.ts use
// (#238): a bare `createClient(...)` is too common a name to claim without the
// `@supabase/*` import in scope. The constructor names map to the package that
// owns them:
//   - `createClient`                       ← @supabase/supabase-js
//   - `createServerClient` / `createBrowserClient` ← @supabase/ssr
const SUPABASE_JS_IMPORT_RE =
  /(?:from\s+['"`]|require\(\s*['"`])@supabase\/supabase-js['"`]/
const SUPABASE_SSR_IMPORT_RE =
  /(?:from\s+['"`]|require\(\s*['"`])@supabase\/ssr['"`]/

// First argument of a Supabase client constructor. Group 1 is the constructor
// name, group 2 (when present) is a string-literal URL. A non-literal first arg
// (`process.env.SUPABASE_URL`, a config getter) leaves group 2 undefined — we
// still match the construction, we just can't resolve the literal host.
const SUPABASE_CLIENT_RE =
  /\b(createClient|createServerClient|createBrowserClient)\s*\(\s*(?:['"`]([^'"`]*)['"`])?/g

// A *.supabase.co host pulled out of a literal URL argument. We only treat the
// constructor's URL as a resolvable host when the literal actually names a
// supabase.co domain — anything else (a self-hosted Supabase behind a custom
// domain, a placeholder) stays the unresolved env target rather than a guessed
// host. Reading the literal is the only honest host source (file-awareness §6).
function hostFromLiteral(literal: string | undefined): string | null {
  if (!literal) return null
  const m = /^https?:\/\/([^/:'"`\s]+)/.exec(literal.trim())
  if (!m) return null
  const host = m[1]!
  if (!/\.supabase\.(co|in)$/i.test(host)) return null
  return host
}

interface ImportContext {
  hasSupabaseJs: boolean
  hasSupabaseSsr: boolean
}

function readImports(content: string): ImportContext {
  return {
    hasSupabaseJs: SUPABASE_JS_IMPORT_RE.test(content),
    hasSupabaseSsr: SUPABASE_SSR_IMPORT_RE.test(content),
  }
}

// A constructor name is only a Supabase client when the package that owns it is
// imported in the same file. `createClient` needs @supabase/supabase-js;
// `createServerClient` / `createBrowserClient` need @supabase/ssr. Without the
// import in scope we refuse to emit — a bare `createClient` could be anything.
function constructorMatchesImport(name: string, ctx: ImportContext): boolean {
  if (name === 'createClient') return ctx.hasSupabaseJs
  return ctx.hasSupabaseSsr
}

export function supabaseEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  const ctx = readImports(file.content)
  if (!ctx.hasSupabaseJs && !ctx.hasSupabaseSsr) return []

  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()
  SUPABASE_CLIENT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SUPABASE_CLIENT_RE.exec(file.content)) !== null) {
    const ctor = m[1]!
    if (!constructorMatchesImport(ctor, ctx)) continue

    // When the first argument is a literal *.supabase.co URL we resolve the
    // real host. Otherwise the URL is env-driven (`process.env.SUPABASE_URL`,
    // a config getter) and unknowable statically — the edge still has to land,
    // so it resolves to a stable `supabase:env` target. That target is honest:
    // we read the @supabase import and the `createClient` call, but not a host,
    // so we don't fabricate one (file-awareness §6).
    const host = hostFromLiteral(m[2])
    const name = host ?? 'env'
    if (seen.has(name)) continue
    seen.add(name)

    const line = lineOf(file.content, m[0])
    out.push({
      infraId: infraId('supabase', name),
      name,
      kind: 'supabase',
      edgeType: 'CALLS',
      // `createClient(...)` from @supabase/supabase-js (or createServerClient /
      // createBrowserClient from @supabase/ssr) with the import in scope — a
      // framework-aware recognizer matched the SDK shape. Verified-call-site
      // tier (ADR-066), the same grade aws.ts / grpc.ts emit at.
      confidenceKind: 'verified-call-site',
      evidence: {
        file: path.relative(serviceDir, file.path),
        line,
        snippet: snippet(file.content, line),
      },
    })
  }
  return out
}

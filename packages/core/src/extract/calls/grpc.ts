import path from 'node:path'
import { infraId } from '@neat.is/types'
import { lineOf, snippet, type ExternalEndpoint, type SourceFile } from './shared.js'

// Client-construction in JS/TS:
//
//   const client = new orders_proto.OrderService(...)
//   const client = new OrdersClient('orders.internal:50051', ...)
//   const client = new S3Client({ region: 'us-east-1' })
//
// The same `new <Name>Client(...)` shape is used by gRPC client stubs, AWS
// SDK v3 service clients, and a long tail of other SDKs. v0.3.0 mapped every
// `*Client(...)` to `infra:grpc-service:*`, which was true for the demo and
// false for every AWS service medusa imported.
//
// Per ADR-065 / #238, classification is import-aware:
//   1. file imports `@aws-sdk/client-<suffix>` and `<Name>` lowercases to the
//      same alphanumeric tail (`S3Client` ↔ `client-s3`,
//      `CognitoIdentityProviderClient` ↔ `client-cognito-identity-provider`)
//      → kind `aws-<suffix>` (e.g. `infra:aws-s3:S3`).
//   2. file imports `@grpc/grpc-js` or any `*_grpc_pb` generated stub
//      → kind `grpc-service` (the legitimate gRPC path; demo unchanged).
//   3. otherwise → kind `service` (the safe default — accurate but
//      uninformative, the v0.3.0 grpc lie is removed).
const GRPC_CLIENT_RE = /new\s+([A-Z][A-Za-z0-9_]*)Client\s*\(\s*['"`]?([^,'"`)]+)?/g
const AWS_SDK_IMPORT_RE =
  /(?:from\s+['"`]|require\(\s*['"`])@aws-sdk\/client-([a-z0-9-]+)['"`]/g
const GRPC_IMPORT_RE =
  /(?:from\s+['"`]|require\(\s*['"`])@grpc\/grpc-js['"`]|_grpc_pb['"`]/

function isLikelyAddress(value: string | undefined): boolean {
  if (!value) return false
  // Reject code expressions: object literals, anything with whitespace.
  // process.env.X contains dots and would otherwise pass the dot check.
  if (/\s/.test(value) || value.startsWith('{')) return false
  return /:\d{2,5}$/.test(value) || value.includes('.')
}

function normaliseForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

interface ImportContext {
  awsSdkSuffixes: Map<string, string>  // normalised → raw suffix (e.g. 's3' → 's3')
  hasGrpcImport: boolean
}

function readImports(content: string): ImportContext {
  const awsSdkSuffixes = new Map<string, string>()
  AWS_SDK_IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = AWS_SDK_IMPORT_RE.exec(content)) !== null) {
    const raw = m[1]!
    awsSdkSuffixes.set(normaliseForMatch(raw), raw)
  }
  return {
    awsSdkSuffixes,
    hasGrpcImport: GRPC_IMPORT_RE.test(content),
  }
}

function classifyClient(
  symbol: string,
  ctx: ImportContext,
): { kind: string } | null {
  const key = normaliseForMatch(symbol)
  const awsRaw = ctx.awsSdkSuffixes.get(key)
  if (awsRaw) return { kind: `aws-${awsRaw}` }
  if (ctx.hasGrpcImport) return { kind: 'grpc-service' }
  // ADR-065 #5-adjacent — a bare `new <Name>Client()` with no AWS or gRPC
  // import context is ambiguous; could be an in-process client object
  // (`new QueryClient()` from @tanstack/react-query, `new PrismaClient()`,
  // a domain Client class, etc.). Refuse to emit an edge rather than guess
  // a `service` kind that produces false positives. v0.3.3 medusa run had
  // a QueryClient false positive before this guard.
  return null
}

export function grpcEndpointsFromFile(
  file: SourceFile,
  serviceDir: string,
): ExternalEndpoint[] {
  const out: ExternalEndpoint[] = []
  const seen = new Set<string>()
  const ctx = readImports(file.content)
  GRPC_CLIENT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = GRPC_CLIENT_RE.exec(file.content)) !== null) {
    const symbol = m[1]!
    const addr = m[2]?.trim()
    const name = isLikelyAddress(addr) ? addr! : symbol
    if (seen.has(name)) continue
    const classified = classifyClient(symbol, ctx)
    if (!classified) continue
    seen.add(name)
    const { kind } = classified
    const line = lineOf(file.content, m[0])
    out.push({
      infraId: infraId(kind, name),
      name,
      kind,
      edgeType: 'CALLS',
      // `new <Name>Client(...)` with @aws-sdk/* or @grpc/grpc-js import
      // context — import-aware classification per #238. Verified-call-site
      // tier (ADR-066).
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

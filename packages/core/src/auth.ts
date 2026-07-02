/**
 * Delegated auth at the daemon boundary (ADR-073 §3 + §4).
 *
 * NEAT does not issue, rotate, or distribute the token — that is the deploy
 * platform's job. This module provides the two surfaces the daemon needs:
 *
 *   - `assertBindAuthority(host, token)` — fail-loud pre-bind check. When no
 *     token is set, the daemon refuses to bind on any non-loopback address.
 *     Loopback-only without a token stays unauthenticated (laptop dev path).
 *
 *   - `mountBearerAuth(app, opts)` — Fastify `preHandler` that requires
 *     `Authorization: Bearer <token>` on every request other than the
 *     unauthenticated health/readiness probes. Constant-time comparison.
 *
 * The same shape covers both the REST host and the OTLP receivers; the OTLP
 * side passes a different token (`NEAT_OTEL_TOKEN ?? NEAT_AUTH_TOKEN`) so the
 * two surfaces rotate independently.
 */

import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

// Hosts that count as loopback for the bind-authority gate. `0.0.0.0` is
// explicitly not loopback — it binds on every interface, including any
// public one the operator's box happens to have.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '::ffff:127.0.0.1',
])

export function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return false
  return LOOPBACK_HOSTS.has(host)
}

export class BindAuthorityError extends Error {
  constructor(host: string) {
    super(
      `NEAT refuses to bind on a public interface without \`NEAT_AUTH_TOKEN\` set (host="${host}"). Set the token or bind to loopback only.`,
    )
    this.name = 'BindAuthorityError'
  }
}

export function assertBindAuthority(host: string, token: string | undefined): void {
  if (token && token.length > 0) return
  if (isLoopbackHost(host)) return
  throw new BindAuthorityError(host)
}

export interface AuthOptions {
  // Bearer token required on every protected route. Undefined / empty → the
  // middleware is not mounted and the route stays unauthenticated. The
  // loopback-only gate above is what keeps that case from being public.
  token?: string
  // When `true`, trust an upstream reverse proxy and skip the request-side
  // check. The fail-loud bind-authority gate still applies upstream. Wired
  // to `NEAT_AUTH_PROXY=true` in production.
  trustProxy?: boolean
  // ADR-073 §3 amendment — public-read mode for reference deployments.
  // When `true`, GET / HEAD / OPTIONS pass through without a bearer; every
  // other verb still requires the token. OTLP ingest is excluded — that
  // surface stays gated unconditionally (the receiver mounts its own
  // middleware without this flag).
  publicRead?: boolean
  // Extra paths (or path suffixes) to leave unauthenticated. Used by tests
  // and by ad-hoc callers that mount their own probes.
  extraUnauthenticatedSuffixes?: ReadonlyArray<string>
  // Diagnostic hook fired whenever a request is rejected with 401 for a
  // missing or invalid bearer. The REST host leaves this unset — a human
  // running `curl` doesn't need a server-side line for their own 401. The
  // OTLP receiver passes it so an app whose telemetry is being dropped for a
  // bad token leaves a signal on the daemon side instead of failing silently.
  // The hook does not change the response body or status; it only observes.
  onReject?: () => void
}

// Verbs the public-read split treats as reads. Everything else is a write
// and keeps the bearer requirement.
const PUBLIC_READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

// Probes that always stay open. Dual-mounted under `/projects/:project/` too,
// so the check is a suffix match — `/projects/foo/health` is skipped along
// with the top-level `/health`. ADR-073 §3 names `/healthz` and `/readyz`
// explicitly; `/health` is the existing endpoint the web shell and CI smoke
// already lean on, so it keeps the unauthenticated treatment. `/api/config`
// is the public-read negotiation endpoint — the web shell hits it before any
// authed call to learn which mode the daemon is running in.
const DEFAULT_UNAUTH_SUFFIXES: ReadonlyArray<string> = [
  '/health',
  '/healthz',
  '/readyz',
  '/api/config',
]

export function mountBearerAuth(app: FastifyInstance, opts: AuthOptions): void {
  if (!opts.token || opts.token.length === 0) return
  if (opts.trustProxy) return

  const expected = Buffer.from(opts.token, 'utf8')
  const suffixes = [...DEFAULT_UNAUTH_SUFFIXES, ...(opts.extraUnauthenticatedSuffixes ?? [])]
  const publicRead = opts.publicRead === true

  app.addHook('preHandler', (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    const path = (req.url.split('?')[0] ?? '').replace(/\/+$/, '')
    for (const suffix of suffixes) {
      if (path === suffix || path.endsWith(suffix)) {
        done()
        return
      }
    }

    // Public-read split: GET / HEAD / OPTIONS pass through anonymously, every
    // other verb keeps the bearer check. The token still authorizes writes,
    // and the bind-authority gate above still demands a token for non-loopback
    // binds — public-read enables anonymous reads on top of that, it doesn't
    // replace either invariant.
    if (publicRead && PUBLIC_READ_METHODS.has(req.method)) {
      done()
      return
    }

    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      opts.onReject?.()
      void reply.code(401).send({ error: 'unauthorized' })
      return
    }
    const provided = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8')
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      opts.onReject?.()
      void reply.code(401).send({ error: 'unauthorized' })
      return
    }
    done()
  })
}

// Read both tokens from the environment in one place so server.ts, daemon.ts,
// and the OTel receivers all agree on precedence (ADR-073 §4). `publicRead`
// rides the same shape so callers don't need a second env read.
export interface AuthEnv {
  authToken: string | undefined
  otelToken: string | undefined
  trustProxy: boolean
  publicRead: boolean
}

function parseBoolEnv(v: string | undefined): boolean {
  if (!v) return false
  return v === 'true' || v === '1'
}

export function readAuthEnv(env: NodeJS.ProcessEnv = process.env): AuthEnv {
  const t = env.NEAT_AUTH_TOKEN
  const ot = env.NEAT_OTEL_TOKEN
  return {
    authToken: t && t.length > 0 ? t : undefined,
    otelToken: ot && ot.length > 0 ? ot : t && t.length > 0 ? t : undefined,
    trustProxy: env.NEAT_AUTH_PROXY === 'true',
    publicRead: parseBoolEnv(env.NEAT_PUBLIC_READ),
  }
}

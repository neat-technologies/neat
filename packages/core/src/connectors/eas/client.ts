// The Expo GraphQL client — the fetch half of the EAS connector's poll()
// (ADR-185, docs/plans/eas-build-connector-plan.md). Passive and ambient only
// (connectors.md §2): one read-only `builds` query per page, never a mutation,
// never a synthetic build.
//
// The Expo public GraphQL API (`POST https://api.expo.dev/graphql`) is
// undocumented and unversioned. The query below is PINNED and reconstructed from
// `expo/eas-cli`'s generated schema — deliberately NOT a shell to
// `eas build:view --json`, whose own `BuildFragment` omits `error.buildPhase`
// (the strict-enum classifier this connector needs) and selects a deprecated
// logs field. A schema/shape error surfaces as a thrown connector error (the
// drift signal §8's status tracker records), never a silent drop of builds.

import { bearerAuthHeader, junctionFetch } from '../junction.js'
import type { EasBuild, EasConnectorConfig } from './types.js'
import { EAS_STATUS_ERRORED } from './types.js'

export const DEFAULT_EAS_API_URL = 'https://api.expo.dev/graphql'
export const DEFAULT_PAGE_SIZE = 50
// Defensive cap on offset pagination — bounds the loop rather than trusting an
// unbounded while(true), the same discipline cloud-run/client.ts's MAX_PAGES and
// the trace-stitch BFS depth cap hold. Build failures are low-frequency, so a few
// pages of newest-first covers any realistic poll window.
export const DEFAULT_MAX_PAGES = 10
// Stored log slice cap. Xcode logs reach ~10MB; a 16KB tail is enough to carry
// the failure reason (which sits at the end of a build log) to an agent.
export const DEFAULT_MAX_LOG_BYTES = 16 * 1024
export const DEFAULT_MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

interface EasGraphQLError {
  message: string
}

interface EasGraphQLResponse<T> {
  data?: T
  errors?: EasGraphQLError[]
}

// The PINNED query. `app.byId(appId:)` scopes to one Expo app; `builds` is
// offset-paginated, newest-first, server-filtered to `status: ERRORED`; the
// selection set names exactly the fields types.ts reads — including
// `error { buildPhase errorCode message docsUrl }`, the fragment the CLI omits.
const BUILDS_QUERY = `
  query NeatEasErroredBuilds($appId: String!, $offset: Int!, $limit: Int!) {
    app {
      byId(appId: $appId) {
        builds(offset: $offset, limit: $limit, filter: { status: ERRORED }) {
          id
          status
          platform
          buildProfile
          gitCommitHash
          gitCommitMessage
          gitRef
          isGitWorkingTreeDirty
          createdAt
          completedAt
          error {
            buildPhase
            errorCode
            message
            docsUrl
          }
          logFileUrls
        }
      }
    }
  }
`

interface BuildsQueryData {
  app?: {
    byId?: {
      builds?: EasBuild[]
    }
  }
}

async function easGraphQL<T>(
  apiUrl: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  accountKey: string,
  fetchImpl?: typeof fetch,
): Promise<T> {
  const res = await junctionFetch(
    apiUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...bearerAuthHeader(token),
      },
      body: JSON.stringify({ query, variables }),
    },
    // accountKey: the Expo app id — the per-(provider, accountKey) rate-limit
    // bucket (ADR-131), the closest thing this connector carries to "one account".
    { provider: 'eas', accountKey, ...(fetchImpl ? { fetchImpl } : {}) },
  )
  if (!res.ok) {
    throw new Error(`Expo GraphQL request failed: ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as EasGraphQLResponse<T>
  // Drift is loud (connectors.md §10, guardrail 3): a GraphQL-level error (a
  // renamed field, a changed filter arg) throws here rather than being read as
  // "no builds".
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Expo GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`)
  }
  if (!body.data) throw new Error('Expo GraphQL response carried no data')
  return body.data
}

/**
 * Pull the app's `ERRORED` builds, newest-first, paginated by offset and deduped
 * by `id` across pages (offset pagination can shift when a build is created
 * mid-page). The mapper never trusts the server filter alone (§4) — this also
 * drops any row whose `status` isn't `ERRORED`, in case the filter arg drifts.
 */
export async function fetchErroredBuilds(
  token: string,
  config: EasConnectorConfig,
  fetchImpl?: typeof fetch,
): Promise<EasBuild[]> {
  const apiUrl = config.apiUrl ?? DEFAULT_EAS_API_URL
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES
  const out: EasBuild[] = []
  const seen = new Set<string>()
  for (let page = 0; page < maxPages; page++) {
    const data = await easGraphQL<BuildsQueryData>(
      apiUrl,
      token,
      BUILDS_QUERY,
      { appId: config.appId, offset: page * pageSize, limit: pageSize },
      config.appId,
      fetchImpl,
    )
    const builds = data.app?.byId?.builds
    // A well-formed page carries an array (absent when the window is empty); a
    // shape drift handing back a non-array drops honestly rather than throwing on
    // a spread of a non-iterable (connectors.md §4).
    if (!Array.isArray(builds)) break
    let added = 0
    for (const b of builds) {
      if (!b || typeof b.id !== 'string' || b.id.length === 0) continue
      if (b.status !== EAS_STATUS_ERRORED) continue
      if (seen.has(b.id)) continue
      seen.add(b.id)
      out.push(b)
      added++
    }
    // A short page is the last page.
    if (builds.length < pageSize) break
    // A full page that contributed nothing new (all duplicates / all non-ERRORED)
    // won't get better deeper — stop rather than page to the cap.
    if (added === 0) break
  }
  return out
}

/**
 * Fetch a build's logs and keep a bounded tail. The signed `logFileUrls` are
 * time-limited, so this runs on the poll (never later) and stores a size-capped
 * slice — the failure reason sits at the end of a build log, so the TAIL is
 * kept. A URL that fails to fetch is skipped honestly rather than failing the
 * whole poll (a log is context, not the incident itself).
 */
export async function fetchBuildLogs(
  logFileUrls: string[] | null | undefined,
  maxBytes: number = DEFAULT_MAX_LOG_BYTES,
  fetchImpl?: typeof fetch,
): Promise<string> {
  if (!Array.isArray(logFileUrls) || logFileUrls.length === 0) return ''
  const doFetch = fetchImpl ?? fetch
  const chunks: string[] = []
  for (const url of logFileUrls) {
    if (typeof url !== 'string' || url.length === 0) continue
    try {
      const res = await doFetch(url)
      if (!res.ok) continue
      chunks.push(await res.text())
    } catch {
      // A time-expired or unreachable log URL is an honest miss, not a poll
      // failure — the incident still carries the phase, commit, and message.
    }
  }
  const joined = chunks.join('\n')
  return joined.length > maxBytes ? joined.slice(joined.length - maxBytes) : joined
}

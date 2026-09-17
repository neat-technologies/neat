import { describe, it, expect } from 'vitest'
import type { ProjectListEntry } from '@neat.is/types'
import { resolveRemoteProjectName } from '../src/cli-client.js'

// docs/contracts/cli-surface.md §"Profiles and remote mode" + client-profiles.md
// §5 — `neat sync --to <url>` resolves the target project from the daemon, not
// from the local directory name. A hosted tenant daemon serves exactly
// one project and marks it `hostedHere: true` in GET /projects; the snapshot
// must land under that name so a repo whose local name differs still syncs. The
// resolution is conservative: any failure to find a hostedHere entry falls back
// to the caller's local name so local/self-host sync never regresses.
//
// These unit tests drive GET /projects through an injected fetch stub, the same
// way the login-sso tests inject fetch.

const LOCAL = 'local-repo-name'

// Minimal ProjectListEntry — the resolver only reads `name` and `hostedHere`.
function entry(name: string, hostedHere: boolean): ProjectListEntry {
  return {
    name,
    path: `/tmp/${name}`,
    registeredAt: new Date().toISOString(),
    languages: [],
    status: 'active',
    hostedHere,
  }
}

// A fetch stub that answers GET /projects with `body` at `status`.
function projectsFetch(status: number, body: unknown): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).endsWith('/projects')) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

describe('resolveRemoteProjectName', () => {
  it('resolves the sole hostedHere project even when the local name differs', async () => {
    const fetchImpl = projectsFetch(200, [
      entry('some-other-project', false),
      entry('looptest', true),
    ])
    const name = await resolveRemoteProjectName(
      { baseUrl: 'https://daemon.example', token: 'dtok', fallback: LOCAL },
      fetchImpl,
    )
    expect(name).toBe('looptest')
  })

  it('falls back to the local name when no entry is hostedHere', async () => {
    const fetchImpl = projectsFetch(200, [entry('a', false), entry('b', false)])
    const name = await resolveRemoteProjectName(
      { baseUrl: 'https://daemon.example', token: 'dtok', fallback: LOCAL },
      fetchImpl,
    )
    expect(name).toBe(LOCAL)
  })

  it('falls back to the local name when GET /projects errors', async () => {
    const fetchImpl = projectsFetch(500, { error: 'boom' })
    const name = await resolveRemoteProjectName(
      { baseUrl: 'https://daemon.example', token: 'dtok', fallback: LOCAL },
      fetchImpl,
    )
    expect(name).toBe(LOCAL)
  })

  it('falls back to the local name when the daemon is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const name = await resolveRemoteProjectName(
      { baseUrl: 'https://daemon.example', token: 'dtok', fallback: LOCAL },
      fetchImpl,
    )
    expect(name).toBe(LOCAL)
  })
})

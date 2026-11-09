import type { ConnectorStatusEntry } from '@neat.is/types'

// What a running daemon says about its project's connectors, reduced to the
// ones that aren't working (Newdryve #5). `neat up` and `neat doctor` both read
// it, so a connector the daemon skipped or can't poll shows in the command's
// own output, not only in neat-out/daemon.log. Reads GET /connectors, the same
// view the web GUI uses; never the config file, so it reports what the daemon
// actually did.

export interface ConnectorHealth {
  total: number
  problems: Array<{ id: string; provider: string; line: string }>
}

const TIMEOUT_MS = 3000

function describe(entry: ConnectorStatusEntry): string | undefined {
  const s = entry.status
  const head = `connector "${entry.id}" (${entry.provider})`
  if (s.state === 'error') {
    // A skipped connector never polled; its lastError already says "not polling — …".
    return s.lastPollAt === null ? `${head} is ${s.lastError ?? 'not polling'}` : `${head}: last poll failed — ${s.lastError ?? 'unknown error'}`
  }
  if (s.state === 'stale') return `${head} hasn't polled successfully since ${s.lastPollAt ?? 'it started'}`
  return undefined
}

/**
 * The project's connectors and the ones that aren't working, or undefined when
 * the daemon can't be asked (down, an older daemon without the route).
 */
export async function readConnectorHealth(
  baseUrl: string,
  project: string,
  opts: { fetchImpl?: typeof fetch; token?: string } = {},
): Promise<ConnectorHealth | undefined> {
  const f = opts.fetchImpl ?? fetch
  try {
    const res = await f(`${baseUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(project)}/connectors`, {
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { connectors?: ConnectorStatusEntry[] }
    const connectors = body.connectors ?? []
    const problems = connectors.flatMap((c) => {
      const line = describe(c)
      return line ? [{ id: c.id, provider: c.provider, line }] : []
    })
    return { total: connectors.length, problems }
  } catch {
    return undefined
  }
}

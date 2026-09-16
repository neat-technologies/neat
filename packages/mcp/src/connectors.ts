// Hosted connector tools (ADR-228). Unlike every other MCP tool — which reads the
// project daemon's graph over REST — these four call the hosted CONTROL PLANE to
// manage provider connections for the agent's hosted project. They write connection
// state (seal a provider credential, drop it), never the graph, so the read-only-
// graph invariant holds. The credential rides in as a tool argument, is sent only in
// the POST body, and is never logged or echoed back (the control plane returns a
// redacted view). Config comes from the environment today (NEAT_CP_URL / NEAT_API_KEY
// / NEAT_CP_PROJECT_ID); the durable source is the login-written profile, sourced
// through resolveCpTarget as a follow-on that keeps env as the override (ADR-228 §5).

import { HttpError, type HttpClient } from './client.js'
import { formatErrorResponse, formatToolResponse, type ToolResponse } from './format.js'

// The non-secret control-plane shapes these tools read (INFRA-ADR-009/010). Kept
// minimal — only the fields surfaced to the agent.
interface ConnectableResponse {
  connectable: string[]
}
interface ConnectionListItem {
  provider: string
  status: string
  accountLabel?: string
  connectedAt?: string
  lastSyncAt?: string
}
interface ConnectionView {
  provider: string
  subject?: string
  scopes?: string[]
}
interface DisconnectResult {
  removed: number
}
interface MeProjects {
  projects?: { id: string; name?: string }[]
}

const NOT_CONFIGURED =
  "Hosted connectors aren't configured for this MCP server. Set NEAT_CP_URL and NEAT_API_KEY " +
  '(a neat_pat_ minted by `neat login` / app.neat.is) to connect providers headlessly.'

// Thrown by project resolution when it can't pick a single hosted project. Carried
// back to the agent as guidance, not an error.
class ConnectorConfigError extends Error {}

export interface ConnectorDeps {
  /** HTTP client bound to NEAT_CP_URL + the durable neat_pat_ (NEAT_API_KEY). */
  cp: HttpClient
  /** Resolve the hosted project id — NEAT_CP_PROJECT_ID, else the sole /me project. Memoized. */
  resolveProjectId: () => Promise<string>
}

/**
 * Bundle a CP client with a memoized project resolver. The resolver prefers an
 * explicit NEAT_CP_PROJECT_ID; unset, it reads the account's projects from /me and
 * uses the sole one, refusing to guess when the account has several.
 */
export function createConnectorDeps(cp: HttpClient, explicitProjectId: string | undefined): ConnectorDeps {
  let cached: string | undefined = explicitProjectId?.trim() || undefined
  return {
    cp,
    async resolveProjectId(): Promise<string> {
      if (cached) return cached
      const me = await cp.get<MeProjects>('/me')
      const projects = me.projects ?? []
      if (projects.length === 1 && projects[0]) {
        cached = projects[0].id
        return cached
      }
      if (projects.length === 0) {
        throw new ConnectorConfigError('No hosted project on this account — create one at app.neat.is, then retry.')
      }
      throw new ConnectorConfigError(
        `This account has ${projects.length} projects — set NEAT_CP_PROJECT_ID to the one whose connectors you want to manage.`,
      )
    },
  }
}

export async function neatListConnectable(deps: ConnectorDeps | null): Promise<ToolResponse> {
  if (!deps) return formatToolResponse({ summary: NOT_CONFIGURED })
  try {
    const { connectable } = await deps.cp.get<ConnectableResponse>('/me/connectable')
    if (connectable.length === 0) {
      return formatToolResponse({ summary: 'No providers are connectable on this control plane yet.' })
    }
    return formatToolResponse({
      summary: `${connectable.length} provider${connectable.length === 1 ? '' : 's'} can be connected: ${connectable.join(', ')}.`,
      block: connectable.map((p) => `- ${p}`).join('\n'),
    })
  } catch (err) {
    return cpError(err)
  }
}

export interface ConnectInput {
  provider: string
  credential: string
}

export async function neatConnect(deps: ConnectorDeps | null, input: ConnectInput): Promise<ToolResponse> {
  if (!deps) return formatToolResponse({ summary: NOT_CONFIGURED })
  const provider = input.provider.trim()
  const credential = input.credential.trim()
  if (!provider) return formatErrorResponse('provider is required')
  if (!credential) return formatErrorResponse('credential is required — paste the provider token to connect')
  try {
    const projectId = await deps.resolveProjectId()
    const view = await cpPost<ConnectionView>(
      deps.cp,
      `/me/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(provider)}`,
      { credential },
    )
    const who = view.subject ? ` as ${view.subject}` : ''
    return formatToolResponse({
      summary: `Connected ${provider}${who} — the credential is verified and sealed on the control plane. Check neat_connection_status for sync state as NEAT pulls it into the project graph.`,
      ...(view.scopes?.length ? { block: `scopes: ${view.scopes.join(', ')}` } : {}),
    })
  } catch (err) {
    return cpError(err, provider)
  }
}

export async function neatConnectionStatus(deps: ConnectorDeps | null): Promise<ToolResponse> {
  if (!deps) return formatToolResponse({ summary: NOT_CONFIGURED })
  try {
    const projectId = await deps.resolveProjectId()
    const conns = await deps.cp.get<ConnectionListItem[]>(
      `/me/projects/${encodeURIComponent(projectId)}/connections`,
    )
    if (conns.length === 0) {
      return formatToolResponse({
        summary: 'No providers are connected to this project yet. Use neat_connect to add one.',
      })
    }
    const block = conns
      .map((c) => {
        const label = c.accountLabel ? ` (${c.accountLabel})` : ''
        const synced = c.lastSyncAt ? `, last sync ${c.lastSyncAt}` : ''
        return `- ${c.provider}${label}: ${c.status}${synced}`
      })
      .join('\n')
    return formatToolResponse({
      summary: `${conns.length} provider${conns.length === 1 ? '' : 's'} connected to this project.`,
      block,
    })
  } catch (err) {
    return cpError(err)
  }
}

export interface DisconnectInput {
  provider: string
}

export async function neatDisconnect(deps: ConnectorDeps | null, input: DisconnectInput): Promise<ToolResponse> {
  if (!deps) return formatToolResponse({ summary: NOT_CONFIGURED })
  const provider = input.provider.trim()
  if (!provider) return formatErrorResponse('provider is required')
  try {
    const projectId = await deps.resolveProjectId()
    const { removed } = await cpDel<DisconnectResult>(
      deps.cp,
      `/me/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(provider)}`,
    )
    if (removed === 0) {
      return formatToolResponse({
        summary: `No ${provider} connection was found on this project — nothing to disconnect.`,
      })
    }
    return formatToolResponse({
      summary: `Disconnected ${provider} (${removed} connection${removed === 1 ? '' : 's'} removed).`,
    })
  } catch (err) {
    return cpError(err, provider)
  }
}

// The base HttpClient interface leaves post/del optional so test stubs can skip
// them; the client createHttpClient builds always provides both.
function cpPost<T>(cp: HttpClient, path: string, body: unknown): Promise<T> {
  if (!cp.post) throw new Error('CP client does not support POST')
  return cp.post<T>(path, body)
}
function cpDel<T>(cp: HttpClient, path: string): Promise<T> {
  if (!cp.del) throw new Error('CP client does not support DELETE')
  return cp.del<T>(path)
}

// Map a control-plane failure to a plain-language tool response. A resolution
// problem is guidance (not isError); an HTTP failure surfaces its status + detail.
function cpError(err: unknown, context?: string): ToolResponse {
  if (err instanceof ConnectorConfigError) {
    return formatToolResponse({ summary: err.message })
  }
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return formatErrorResponse(
        'The control plane rejected the request (401). Either NEAT_API_KEY is not a valid neat_pat_, ' +
          `or the provider rejected the pasted credential. Detail: ${err.message}`,
      )
    }
    if (err.status === 501) {
      return formatErrorResponse(
        `${context ?? 'That provider'} is not connectable yet (501) — no driver is wired for it on the control plane.`,
      )
    }
    return formatErrorResponse(`Control plane error (${err.status}): ${err.message}`)
  }
  return formatErrorResponse(`Error talking to the control plane: ${(err as Error).message}`)
}

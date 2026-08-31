// The Kubernetes API client — the fetch half of the connector's poll() (ADR-224).
// Passive and ambient only (connectors.md §2): read-only `GET` list calls on
// Deployments and Pods in one namespace, never a mutation, never a synthetic
// workload. Mirrors the fetch/map/resolve split every provider module keeps.
//
// The k8s API server usually presents a cluster-CA-signed cert (or, for a local
// cluster, a self-signed one), and kind-style access authenticates with a client
// cert — neither of which the platform `fetch` handles from a PEM string. So the
// outbound call uses a Node `https` agent (native `ca`/`cert`/`key` support)
// wrapped as a `fetchImpl`, and still routes through the shared junction for the
// per-call timeout/retry/rate-limit discipline every connector holds (ADR-131).
// No k8s SDK and no new dependency.
//
// Endpoint paths are the stable Kubernetes REST API (apps/v1 Deployments, core/v1
// Pods), confirmed against the API reference (ADR-150/152 discipline).

import { Agent, request as httpsRequest } from 'node:https'
import { bearerAuthHeader, junctionFetch } from '../junction.js'
import type { ResolvedK8sTransport } from './kubeconfig.js'
import type { Deployment, K8sList, Pod } from './types.js'

// One namespace's list endpoints.
export function deploymentsPath(namespace: string): string {
  return `/apis/apps/v1/namespaces/${namespace}/deployments`
}
export function podsPath(namespace: string): string {
  return `/api/v1/namespaces/${namespace}/pods`
}

// A `fetch`-shaped adapter over Node `https`, so the request carries the cluster
// CA / client cert the k8s API needs. It honours `init.method`, `init.headers`,
// and the junction's `init.signal` (abort on the per-attempt timeout), and hands
// back the minimal `Response` surface junctionFetch reads (`ok`/`status`/
// `statusText`/`json`). Built per transport (its TLS material never changes over
// the connector's life), reused across list calls.
export function makeK8sFetchImpl(transport: ResolvedK8sTransport): typeof fetch {
  const agent = new Agent({
    ...(transport.ca ? { ca: transport.ca } : {}),
    ...(transport.clientCert ? { cert: transport.clientCert } : {}),
    ...(transport.clientKey ? { key: transport.clientKey } : {}),
    rejectUnauthorized: !transport.insecureSkipTlsVerify,
  })
  return ((url: string | URL, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(String(url))
      const req = httpsRequest(
        u,
        {
          method: (init?.method ?? 'GET').toUpperCase(),
          headers: (init?.headers as Record<string, string>) ?? {},
          agent,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8')
            const status = res.statusCode ?? 0
            resolve({
              ok: status >= 200 && status < 300,
              status,
              statusText: res.statusMessage ?? '',
              json: async () => JSON.parse(body),
              text: async () => body,
            } as Response)
          })
        },
      )
      req.on('error', reject)
      // The junction sets an AbortController signal per attempt for its timeout;
      // destroying the request surfaces as the same rejected fetch it expects.
      const signal = init?.signal
      if (signal) {
        if (signal.aborted) req.destroy(new Error('aborted'))
        else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
      }
      req.end()
    })) as unknown as typeof fetch
}

// One authenticated GET of a namespaced list, through the junction. `fetchImpl`
// is the test seam (a stub k8s API); production builds the https adapter from the
// transport. `apiUrl` overrides the server base for a test/proxy in front.
async function listResource<T>(
  transport: ResolvedK8sTransport,
  namespace: string,
  path: string,
  opts: { apiUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<T[]> {
  const base = opts.apiUrl ?? transport.server
  const url = `${base.replace(/\/$/, '')}${path}`
  const fetchImpl = opts.fetchImpl ?? makeK8sFetchImpl(transport)
  const res = await junctionFetch(
    url,
    { method: 'GET', headers: { ...(transport.token ? bearerAuthHeader(transport.token) : {}), Accept: 'application/json' } },
    // accountKey: the (cluster, namespace) pair — an identifier, safe to log, the
    // rate-limit bucket for one namespace on one cluster (ADR-131).
    { provider: 'kubernetes', accountKey: `${safeHost(transport.server)}/${namespace}`, fetchImpl },
  )
  if (!res.ok) {
    throw new Error(`kubernetes ${path} failed: ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as K8sList<T>
  // A well-formed list carries an array; a shape drift handing back a non-array
  // `items` drops honestly rather than throwing (connectors.md §4).
  return Array.isArray(json.items) ? json.items : []
}

function safeHost(server: string): string {
  try {
    return new URL(server).host
  } catch {
    return 'cluster'
  }
}

export async function fetchDeployments(
  transport: ResolvedK8sTransport,
  namespace: string,
  opts: { apiUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<Deployment[]> {
  return listResource<Deployment>(transport, namespace, deploymentsPath(namespace), opts)
}

export async function fetchPods(
  transport: ResolvedK8sTransport,
  namespace: string,
  opts: { apiUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<Pod[]> {
  return listResource<Pod>(transport, namespace, podsPath(namespace), opts)
}

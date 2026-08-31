// Kubeconfig → transport resolution (ADR-224). The k8s connector accepts the
// same access `kubectl` has: a kubeconfig's current context supplies the API
// server, the cluster CA, and the auth (a bearer token, or a client cert/key —
// kind's default). Parsed with the `yaml` dep already in the tree; no k8s SDK.
//
// This never logs or echoes the secret material (a token, a client key); it
// reads it into the in-memory transport that `client.ts` hands to the TLS agent,
// and nowhere else (connectors.md §6).

import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { K8sConnectorConfig, K8sCredentials } from './types.js'

/** The resolved connection — what `client.ts` needs to make an authenticated read. */
export interface ResolvedK8sTransport {
  server: string
  ca?: string
  token?: string
  clientCert?: string
  clientKey?: string
  insecureSkipTlsVerify: boolean
}

interface KubeconfigNamed<T> {
  name?: string
  cluster?: T
  context?: T
  user?: T
}

// A base64 `*-data` field decodes to PEM; a path field (`certificate-authority`,
// `client-certificate`, `client-key`) is read from disk. Absent → undefined.
function pemFrom(dataField: unknown, pathField: unknown): string | undefined {
  if (typeof dataField === 'string' && dataField.length > 0) {
    return Buffer.from(dataField, 'base64').toString('utf8')
  }
  if (typeof pathField === 'string' && pathField.length > 0) {
    return readFileSync(pathField, 'utf8')
  }
  return undefined
}

function named<T>(list: unknown, name: string): T | undefined {
  if (!Array.isArray(list)) return undefined
  const hit = (list as Array<KubeconfigNamed<Record<string, unknown>>>).find((e) => e && e.name === name)
  return hit as T | undefined
}

/**
 * Resolve a kubeconfig (an absolute path, or the YAML itself) to a transport,
 * using its `current-context`. Throws a clear, secret-free error when the config
 * is malformed or names a context/cluster/user it doesn't define.
 */
export function parseKubeconfig(kubeconfig: string): ResolvedK8sTransport {
  // A path (no newline, starts with / or ~ or a drive) is read; anything with
  // YAML structure is parsed inline. The cheap discriminator: inline kubeconfig
  // always contains `apiVersion`/`clusters`, a path never does.
  const looksInline = /\n/.test(kubeconfig) || /(^|\s)clusters\s*:/.test(kubeconfig)
  const text = looksInline ? kubeconfig : readFileSync(kubeconfig, 'utf8')

  let doc: Record<string, unknown>
  try {
    doc = parseYaml(text) as Record<string, unknown>
  } catch {
    throw new Error('kubernetes connector: kubeconfig is not valid YAML')
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('kubernetes connector: kubeconfig is empty or malformed')
  }

  const currentContext = doc['current-context']
  if (typeof currentContext !== 'string' || currentContext.length === 0) {
    throw new Error('kubernetes connector: kubeconfig has no current-context')
  }
  const ctxEntry = named<KubeconfigNamed<Record<string, unknown>>>(doc['contexts'], currentContext)
  const ctx = ctxEntry?.context
  if (!ctx) {
    throw new Error(`kubernetes connector: kubeconfig context "${currentContext}" not found`)
  }
  const clusterEntry = named<KubeconfigNamed<Record<string, unknown>>>(doc['clusters'], String(ctx['cluster'] ?? ''))
  const cluster = clusterEntry?.cluster
  if (!cluster || typeof cluster['server'] !== 'string') {
    throw new Error('kubernetes connector: kubeconfig current context has no cluster server')
  }
  const userEntry = named<KubeconfigNamed<Record<string, unknown>>>(doc['users'], String(ctx['user'] ?? ''))
  const user = userEntry?.user ?? {}

  const transport: ResolvedK8sTransport = {
    server: cluster['server'] as string,
    insecureSkipTlsVerify: cluster['insecure-skip-tls-verify'] === true,
  }
  const ca = pemFrom(cluster['certificate-authority-data'], cluster['certificate-authority'])
  if (ca) transport.ca = ca
  if (typeof user['token'] === 'string' && user['token'].length > 0) transport.token = user['token']
  const clientCert = pemFrom(user['client-certificate-data'], user['client-certificate'])
  const clientKey = pemFrom(user['client-key-data'], user['client-key'])
  if (clientCert) transport.clientCert = clientCert
  if (clientKey) transport.clientKey = clientKey
  return transport
}

/**
 * Resolve either credential shape into a transport: a kubeconfig (path or inline)
 * wins when present; otherwise the direct `{ token, apiServerUrl, caCert }` path.
 * The token path requires an API-server URL — a token with nowhere to send it is
 * a config error caught here, before any request.
 */
export function resolveK8sTransport(creds: K8sCredentials, config: K8sConnectorConfig): ResolvedK8sTransport {
  if (creds.kubeconfig) return parseKubeconfig(creds.kubeconfig)
  if (!config.apiServerUrl) {
    throw new Error('kubernetes connector: options.apiServerUrl is required with a token credential')
  }
  const transport: ResolvedK8sTransport = {
    server: config.apiServerUrl,
    insecureSkipTlsVerify: config.insecureSkipTlsVerify === true,
  }
  if (creds.token) transport.token = creds.token
  if (config.caCert) transport.ca = config.caCert
  return transport
}

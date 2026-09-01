// The k8s deployment-substrate enable path (ADR-224). Kubernetes is not a SaaS
// vendor — it is ubiquitous deployment infrastructure with a *declared* side (the
// repo's manifests) and an *observed* side (live cluster state), whose divergence
// is the payoff. So it is deliberately NOT a `neat connector` provider (no
// PROVIDER_DISPATCH entry, no vendor CLI). This module is its enable path: the
// daemon reads a dedicated `~/.neat/k8s.json` at slot bootstrap and runs the
// observed cluster-state reader (this connector's poll code) through the SAME
// `startConnectorPollLoop` plumbing every connector uses — the incident pipeline,
// the junction, the status tracker — reused, not rebuilt.
//
// The declared half (repo manifests → desired image / replicas, a static
// extractor) and the declared-vs-observed divergence are the substrate's other
// legs; this file is the observed leg's enable surface.

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { NeatGraph } from '../../graph.js'
import { resolveCredential, type CredentialRef } from '../../connectors-config.js'
import { startConnectorPollLoop } from '../index.js'
import { createKubernetesConnector } from './index.js'
import type { K8sConnectorConfig } from './types.js'

/**
 * One entry in `~/.neat/k8s.json` — a project's observed deployment surface. The
 * `credential` is the same env-ref-by-default shape connectors use (a token, or a
 * `{ kubeconfig }` field-map), resolved to a value only at daemon-read time so no
 * secret sits at rest (connector-config.md §2). Everything else is the reader's
 * non-secret config.
 */
export interface K8sSubstrateEntry {
  id: string
  // Matches a registered project's name; omitted binds to whichever project the
  // daemon is bootstrapping.
  project?: string
  credential: CredentialRef
  namespace: string
  apiServerUrl?: string
  caCert?: string
  insecureSkipTlsVerify?: boolean
  serviceMap?: Record<string, string>
  expectedZero?: string[]
  intervalMs?: number
}

export interface K8sSubstrateConfig {
  version: number
  deployments: K8sSubstrateEntry[]
}

function defaultHome(): string {
  const override = process.env.NEAT_HOME
  if (override && override.length > 0) return path.resolve(override)
  return path.join(os.homedir(), '.neat')
}

export function k8sSubstrateConfigPath(home: string = defaultHome()): string {
  return path.join(home, 'k8s.json')
}

/**
 * Read `~/.neat/k8s.json`. A missing or malformed file is an empty config, never
 * a throw — a project with no k8s substrate configured is the common case, the
 * same graceful-absence discipline the connector read-path holds.
 */
export async function readK8sSubstrateConfig(home: string = defaultHome()): Promise<K8sSubstrateConfig> {
  let raw: string
  try {
    raw = await readFile(k8sSubstrateConfigPath(home), 'utf8')
  } catch {
    return { version: 1, deployments: [] }
  }
  try {
    const parsed = JSON.parse(raw) as K8sSubstrateConfig
    if (!parsed || !Array.isArray(parsed.deployments)) return { version: 1, deployments: [] }
    return parsed
  } catch {
    return { version: 1, deployments: [] }
  }
}

export interface StartK8sSubstrateInput {
  project: string
  graph: NeatGraph
  projectDir: string
  errorsPath?: string
  home?: string
  env?: NodeJS.ProcessEnv
  onSkip?: (entry: K8sSubstrateEntry, reason: string) => void
  // Test seam — a fake `fetch` stands in for the live k8s API so the loop never
  // reaches a real cluster. Production leaves it undefined and the reader builds
  // the TLS-configured https adapter from the transport.
  fetchImpl?: typeof fetch
}

/**
 * Read the substrate config and start one poll loop per project-matched entry,
 * through the shared `startConnectorPollLoop`. Returns a stop function that tears
 * every loop down — wired into the daemon slot alongside `stopConnectors`. A bad
 * entry (unset env-ref, missing namespace) is skipped with a reason, never fatal
 * to the slot (the same discipline the connector read-path holds).
 */
export async function startK8sSubstratePolling(input: StartK8sSubstrateInput): Promise<() => void> {
  const config = await readK8sSubstrateConfig(input.home)
  const env = input.env ?? process.env
  const stops: Array<() => void> = []

  for (const entry of config.deployments) {
    if (entry.project !== undefined && entry.project !== input.project) continue
    if (typeof entry.namespace !== 'string' || entry.namespace.length === 0) {
      input.onSkip?.(entry, 'missing namespace')
      continue
    }
    let credentials: Record<string, unknown>
    try {
      const resolved = resolveCredential(entry.credential, env)
      // A single-string credential is the bearer token; a field-map carries its
      // own keys (`token` / `kubeconfig`), which readK8sCredentials reads.
      credentials = resolved.kind === 'fields' ? { ...resolved.fields } : { token: resolved.value }
    } catch (err) {
      input.onSkip?.(entry, (err as Error).message)
      continue
    }

    const cfg: K8sConnectorConfig = {
      namespace: entry.namespace,
      ...(entry.apiServerUrl ? { apiServerUrl: entry.apiServerUrl } : {}),
      ...(entry.caCert ? { caCert: entry.caCert } : {}),
      ...(entry.insecureSkipTlsVerify ? { insecureSkipTlsVerify: true } : {}),
      ...(entry.serviceMap ? { serviceMap: entry.serviceMap } : {}),
      ...(entry.expectedZero ? { expectedZero: entry.expectedZero } : {}),
    }
    const { connector, resolveTarget } = createKubernetesConnector(input.graph, cfg, input.fetchImpl)
    const stop = startConnectorPollLoop(
      connector,
      {
        projectDir: input.projectDir,
        project: input.project,
        credentials,
        ...(input.errorsPath ? { errorsPath: input.errorsPath } : {}),
      },
      input.graph,
      resolveTarget,
      { connectorId: `k8s:${entry.id}`, ...(entry.intervalMs ? { intervalMs: entry.intervalMs } : {}) },
    )
    stops.push(stop)
  }

  return () => {
    for (const stop of stops) stop()
  }
}

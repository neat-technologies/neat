// The flag-store reader's enable path (ADR-242). A feature-flag store is a
// dependency the services call, not a SaaS vendor, so it is not a `neat connector`
// provider. Like the k8s substrate (ADR-224), the daemon reads a dedicated
// `~/.neat/flag-stores.json` at slot bootstrap and polls each entry's endpoint for
// the definitions the store is serving, folding them onto the flag grain through
// ingest's `mergeObservedFlags`. The endpoint is configuration: how the daemon
// reaches the store (in-cluster DNS, a port-forward, a NodePort) is the
// operator's fact, never inferred.

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FlagDefinition } from '@neat.is/types'
import type { NeatGraph } from '../graph.js'
import { mergeObservedFlags } from '../ingest.js'
import { fetchFlagdFlags } from './flagd-sync.js'

export interface FlagStoreEntry {
  id: string
  // Matches a registered project's name; omitted binds to whichever project the
  // daemon is bootstrapping.
  project?: string
  // The provider, as compat.json's `flagStores` names it. Picks the reader.
  provider: string
  // How the daemon reaches the store's sync service, `host:port`.
  endpoint: string
  intervalMs?: number
}

export interface FlagStoresConfig {
  version: number
  stores: FlagStoreEntry[]
}

type FetchDefinitions = (endpoint: string) => Promise<Map<string, FlagDefinition>>

// Provider → its reader. The one place a provider's protocol is named.
const READERS: Record<string, FetchDefinitions> = {
  flagd: (endpoint) => fetchFlagdFlags(endpoint),
}

const DEFAULT_INTERVAL_MS = 15_000

function defaultHome(): string {
  const override = process.env.NEAT_HOME
  if (override && override.length > 0) return path.resolve(override)
  return path.join(os.homedir(), '.neat')
}

export function flagStoresConfigPath(home: string = defaultHome()): string {
  return path.join(home, 'flag-stores.json')
}

// A missing or malformed file is an empty config, never a throw: most projects
// configure no flag store.
export async function readFlagStoresConfig(home: string = defaultHome()): Promise<FlagStoresConfig> {
  try {
    const parsed = JSON.parse(await readFile(flagStoresConfigPath(home), 'utf8')) as FlagStoresConfig
    if (!parsed || !Array.isArray(parsed.stores)) return { version: 1, stores: [] }
    return parsed
  } catch {
    return { version: 1, stores: [] }
  }
}

export interface FlagStorePollResult {
  ok: boolean
  served?: number
  undeclared?: string[]
  error?: string
}

// One poll: fetch, fold. A failed fetch writes nothing, so the last observed
// definitions stay as they were rather than being cleared by a network blip.
export async function pollFlagStore(
  graph: NeatGraph,
  entry: FlagStoreEntry,
  fetchImpl?: FetchDefinitions,
  now: () => string = () => new Date().toISOString(),
): Promise<FlagStorePollResult> {
  const fetchDefinitions = fetchImpl ?? READERS[entry.provider]
  if (!fetchDefinitions) return { ok: false, error: `no reader for provider "${entry.provider}"` }
  try {
    const served = await fetchDefinitions(entry.endpoint)
    const { undeclared } = mergeObservedFlags(graph, entry.provider, served, now())
    return { ok: true, served: served.size, undeclared }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export interface StartFlagStoresInput {
  project: string
  graph: NeatGraph
  home?: string
  onSkip?: (entry: FlagStoreEntry, reason: string) => void
  // Test seam: stands in for the provider's reader.
  fetchImpl?: FetchDefinitions
}

export async function startFlagStorePolling(input: StartFlagStoresInput): Promise<() => void> {
  const config = await readFlagStoresConfig(input.home)
  const timers: NodeJS.Timeout[] = []
  for (const entry of config.stores) {
    if (entry.project !== undefined && entry.project !== input.project) continue
    if (typeof entry.endpoint !== 'string' || entry.endpoint.length === 0) {
      input.onSkip?.(entry, 'missing endpoint')
      continue
    }
    if (!input.fetchImpl && !READERS[entry.provider]) {
      input.onSkip?.(entry, `no reader for provider "${entry.provider}"`)
      continue
    }
    // Report a change of state once, not every failing poll.
    let lastError: string | undefined
    const tick = async (): Promise<void> => {
      const r = await pollFlagStore(input.graph, entry, input.fetchImpl)
      if (!r.ok && r.error !== lastError) {
        console.warn(`neat: flag store "${entry.id}" (${entry.provider} at ${entry.endpoint}) poll failed — ${r.error}`)
      }
      lastError = r.ok ? undefined : r.error
    }
    void tick()
    const timer = setInterval(() => void tick(), entry.intervalMs ?? DEFAULT_INTERVAL_MS)
    timer.unref?.()
    timers.push(timer)
  }
  return () => {
    for (const t of timers) clearInterval(t)
  }
}

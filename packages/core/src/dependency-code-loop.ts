import type { NeatGraph } from './graph.js'
import { inventoryFromGraph, loadAdvisorySnapshot, matchAdvisories } from './advisories/index.js'
import { discoverServices } from './extract/services.js'
import { dropDependencyCode, extractDependencyCode } from './extract/dependency-symbols/index.js'
import { isDependencyNodeId, isDependencySymbolId } from '@neat.is/types'

// The dependency-code loop (ADR-274, dependency-inventory.md §5): keeps the
// graph holding the code of exactly the dependency versions that match a known
// advisory, so a security card can walk into the package. It runs on its own
// cadence under the daemon, like the connector and flag-store loops, because it
// needs the advisory match and so the network (through the advisory cache,
// refreshed at most daily). The extraction pass stays offline, and the security
// tools only read what this loop left in the graph.
//
// Each tick: match the graph's inventory against the advisory snapshot, extract
// the code of every matched version, and drop the code of any version that no
// longer matches. NEAT_ADVISORIES=off turns it into a no-op.

/** Every hour. The advisory cache refreshes daily, so most ticks are cache hits. */
export const DEFAULT_DEPENDENCY_CODE_INTERVAL_MS = 60 * 60 * 1000
/** First tick after bootstrap, once the initial extraction has settled. */
export const DEFAULT_DEPENDENCY_CODE_DELAY_MS = 30 * 1000

export interface DependencyCodeTickResult {
  advisories: 'mirror' | 'osv' | 'disabled'
  matched: number
  extracted: number
  dropped: number
  notLocated: number
  errors: string[]
}

export interface DependencyCodeLoopInput {
  project: string
  graph: NeatGraph
  /** The project's checkout, where its lockfiles and installed packages are. */
  projectDir: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  intervalMs?: number
  initialDelayMs?: number
  onTick?: (r: DependencyCodeTickResult) => void
}

/** One pass of the loop. Exposed for tests and a manual refresh. */
export async function runDependencyCodeTick(
  input: Pick<DependencyCodeLoopInput, 'graph' | 'projectDir' | 'env' | 'fetchImpl'>,
  // True once the loop is stopped: a pass still waiting on the advisory feed then
  // leaves the graph alone, since its slot may already be torn down.
  stopped: () => boolean = () => false,
): Promise<DependencyCodeTickResult> {
  const inventory = inventoryFromGraph(input.graph)
  const loaded = await loadAdvisorySnapshot(inventory, {
    ...(input.env ? { env: input.env } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  })
  const result: DependencyCodeTickResult = {
    advisories: loaded.source,
    matched: 0,
    extracted: 0,
    dropped: 0,
    notLocated: 0,
    errors: loaded.errors,
  }
  // Disabled, or no snapshot at all: change nothing. Dropping code because the
  // feed is unreachable would erase reachability the last good snapshot found.
  if (!loaded.snapshot || stopped()) return result
  const matched = new Set(matchAdvisories(inventory, loaded.snapshot).map((m) => m.dependencyId))
  result.matched = matched.size

  // Versions whose code is in the graph but that no longer match. Only on a clean
  // refresh: a failed one hands back an empty or partial snapshot, and reading
  // that as "nothing matches" would drop code because the feed was down.
  if (loaded.errors.length === 0) {
    const withCode = new Set<string>()
    input.graph.forEachNode((id) => {
      if (!isDependencySymbolId(id)) return
      for (const owner of input.graph.inNeighbors(id)) {
        if (isDependencyNodeId(owner) && !isDependencySymbolId(owner)) withCode.add(owner)
      }
    })
    for (const depId of [...withCode].sort()) {
      if (matched.has(depId)) continue
      result.dropped += dropDependencyCode(input.graph, depId)
    }
  }

  if (matched.size > 0 && !stopped()) {
    const services = await discoverServices(input.projectDir)
    const r = await extractDependencyCode(input.graph, services, input.projectDir, [...matched].sort(), input.env)
    result.extracted = r.nodesAdded
    result.notLocated = r.notLocated.length
  }
  return result
}

/** Start the loop for one project slot. Returns its stop function. */
export function startDependencyCodeLoop(input: DependencyCodeLoopInput): () => void {
  let running = false
  let stopped = false
  const tick = async (): Promise<void> => {
    // One pass at a time: a slow pass is skipped over, never stacked.
    if (running || stopped) return
    running = true
    try {
      const r = await runDependencyCodeTick(input, () => stopped)
      if (!stopped) input.onTick?.(r)
    } catch (err) {
      console.warn(`neatd: dependency code for project "${input.project}" failed: ${(err as Error).message}`)
    } finally {
      running = false
    }
  }
  const first = setTimeout(() => void tick(), input.initialDelayMs ?? DEFAULT_DEPENDENCY_CODE_DELAY_MS)
  first.unref?.()
  const timer = setInterval(() => void tick(), input.intervalMs ?? DEFAULT_DEPENDENCY_CODE_INTERVAL_MS)
  timer.unref?.()
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}

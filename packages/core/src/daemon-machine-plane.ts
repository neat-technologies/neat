// The machine-home plane of a daemon slot: the surfaces enabled off this machine's
// `~/.neat` rather than the project's own `.neat`. Split out of daemon.ts alongside
// the per-project plane (daemon-project-plane.ts) so the slot bootstrap stays the
// entry and each plane owns its config source (#1373). These loops still write into
// the slot's project graph; only their enablement is machine-level.

import type { NeatGraph } from './graph.js'
import { startK8sSubstratePolling } from './connectors/kubernetes/index.js'
import { startFlagStorePolling } from './flag-stores/index.js'

export interface MachinePlaneInput {
  project: string
  graph: NeatGraph
  projectDir: string
  errorsPath: string
  // This machine's NEAT home; k8s.json and flag-stores.json are read from here. Left
  // unset outside tests, so the loops fall back to the default ~/.neat.
  neatHome?: string
}

export interface MachinePlaneHandles {
  stopK8sSubstrate: () => void
  stopFlagStores: () => void
}

/**
 * Start the machine-home loops for a slot, in the order the bootstrap had them.
 *
 * k8s deployment substrate (ADR-224) — the observed cluster-state reader, enabled off
 * `~/.neat/k8s.json` rather than the `neat connector` vendor surface, run through the
 * same poll/incident plumbing as the connectors. Flag-store reader (ADR-242) — what
 * each configured feature-flag store is serving, folded onto the flag grain, enabled
 * off `~/.neat/flag-stores.json`.
 */
export async function startMachinePlane(input: MachinePlaneInput): Promise<MachinePlaneHandles> {
  const stopK8sSubstrate = await startK8sSubstratePolling({
    project: input.project,
    graph: input.graph,
    projectDir: input.projectDir,
    errorsPath: input.errorsPath,
    ...(input.neatHome ? { home: input.neatHome } : {}),
    onSkip: (skipped, reason) =>
      console.warn(`neatd: k8s substrate "${skipped.id}" skipped for project "${input.project}" — ${reason}`),
  })
  const stopFlagStores = await startFlagStorePolling({
    project: input.project,
    graph: input.graph,
    ...(input.neatHome ? { home: input.neatHome } : {}),
    onSkip: (skipped, reason) =>
      console.warn(`neatd: flag store "${skipped.id}" skipped for project "${input.project}" — ${reason}`),
  })
  return { stopK8sSubstrate, stopFlagStores }
}

import type { ErrorEvent } from '@neat.is/types'
import { EdgeType } from '@neat.is/types'
import type { NeatGraph } from './graph.js'
import { nodeContext, isBoundaryTimeoutSymptom, resolveHangHop } from './traverse.js'
import { readErrorEvents, promoteFrontierEdges, stageFrontierEdge } from './ingest.js'

// How many recent incidents the reconciliation reads per tick. The newest sit at
// the tail of the append-only ledger and are the only ones a live hang is in.
const RECONCILE_INCIDENT_LIMIT = 500

// ADR-226 — the hang sensor. A post-ingest analysis pass that stages a FRONTIER
// surface on the unobservable hop of a boundary-timeout hang: the edge NEAT
// reached toward but cannot see because its far end hung and exported no span.
//
// This is the ONLY hang-specific piece of the feature (the redstone rule): what it
// stages is a general FRONTIER edge, and promotion (which graduates it when the
// service recovers) and the reader (which surfaces it) never know the word "hang."
// It runs in the reconciliation sweep (the daemon's staleness-loop `onReconcile`),
// never the OTLP hot path — a span that never exports can't be seen from ingest,
// so there is nothing to do inline.
//
// The staged surface is self-correcting alongside promotion: a surface is added
// only while the hop is genuinely unobservable (no OBSERVED twin), and dropped by
// `promoteFrontierEdges` once the twin arrives — so a FRONTIER hang edge exists
// exactly while the hang does.
export function stageHangSurfaces(graph: NeatGraph, incidents: ErrorEvent[]): number {
  // The only candidates are nodes carrying an incident — a boundary that timed out.
  const boundaries = new Set<string>()
  for (const ev of incidents) {
    if (ev.affectedNode && graph.hasNode(ev.affectedNode)) boundaries.add(ev.affectedNode)
  }

  let staged = 0
  for (const boundary of boundaries) {
    const ctx = nodeContext(graph, boundary, incidents)
    if (!isBoundaryTimeoutSymptom(ctx)) continue

    const hop = resolveHangHop(graph, boundary, incidents)
    if (!hop) continue // honest-coarse — no declared serving path resolves

    // The graph write goes through ingest's lifecycle authority (ADR-030), which
    // also guards against staging an already-OBSERVED hop (the service is up, not
    // hung) or a duplicate — so the sensor here is pure detection + resolution.
    if (stageFrontierEdge(graph, hop.source, hop.target, EdgeType.CALLS)) staged++
  }
  return staged
}

// ADR-226 — the FRONTIER reconciliation step, wired to the staleness loop's
// `onReconcile` (the periodic post-ingest point) in both the daemon and `neat
// watch`. First graduate any surface whose OBSERVED twin has arrived (a hang that
// recovered), then stage surfaces for the current hangs, reading the same errors
// ledger the incident queries do. Kept here so ingest.ts never imports the sensor
// (which would cycle through traverse).
export async function reconcileFrontierSurfaces(
  graph: NeatGraph,
  errorsPath: string,
): Promise<void> {
  promoteFrontierEdges(graph)
  let incidents: ErrorEvent[] = []
  try {
    incidents = await readErrorEvents(errorsPath, { limit: RECONCILE_INCIDENT_LIMIT })
  } catch {
    incidents = []
  }
  stageHangSurfaces(graph, incidents)
}

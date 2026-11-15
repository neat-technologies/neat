// The per-project plane of a daemon slot: the surfaces configured from the
// project's own `<repo>/.neat` and routed by its binding (ADR-273). Split out of
// daemon.ts so the slot bootstrap stays the entry and a new per-project surface
// gets the project's root and binding from one call here (#1373), rather than each
// loop re-deriving them. The machine-home plane (k8s substrate, flag store) lives
// in daemon-machine-plane.ts.

import type { NeatGraph } from './graph.js'
import type { ConnectorRegistration } from './connectors/index.js'
import { startConnectorPolling } from './connectors/registry.js'
import { maybeStartHostedConnectors } from './connectors/hosted.js'
import { projectBindingAtRoot } from './project-resolve.js'

export interface ProjectConnectorsPlaneInput {
  project: string
  graph: NeatGraph
  // The project root; its .neat/connectors.json and binding are read from here.
  projectDir: string
  // The slot's incident ledger, so an incident-emitting connector (ADR-185) writes
  // a build-failure incident onto the same errors.ndjson OTLP-derived incidents land in.
  errorsPath: string
  // Registrations a programmatic caller passed in opts.connectors, merged with the
  // file-configured ones.
  extra?: ConnectorRegistration[]
}

export interface ProjectConnectorsPlaneHandles {
  stopConnectors: () => void
  stopHostedConnectors: () => void
}

/**
 * Start the project's connector loops. Resolves the binding at the project root
 * once (projectBindingAtRoot, #1637) and hands it to the connector loop; a future
 * per-project surface added here reuses that one resolution.
 *
 * Connectors plane (docs/contracts/connectors.md, ADR-124; on-ramp ADR-130) — every
 * entry in the project's own `.neat/connectors.json` (ADR-273) becomes a registration,
 * resolved through the dispatch table so no provider specifics leak out. The env-ref
 * credential resolves into memory only and never reaches the snapshot
 * (connector-config.md §6). A bad entry is skipped with a log, never fatal to the slot;
 * these merge with any registrations the caller passed in `extra`. A hosted-bound
 * project's connectors come from the control plane (maybeStartHostedConnectors), so its
 * local file is never read. One poll loop per registered connector, torn down alongside
 * the staleness loop (teardownSlot); the shared helper is the same path `neat watch`
 * uses so both serve connectors identically (#871).
 */
export async function startProjectConnectorsPlane(
  input: ProjectConnectorsPlaneInput,
): Promise<ProjectConnectorsPlaneHandles> {
  const binding = (await projectBindingAtRoot(input.projectDir)).binding
  const stopConnectors = await startConnectorPolling({
    project: input.project,
    graph: input.graph,
    projectDir: input.projectDir,
    errorsPath: input.errorsPath,
    binding,
    extra: input.extra ?? [],
    onSkip: (skipped, reason) =>
      console.warn(
        `neatd: connector "${skipped.id}" (${skipped.provider}) skipped for project "${input.project}" — ${reason}`,
      ),
  })
  // Hosted-profile connectors (connectors/hosted.ts, INFRA-ADR-011) — the providers
  // the control plane brokers on the customer's behalf. Active only when the hosted
  // env is present (NEAT_CP_URL + NEAT_CP_PROJECT_ID + NEAT_AUTH_TOKEN); a no-op on a
  // local daemon. Each connection runs the SAME poll loop as a file-configured one,
  // differing only in where the credential comes from — the CP, pulled fresh per tick.
  const stopHostedConnectors = await maybeStartHostedConnectors({
    project: input.project,
    graph: input.graph,
    projectDir: input.projectDir,
    errorsPath: input.errorsPath,
    onSkip: (provider, reason) =>
      console.warn(`neatd: hosted connector "${provider}" skipped for project "${input.project}" — ${reason}`),
  })
  return { stopConnectors, stopHostedConnectors }
}

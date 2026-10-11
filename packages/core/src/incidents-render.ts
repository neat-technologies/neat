import { ObservedDeployContextSchema, type DeployContext, type ErrorEvent } from '@neat.is/types'

// The OBSERVED deploy/process/config context of a faulted workload (ADR-237/240),
// fused onto its node at ingest (ADR-241): the deploy fault, the faulted
// container's redacted env/args, and its boot-time stdout tail. Rendered compactly
// so the incident surfaces the wrong host / bad flag / crash traceback inline
// instead of leaving it to the card.
//
// One renderer, every text reader: the CLI `neat incidents` output (cli-client.ts)
// and the MCP get_incident_history / incident-card tools (packages/mcp) all call
// this, so they never drift (core #1373 — atomic, no feature mirrors another's
// fields). Returns [] when there is no context, so those lines read exactly as
// before.
export function deployHintLines(ctx: DeployContext | undefined): string[] {
  if (!ctx) return []
  const env = ctx.containerEnv ?? []
  const args = ctx.containerArgs ?? []
  const log = ctx.processLog
  if (!ctx.fault && env.length === 0 && args.length === 0 && !log) return []
  const out: string[] = []
  if (ctx.fault) {
    const bits = [ctx.fault]
    if (ctx.waitingReason) bits.push(ctx.waitingReason)
    if (ctx.restartCount !== undefined) bits.push(`restarts=${ctx.restartCount}`)
    if (ctx.exitCode !== undefined) bits.push(`exit=${ctx.exitCode}`)
    if (ctx.terminatedReason) bits.push(ctx.terminatedReason)
    out.push(`deploy: ${bits.join(' ')}`)
  }
  const cap = (xs: string[], max: number): string => {
    const joined = xs.join('  ')
    return joined.length > max ? `${joined.slice(0, max)}…(+${xs.length} entries)` : joined
  }
  if (env.length > 0) out.push(`env: ${cap(env, 700)}`)
  if (args.length > 0) out.push(`args: ${cap(args, 300)}`)
  if (log) {
    const tail = log.split('\n').filter((l) => l.trim().length > 0).slice(-4)
    if (tail.length > 0) out.push(`log: ${tail.join(' ⏎ ')}`)
  }
  return out
}

// The deploy context on each incident's workload node, keyed by the incident it
// was observed with (ADR-241). `readNode` is the caller's own GET /graph/node/:id;
// it runs once per distinct affected node, and a node that can't be read just
// shows no context.
export async function deployContextsFor(
  events: ErrorEvent[],
  readNode: (nodeId: string) => Promise<{ observedDeployContext?: unknown } | undefined>,
): Promise<Map<string, DeployContext>> {
  const byIncident = new Map<string, DeployContext>()
  for (const nodeId of new Set(events.map((e) => e.affectedNode))) {
    try {
      const parsed = ObservedDeployContextSchema.safeParse((await readNode(nodeId))?.observedDeployContext)
      if (!parsed.success) continue
      const { incidentId, observedAt: _observedAt, ...ctx } = parsed.data
      byIncident.set(incidentId, ctx)
    } catch {
      // The incident list still renders without the context.
    }
  }
  return byIncident
}

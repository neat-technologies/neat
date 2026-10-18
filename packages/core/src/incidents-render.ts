import {
  ObservedDeployContextSchema,
  type ChangesSinceHealthy,
  type HealthyChange,
  type DeployContext,
  type ErrorEvent,
  type ConfigMismatchDivergence,
  type FlagMismatchDivergence,
} from '@neat.is/types'

// The OBSERVED deploy/process/config context of a faulted workload (ADR-237/240),
// fused onto its node at ingest (ADR-243): the deploy fault, the faulted
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
// was observed with (ADR-243). `readNode` is the caller's own GET /graph/node/:id;
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

// A config mismatch (ADR-265) in one phrase, the same on every surface that names
// one. Lists every side with where it was read and its provenance, and says
// nothing about which side is wrong.
export function configMismatchPhrase(d: ConfigMismatchDivergence): string {
  const sides = d.evidence.map((e) => `${e.role} ${e.value} (${e.location}, ${e.provenance})`)
  return `${d.field} disagrees: ${sides.join(' vs ')}`
}

// A flag-grain divergence (ADR-242) in one phrase, the same on every surface that
// names one: the card's divergence summary, `neat divergences`, MCP
// get_divergences and the monitor stream. Names the flag, the committed and the
// running variant, and where the code reads it.
export function flagMismatchPhrase(d: FlagMismatchDivergence): string {
  const q = (v: string | null | undefined): string => (v === null || v === undefined ? 'none' : v)
  const what = d.changed.includes('defaultVariant')
    ? `committed ${q(d.declaredVariant)}, running ${q(d.observedVariant)}`
    : `${d.changed.join(', ')} changed from the committed definition`
  const at = d.readers && d.readers.length > 0 ? ` (read at ${d.readers.join(', ')})` : ''
  return `flag ${d.flagKey}: ${what}${at}`
}

// One change since healthy in a phrase (ADR-270): the object and its first field
// change, read by name. `k8s-deployment frontend: containers/frontend/env/CART_ADDR
// removed (was cart:8080)`.
export function healthyChangePhrase(c: HealthyChange): string {
  const what =
    c.kind === 'object'
      ? c.node.replace(/^infra:/, '').replace(':', ' ')
      : c.kind === 'flag'
        ? c.id.replace(/^flag:/, 'flag ')
        : `${c.id.replace(/^[A-Z_]+:[A-Z]+:/, '')}`
  if (c.change === 'added') return `${what} added`
  if (c.change === 'removed') return `${what} removed`
  const f = c.fields[0]
  if (!f) return `${what} changed`
  const field = f.path.replace(/^\/template\//, '').replace(/^\//, '')
  const v = (x: unknown): string => (typeof x === 'string' ? x : JSON.stringify(x))
  // A named entry whose name was its only field (an env var, which never carries
  // a value) has nothing more to show.
  const bare = (x: unknown): boolean => typeof x === 'object' && x !== null && Object.keys(x).length === 0
  const delta =
    f.before === undefined
      ? bare(f.after) ? 'added' : `added (${v(f.after)})`
      : f.after === undefined
        ? bare(f.before) ? 'removed' : `removed (was ${v(f.before)})`
        : `${v(f.before)} → ${v(f.after)}`
  const more = c.fields.length > 1 ? ` (+${c.fields.length - 1} more)` : ''
  return `${what}: ${field} ${delta}${more}`
}

// The card's "changed since healthy" section as text lines (ADR-270), the same
// on every reader: the base it was diffed against, then the nearest changes.
export function changedSinceHealthyLines(c: ChangesSinceHealthy | undefined, max = 5): string[] {
  if (!c || !c.base || c.changes.length === 0) return []
  const out = [`changed since healthy (baseline ${c.base.takenAt}) [OBSERVED]:`]
  for (const ch of c.changes.slice(0, max)) {
    out.push(`  ${healthyChangePhrase(ch)}${ch.distance !== undefined ? ` · ${ch.distance} hop${ch.distance === 1 ? '' : 's'} away` : ''}`)
  }
  if (c.changes.length > max) out.push(`  +${c.changes.length - max} more (GET /graph/changes)`)
  return out
}

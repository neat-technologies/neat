import type { ErrorEvent } from '@neat.is/types'

// The OBSERVED deploy/process/config context an incident may carry (ADR-237/240):
// the deploy fault, the faulted container's redacted env/args, and its boot-time
// stdout tail. Rendered compactly so the incident surfaces the wrong host / bad
// flag / crash traceback inline instead of leaving it to the card.
//
// One renderer, two readers: the CLI `neat incidents` output (cli-client.ts) and
// the MCP get_incident_history tool (packages/mcp) both call this, so the two
// never drift (core #1373 — atomic, no feature mirrors another's fields).
// Returns [] for a non-k8s incident, so those lines read exactly as before.
export function deployHintLines(ev: ErrorEvent): string[] {
  const a = ev.attributes
  if (!a) return []
  const s = (k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string) : undefined)
  const n = (k: string): number | undefined => (typeof a[k] === 'number' ? (a[k] as number) : undefined)
  const arr = (k: string): string[] => (Array.isArray(a[k]) ? (a[k] as unknown[]).filter((x) => typeof x === 'string') as string[] : [])
  const fault = s('k8s.fault')
  const env = arr('k8s.containerEnv')
  const args = arr('k8s.containerArgs')
  const log = s('k8s.processLog')
  if (!fault && env.length === 0 && args.length === 0 && !log) return []
  const out: string[] = []
  if (fault) {
    const bits = [fault]
    const wr = s('k8s.waitingReason'); if (wr) bits.push(wr)
    const rc = n('k8s.restartCount'); if (rc !== undefined) bits.push(`restarts=${rc}`)
    const ec = n('k8s.exitCode'); if (ec !== undefined) bits.push(`exit=${ec}`)
    const tr = s('k8s.terminatedReason'); if (tr) bits.push(tr)
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

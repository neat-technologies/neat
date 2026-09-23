// Railway hosted target ref (docs/contracts/connectors.md §3, ADR-127) — the daemon's decode half of the
// composite ref the control-plane picker produces.
//
// A Supabase project is one opaque 20-char ref, so its hosted `projectRef` is that ref verbatim. Railway's
// pull target isn't: httpLogs/networkFlowLogs are scoped by an (environmentId, serviceId) pair (railway/
// client.ts), which is two ids, not one. The hosted broker's project picker (neat-infra's RailwayConnectDriver
// .listProjects) therefore packs both — plus the Railway service's own display name, for the picker label —
// into one opaque string so `RemoteProject.ref` stays flat, exactly as every other provider's does:
//
//   ref = base64url(JSON.stringify({ environmentId, serviceId, serviceName }))
//
// The control plane stores that string as the connection's `projectRef` and delivers it unchanged; the daemon
// decodes it here into the pull options railway/index.ts's connector needs. This is the local↔hosted swap
// point and nothing more — the credential source and the pull options differ between profiles, the pull/map/
// fuse logic does not (connectors.md §3). The encode side lives in neat-infra and is mirrored structurally
// (no shared package across the plane), so the field shape below is the contract both sides hold to.

/** The (environment, service) target a hosted Railway connection is bound to, recovered from its `projectRef`. */
export interface RailwayTargetRef {
  environmentId: string
  serviceId: string
  /** The Railway service's own display name — carried for the picker label; the daemon's pull options don't
   *  need it (serviceNameById maps the Railway serviceId to the NEAT service name, not this one). Present when
   *  the encoder set it, absent otherwise. */
  serviceName?: string
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/**
 * Decode a hosted Railway `projectRef` into its (environmentId, serviceId) target. Returns null on anything
 * malformed — not base64url, not JSON, or missing the two ids the pull path needs — so a foreign or corrupted
 * ref drops honestly (the same "null/garbage in drops, never throws" discipline connectors.md §4 holds for a
 * provider row), never crashing the hosted discovery loop. `serviceName` is echoed through when present but is
 * not required: the daemon only needs the two ids to poll.
 */
export function decodeRailwayTargetRef(ref: string): RailwayTargetRef | null {
  if (typeof ref !== 'string' || ref.length === 0) return null
  let json: string
  try {
    json = Buffer.from(ref, 'base64url').toString('utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (!nonEmptyString(obj.environmentId) || !nonEmptyString(obj.serviceId)) return null
  return {
    environmentId: obj.environmentId,
    serviceId: obj.serviceId,
    ...(nonEmptyString(obj.serviceName) ? { serviceName: obj.serviceName } : {}),
  }
}

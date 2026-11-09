// PlanetScale hosted target ref (docs/contracts/connectors.md §3) — the daemon's decode half of the composite ref
// the control-plane picker produces, the same pattern as railway/target-ref.ts.
//
// A PlanetScale pull target is an (organization, database, branch) triple: the Insights path is
// /organizations/{org}/databases/{db}/branches/{branch}/insights (client.ts). The hosted broker's project picker
// (neat-infra's PlanetscaleConnectDriver.listProjects) packs all three into one opaque string so
// `RemoteProject.ref` stays flat:
//
//   ref = base64url(JSON.stringify({ organization, database, branch }))
//
// The control plane stores it as the connection's `projectRef` and delivers it unchanged; the daemon decodes it
// here into the connector's required options. The encode side lives in neat-infra and is mirrored structurally
// (no shared package across the plane), so the field shape below is the contract both sides hold to.

/** The (organization, database, branch) a hosted PlanetScale connection is bound to. */
export interface PlanetscaleTargetRef {
  organization: string
  database: string
  branch: string
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Encode a target the way the control-plane picker does. Used by tests to pin the shared shape. */
export function encodePlanetscaleTargetRef(target: PlanetscaleTargetRef): string {
  return Buffer.from(
    JSON.stringify({ organization: target.organization, database: target.database, branch: target.branch }),
  ).toString('base64url')
}

/**
 * Decode a hosted PlanetScale `projectRef`. Returns null on anything malformed — not base64url, not JSON, or
 * missing any of the three names — so a foreign or corrupted ref drops honestly instead of crashing the hosted
 * discovery loop (connectors.md §4).
 */
export function decodePlanetscaleTargetRef(ref: string): PlanetscaleTargetRef | null {
  if (typeof ref !== 'string' || ref.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (!nonEmptyString(obj.organization) || !nonEmptyString(obj.database) || !nonEmptyString(obj.branch)) {
    return null
  }
  return { organization: obj.organization, database: obj.database, branch: obj.branch }
}

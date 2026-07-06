// LogEntry -> ObservedSignal mapping (docs/connectors/firebase.md, ADR-128).
// One signal per log entry — no aggregation across entries — so each
// concrete request stays individually traceable back to the raw log line it
// came from; the shared pipeline (connectors/index.ts) already replays a
// signal's callCount/errorCount as individual upserts, so nothing is lost by
// keeping this 1:1.
//
// This module never touches Firestore or Firebase Auth data or APIs —
// out of scope per firebase.md §Scope. It only reads the httpRequest /
// resource fields off a Cloud Logging LogEntry.

import type { LogEntry as NeatLogEntry } from '@neat.is/types'
import type { ObservedSignal } from '../types.js'
import { isFirebaseResourceType, type FirebaseResourceType, type LogEntry } from './logging-api.js'
// Type-only — erased at build time, so this never creates a runtime import
// cycle with resolve.ts (which imports a value from this file).
import type { FirebaseServiceMap } from './resolve.js'

// The provider-vocabulary identity this connector's signals carry through
// the shared pipeline (targetKind/targetName, per types.ts's ObservedSignal
// doc comment: "the provider's own vocabulary"). Packed into a single string
// because ObservedSignal.targetName is a plain string field; unpacked only by
// this connector's own resolveTarget (resolve.ts), never surfaced to the
// graph. `\x00` is used as a separator since it cannot appear in an HTTP
// method token, a GCP resource name, or a URL path.
const FIELD_SEP = '\x00'

export interface FirebaseTargetIdentity {
  resourceName: string
  method: string
  path: string
}

export function packFirebaseTargetName(identity: FirebaseTargetIdentity): string {
  return [identity.resourceName, identity.method, identity.path].join(FIELD_SEP)
}

export function parseFirebaseTargetName(targetName: string): FirebaseTargetIdentity | null {
  // Split on the first two separators only — a path (always the last field)
  // may itself carry no separator characters in practice, but splitting
  // greedily here rather than on every occurrence keeps this correct even if
  // it ever did.
  const firstSep = targetName.indexOf(FIELD_SEP)
  if (firstSep === -1) return null
  const resourceName = targetName.slice(0, firstSep)
  const rest = targetName.slice(firstSep + 1)
  const secondSep = rest.indexOf(FIELD_SEP)
  if (secondSep === -1) return null
  const method = rest.slice(0, secondSep)
  const path = rest.slice(secondSep + 1)
  if (!resourceName || !method || !path) return null
  return { resourceName, method, path }
}

// The resource-identity label Google's own monitored-resource schema carries
// per type (confirmed at
// https://cloud.google.com/logging/docs/api/v2/resource-list):
//   cloud_function      -> labels.function_name
//   cloud_run_revision   -> labels.service_name
//   firebase_domain      -> labels.site_name
function resourceNameFor(
  type: FirebaseResourceType,
  labels: Record<string, string> | undefined,
): string | null {
  if (!labels) return null
  switch (type) {
    case 'cloud_function':
      return labels['function_name'] ?? null
    case 'cloud_run_revision':
      return labels['service_name'] ?? null
    case 'firebase_domain':
      return labels['site_name'] ?? null
  }
}

// `httpRequest.requestUrl` is documented as "typically without the scheme,
// host, port, and query portion" — i.e. usually already a bare path — but a
// deployment that logs a full absolute URL is handled too. Returns null when
// the value is neither a bare path nor a parseable absolute URL, the same
// "honest miss, never guessed" discipline `pathOf` uses in
// extract/calls/route-match.ts.
function pathFromRequestUrl(requestUrl: string | undefined): string | null {
  if (!requestUrl) return null
  if (requestUrl.startsWith('/')) {
    const withoutQuery = requestUrl.split('?')[0]
    return withoutQuery && withoutQuery.length > 0 ? withoutQuery : '/'
  }
  try {
    const candidate = requestUrl.startsWith('//') ? `https:${requestUrl}` : requestUrl
    const parsed = new URL(candidate)
    return parsed.pathname || '/'
  } catch {
    return null
  }
}

// A response is counted as an error at the 5xx threshold — the same
// unambiguous-failure line ingest.ts draws for a failing HTTP response
// (see the `status >= 500` branch in handleSpan's failing-response-incident
// logic). A 4xx is a plausible client error, not necessarily a service
// defect, so it isn't counted here.
const ERROR_STATUS_THRESHOLD = 500

// Maps one Cloud Logging LogEntry to one ObservedSignal. Returns null for an
// entry this connector can't honestly attribute — an unrecognised resource
// type (filter should already exclude these, but never trust the filter
// alone), a resource with no identity label, or an httpRequest missing the
// method/path a signal needs. Nothing here is guessed or fabricated.
export function mapLogEntryToSignal(entry: LogEntry): ObservedSignal | null {
  const resourceType = entry.resource?.type
  if (!resourceType || !isFirebaseResourceType(resourceType)) return null

  const resourceName = resourceNameFor(resourceType, entry.resource?.labels)
  if (!resourceName) return null

  const req = entry.httpRequest
  if (!req) return null
  if (!req.requestMethod) return null
  const method = req.requestMethod.toUpperCase()
  const path = pathFromRequestUrl(req.requestUrl)
  if (path === null) return null

  const timestamp = entry.timestamp
  if (!timestamp) return null

  const isError = typeof req.status === 'number' && req.status >= ERROR_STATUS_THRESHOLD

  return {
    targetKind: resourceType,
    targetName: packFirebaseTargetName({ resourceName, method, path }),
    callCount: 1,
    errorCount: isError ? 1 : 0,
    lastObservedIso: timestamp,
  }
}

export function mapLogEntriesToSignals(entries: LogEntry[]): ObservedSignal[] {
  const out: ObservedSignal[] = []
  for (const entry of entries) {
    const signal = mapLogEntryToSignal(entry)
    if (signal) out.push(signal)
  }
  return out
}

// ── LogEntry -> NEAT LogEntry (docs/contracts/logs.md, connectors.md §7,
// ADR-132) ───────────────────────────────────────────────────────────────
//
// Additive alongside mapLogEntryToSignal above, from the same raw Cloud
// Logging record — one NEAT LogEntry per raw entry, never gated on whether a
// signal was produced from it. serviceName resolves through the identical
// FirebaseServiceMap resolve.ts's own resourceName lookup consults (a pure
// config-time map, never a graph query) — never a second, guessed mapping.
// nodeId is left unset: the RouteNode match resolve.ts computes needs a live
// graph read this connector's poll() has no access to (unlike Railway/
// Cloudflare/Supabase, whose poll() already closes over either the graph or
// a graph-free config lookup) — an honest gap, not a fabricated id.
function neatServiceNameForLog(
  resourceType: FirebaseResourceType,
  resourceName: string,
  serviceMap: FirebaseServiceMap,
): string | undefined {
  switch (resourceType) {
    case 'cloud_function':
      return serviceMap.functions?.[resourceName]
    case 'cloud_run_revision':
      return serviceMap.cloudRun?.[resourceName]
    case 'firebase_domain':
      return serviceMap.hosting?.[resourceName]
  }
}

function logSeverityForStatus(status: number | undefined): string {
  if (typeof status !== 'number') return 'info'
  if (status >= ERROR_STATUS_THRESHOLD) return 'error'
  if (status >= 400) return 'warn'
  return 'info'
}

export function mapLogEntryToLogEntry(
  entry: LogEntry,
  projectName: string,
  serviceMap: FirebaseServiceMap,
): NeatLogEntry | null {
  const resourceType = entry.resource?.type
  if (!resourceType || !isFirebaseResourceType(resourceType)) return null
  const resourceName = resourceNameFor(resourceType, entry.resource?.labels)
  if (!resourceName) return null
  const timestamp = entry.timestamp
  if (!timestamp) return null

  const req = entry.httpRequest
  const method = req?.requestMethod?.toUpperCase()
  const reqPath = pathFromRequestUrl(req?.requestUrl)
  const serviceName = neatServiceNameForLog(resourceType, resourceName, serviceMap)

  const message =
    method && reqPath
      ? `${method} ${reqPath} → ${req?.status ?? 'unknown'}${req?.latency ? ` (${req.latency})` : ''}`
      : `${resourceType} ${resourceName} event`

  return {
    id: entry.insertId ? `firebase-${entry.insertId}` : `firebase-${resourceName}-${timestamp}`,
    projectName,
    source: 'firebase',
    ...(serviceName ? { serviceName } : {}),
    timestamp,
    severity: logSeverityForStatus(req?.status),
    message,
    attributes: {
      resourceType,
      resourceName,
      ...(method ? { method } : {}),
      ...(reqPath ? { path: reqPath } : {}),
      ...(typeof req?.status === 'number' ? { status: req.status } : {}),
      ...(req?.latency ? { latency: req.latency } : {}),
      ...(req?.userAgent ? { userAgent: req.userAgent } : {}),
      ...(req?.remoteIp ? { remoteIp: req.remoteIp } : {}),
    },
  }
}

export function mapLogEntriesToLogEntries(
  entries: LogEntry[],
  projectName: string,
  serviceMap: FirebaseServiceMap,
): NeatLogEntry[] {
  const out: NeatLogEntry[] = []
  for (const entry of entries) {
    const logEntry = mapLogEntryToLogEntry(entry, projectName, serviceMap)
    if (logEntry) out.push(logEntry)
  }
  return out
}

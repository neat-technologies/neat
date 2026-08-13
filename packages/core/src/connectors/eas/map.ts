// EasBuild -> ObservedSignal mapping (ADR-185, connectors.md §10). One signal
// per ERRORED build, each carrying an `incident` payload (not an edge count):
// the shared pipeline writes it as an OBSERVED build-failure incident on the
// node resolve.ts resolves. The firebase/cloud-run mappers turn a log row into a
// counted edge signal; this one turns a build failure into an incident signal —
// the same interface, a different terminal write.

import type { ObservedSignal } from '../types.js'
import type { SpanAttributes } from '@neat.is/types'
import type { EasBuild } from './types.js'
import {
  EAS_STATUS_ERRORED,
  EAS_TARGET_KIND,
  isTransientFailure,
  packEasTargetName,
} from './types.js'

// A build's own event time — completion when it has one, else creation, else
// now. Used as the incident timestamp and the signal's `lastObservedIso` (never
// poll-arrival time, connectors.md §Poll cadence and backfill).
export function buildEventTime(build: EasBuild): string {
  if (typeof build.completedAt === 'string' && build.completedAt.length > 0) return build.completedAt
  if (typeof build.createdAt === 'string' && build.createdAt.length > 0) return build.createdAt
  return new Date().toISOString()
}

// The failure line the incident surface shows: the phase (the structured
// classifier) plus the provider's own `message`, falling back to the free-text
// `errorCode` and then a generic line. A dirty working tree is called out inline
// — the commit may not represent what built (connectors.md §10, guardrail 2).
function incidentMessage(build: EasBuild): string {
  const err = build.error ?? {}
  const phase = typeof err.buildPhase === 'string' && err.buildPhase.length > 0 ? ` at ${err.buildPhase}` : ''
  const detail =
    (typeof err.message === 'string' && err.message.trim().length > 0 && err.message.trim()) ||
    (typeof err.errorCode === 'string' && err.errorCode.length > 0 && err.errorCode) ||
    'no error detail reported'
  let msg = `EAS build failed${phase}: ${detail}`
  if (build.isGitWorkingTreeDirty === true) {
    msg += ' (built from a dirty working tree — the commit may not represent what built)'
  }
  return msg
}

// The provider context an agent reads off the incident. Only fields that are
// actually present land — an absent field is an honest miss, never a guessed
// default. `logsText` is the fetched-and-capped log tail (client.ts).
function incidentAttributes(build: EasBuild): SpanAttributes {
  const attrs: SpanAttributes = {}
  const err = build.error ?? {}
  const put = (k: string, v: string | number | boolean | null | undefined): void => {
    if (typeof v === 'string' && v.length === 0) return
    if (v !== undefined && v !== null) attrs[k] = v
  }
  put('eas.buildId', build.id)
  put('eas.platform', build.platform ?? undefined)
  put('eas.buildProfile', build.buildProfile ?? undefined)
  put('eas.buildPhase', err.buildPhase ?? undefined)
  put('eas.errorCode', err.errorCode ?? undefined)
  put('eas.docsUrl', err.docsUrl ?? undefined)
  put('eas.gitCommitHash', build.gitCommitHash ?? undefined)
  put('eas.gitRef', build.gitRef ?? undefined)
  put('eas.gitCommitMessage', build.gitCommitMessage ?? undefined)
  if (typeof build.isGitWorkingTreeDirty === 'boolean') {
    attrs['eas.gitWorkingTreeDirty'] = build.isGitWorkingTreeDirty
    // A dirty-tree build is lower-confidence — the agent should weight it as such
    // (connectors.md §10, guardrail 2). Surfaced as an attribute since the
    // ErrorEvent shape carries no confidence field of its own.
    if (build.isGitWorkingTreeDirty) attrs['eas.confidence'] = 'low'
  }
  put('eas.createdAt', build.createdAt ?? undefined)
  put('eas.completedAt', build.completedAt ?? undefined)
  if (typeof build.logsText === 'string' && build.logsText.length > 0) {
    attrs['eas.logs'] = build.logsText
  }
  return attrs
}

/**
 * One build -> one incident-bearing signal, or `null` when the connector must
 * mint nothing: a non-ERRORED row (the server filter is never trusted alone,
 * §4), a build with no error object to classify, or a transient/infra failure an
 * EAS outage produces (connectors.md §10, guardrail 1 — never a false repo
 * divergence). `serviceName` is the mapped NEAT service (or the app id when
 * unmapped); it rides the packed target name so resolve.ts scopes the fusion to
 * it, and the incident's `service` field so a service-anchored incident attributes
 * to it.
 */
export function mapBuildToSignal(build: EasBuild | null | undefined, serviceName: string): ObservedSignal | null {
  if (!build || typeof build !== 'object') return null
  if (build.status !== EAS_STATUS_ERRORED) return null
  if (!build.error) return null
  if (isTransientFailure(build.error)) return null

  const timestamp = buildEventTime(build)
  const phase = typeof build.error.buildPhase === 'string' ? build.error.buildPhase : ''

  return {
    targetKind: EAS_TARGET_KIND,
    targetName: packEasTargetName({ serviceName, phase }),
    // Incident-only — no edge, so no call/error count to replay.
    callCount: 0,
    errorCount: 0,
    lastObservedIso: timestamp,
    incident: {
      id: `eas:build:${build.id}`,
      timestamp,
      service: serviceName,
      errorType: 'eas-build-failure',
      errorMessage: incidentMessage(build),
      attributes: incidentAttributes(build),
    },
  }
}

export function mapBuildsToSignals(builds: EasBuild[], serviceName: string): ObservedSignal[] {
  const out: ObservedSignal[] = []
  for (const build of builds) {
    const signal = mapBuildToSignal(build, serviceName)
    if (signal) out.push(signal)
  }
  return out
}

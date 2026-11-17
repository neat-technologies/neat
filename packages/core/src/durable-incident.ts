import type { ErrorEvent } from '@neat.is/types'
import { scrubLedgerRow } from './credential-scrub.js'
import { appendLedgerRecords } from './ledger-write.js'

/** The hosted tenant's snapshot sidecar, on the same Cloud Run instance. */
export const SIDECAR_URL = 'http://127.0.0.1:8081'

/**
 * Hand the sidecar a rewritten copy of the whole incident ledger (neat-infra
 * #273). The sidecar accepts it only when it holds the same records in the same
 * order, then commits it to the archive and renames it into place. Returns the
 * sidecar's HTTP status: 204 accepted, 409 not the same records (the ledger moved
 * underneath), 413 too large to rewrite, anything else a failure.
 */
export async function replaceLedgerViaSidecar(
  project: string,
  ledger: string,
  options: { token: string; fetchImpl?: typeof fetch },
): Promise<number> {
  const response = await (options.fetchImpl ?? fetch)(`${SIDECAR_URL}/ledger-replace`, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ project, ledger }),
    signal: AbortSignal.timeout(60_000),
  })
  return response.status
}

/**
 * Hosted runtime incidents are committed to the local sidecar's encrypted GCS
 * archive before the producer can acknowledge or publish the trigger. The
 * sidecar then appends the same record to the daemon's local ledger. Non-hosted
 * callers keep the existing append-only filesystem path. Either way the record
 * is scrubbed of credential-bearing attributes first (credential-scrub.ts).
 */
export async function appendRuntimeIncident(
  errorsPath: string,
  project: string,
  event: ErrorEvent,
  options: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  // The sink, so the scrub holds for every producer: a connector incident never
  // passed through the span builders that used to apply it.
  event = scrubLedgerRow(event)
  const token = options.token ?? process.env.NEAT_INCIDENT_DURABLE_TOKEN
  if (token !== undefined) {
    if (Buffer.byteLength(token, 'utf8') < 32) throw new Error('durable incident sink unavailable')
    const response = await (options.fetchImpl ?? fetch)(`${SIDECAR_URL}/incident-append`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project, event }),
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status !== 204) throw new Error('durable incident sink unavailable')
    return
  }
  await appendLedgerRecords(errorsPath, [event])
}

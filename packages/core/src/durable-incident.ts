import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ErrorEvent } from '@neat.is/types'
import { scrubIncidentEvent } from './credential-scrub.js'

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
  event = scrubIncidentEvent(event)
  const token = options.token ?? process.env.NEAT_INCIDENT_DURABLE_TOKEN
  if (token !== undefined) {
    if (Buffer.byteLength(token, 'utf8') < 32) throw new Error('durable incident sink unavailable')
    const response = await (options.fetchImpl ?? fetch)('http://127.0.0.1:8081/incident-append', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project, event }),
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status !== 204) throw new Error('durable incident sink unavailable')
    return
  }
  await fs.mkdir(path.dirname(errorsPath), { recursive: true })
  await fs.appendFile(errorsPath, JSON.stringify(event) + '\n', 'utf8')
}

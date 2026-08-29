import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { eventBus, EVENT_BUS_CHANNEL, type NeatEventEnvelope } from '../src/events.js'
import { appendConnectorIncident, type ConnectorIncidentInput } from '../src/ingest.js'

// #1106 / ADR-221: a connector-sourced incident (ADR-185) must fire the same
// `incident` push event OTLP-derived incidents fire, so an agent's monitor wakes
// on a build/poll failure too — but only when the poll caller threaded a project.

describe('connector incident push (#1106)', () => {
  const installed: Array<(e: NeatEventEnvelope) => void> = []
  let tmp = ''
  afterEach(async () => {
    for (const l of installed.splice(0)) eventBus.off(EVENT_BUS_CHANNEL, l)
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  function capture(): NeatEventEnvelope[] {
    const got: NeatEventEnvelope[] = []
    const l = (e: NeatEventEnvelope): void => {
      got.push(e)
    }
    installed.push(l)
    eventBus.on(EVENT_BUS_CHANNEL, l)
    return got
  }

  const base: ConnectorIncidentInput = {
    id: 'eas:build:abc123',
    timestamp: '2026-02-02T00:00:00.000Z',
    service: 'mobile-app',
    errorType: 'eas-build-failure',
    errorMessage: 'build failed: gradle exited 1',
    affectedNode: 'service:mobile-app',
  }

  it('fires an incident event with the connector kind when a project is threaded', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-conn-push-'))
    const errorsPath = path.join(tmp, 'errors.ndjson')
    const events = capture()

    await appendConnectorIncident(errorsPath, base, 'proj-x')

    const incidents = events.filter((e) => e.type === 'incident' && e.project === 'proj-x')
    expect(incidents).toHaveLength(1)
    expect(incidents[0].payload).toMatchObject({
      incidentId: 'eas:build:abc123',
      affectedNode: 'service:mobile-app',
      service: 'mobile-app',
      incidentKind: 'connector',
      at: '2026-02-02T00:00:00.000Z',
    })
    expect(await fs.readFile(errorsPath, 'utf8')).toContain('eas:build:abc123')
  })

  it('writes the ledger but does not push when no project is threaded (back-compat)', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-conn-nopush-'))
    const errorsPath = path.join(tmp, 'errors.ndjson')
    const events = capture()

    await appendConnectorIncident(errorsPath, { ...base, id: 'eas:build:def456' })

    expect(events.filter((e) => e.type === 'incident')).toHaveLength(0)
    expect(await fs.readFile(errorsPath, 'utf8')).toContain('eas:build:def456')
  })
})

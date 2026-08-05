import { describe, it, expect } from 'vitest'
import type {
  DivergenceResult,
  PoliciesViolationsResponse,
  PolicyViolation,
} from '@neat.is/types'
import { runMonitor, type EventsResponse, type OpenEvents } from '../src/monitor.js'
import type { HttpClient } from '../src/cli-client.js'

// Drives the full monitor flow — SSE structural trigger → REST read → one line →
// seen-set dedupe → silent when nothing new — against a scripted SSE source and a
// fixture graph, no live daemon. The transport is injected (openEvents + the REST
// client), so a real `policy-violation` frame and a real `extraction-complete`
// frame run through the same onFrame path production uses.
//
// The fixture graph carries a column-grain drift (missing-extracted at
// orders.amount, ADR-157) and a policy violation (ADR-108). The acceptance bar:
// one clean line for each on the baseline read, dedupe holds on a repeat trigger,
// a genuinely new violation prints once, and the stream is silent otherwise.

const columnDrift: DivergenceResult = {
  divergences: [
    {
      type: 'missing-extracted',
      source: 'sql-table:orders',
      target: 'sql-table:orders',
      table: 'orders',
      column: 'amount',
      confidence: 0.9,
      reason: 'production writes orders.amount',
      recommendation: 'the schema is behind the code',
    },
  ],
  totalAffected: 1,
  computedAt: '2026-08-02T00:00:00.000Z',
}

const violationA: PolicyViolation = {
  id: 'no-web-to-db:service:web',
  policyId: 'no-web-to-db',
  policyName: 'web tier must not touch the database directly',
  severity: 'error',
  onViolation: 'alert',
  ruleType: 'structural',
  subject: { nodeId: 'service:web' },
  message: 'service:web connects straight to database:pg',
  observedAt: '2026-08-02T00:00:00.000Z',
}

const violationB: PolicyViolation = {
  id: 'no-secret-log:file:src/log.ts',
  policyId: 'no-secret-log',
  policyName: 'no secrets in logs',
  severity: 'warn',
  onViolation: 'log',
  ruleType: 'ownership',
  subject: { nodeId: 'file:src/log.ts' },
  message: 'file:src/log.ts logs a credential',
  observedAt: '2026-08-02T00:01:00.000Z',
}

// A ReadableStream a test can enqueue SSE frames into on demand, then close.
function makePushableSse(): {
  stream: ReadableStream<Uint8Array>
  push: (event: string, data: unknown) => void
  close: () => void
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    push: (event, data) =>
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    close: () => controller.close(),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return predicate()
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('neat monitor driven (ADR-162: column drift + policy violation)', () => {
  it('emits one line per fact, dedupes on repeat triggers, and stays silent otherwise', async () => {
    const lines: string[] = []
    // Mutable so a genuinely-new violation can appear mid-session.
    let policyState: PolicyViolation[] = [violationA]

    const httpClient: HttpClient = {
      async get<T>(path: string): Promise<T> {
        if (path === '/graph/divergences') return columnDrift as T
        if (path === '/policies/violations') {
          return { violations: policyState } as PoliciesViolationsResponse as T
        }
        throw new Error(`unexpected GET ${path}`)
      },
    }

    const sse = makePushableSse()
    let opened = 0
    const openEvents: OpenEvents = async (): Promise<EventsResponse> => {
      opened++
      return { ok: true, status: 200, body: sse.stream }
    }

    const done = runMonitor({
      baseUrl: 'http://fixture.invalid',
      project: undefined,
      json: false,
      write: (l) => lines.push(l),
      debounceMs: 5,
      maxReconnects: 0,
      httpClient,
      openEvents,
    })

    // 1. Baseline read on connect → the column drift and violation A, once each.
    const sawBaseline = await waitFor(
      () =>
        lines.some((l) => l.includes('production writes orders.amount')) &&
        lines.some((l) => l.includes('⚠ policy [error]')),
      2000,
    )
    expect(sawBaseline, `baseline facts. lines=${JSON.stringify(lines)}`).toBe(true)
    expect(opened).toBe(1)
    expect(lines.filter((l) => l.includes('orders.amount')).length).toBe(1)
    expect(lines.filter((l) => l.startsWith('⚠ policy')).length).toBe(1)

    // 2. A repeat policy-violation trigger re-reads the same list → nothing new.
    const afterBaseline = lines.length
    sse.push('policy-violation', { violation: violationA })
    await sleep(80)
    expect(lines.length).toBe(afterBaseline)

    // 3. A genuinely new violation appears, then a policy-violation fires → one
    //    new line, the drifting subject named.
    policyState = [violationA, violationB]
    sse.push('policy-violation', { violation: violationB })
    const sawB = await waitFor(() => lines.some((l) => l.includes('no secrets in logs')), 2000)
    expect(sawB, `violation B. lines=${JSON.stringify(lines)}`).toBe(true)
    expect(lines.filter((l) => l.startsWith('⚠ policy')).length).toBe(2)

    // 4. Repeat the trigger with no change → silent.
    const beforeRepeat = lines.length
    sse.push('policy-violation', { violation: violationB })
    await sleep(80)
    expect(lines.length).toBe(beforeRepeat)

    // 5. An extraction-complete re-reads divergences → the same column drift is
    //    already seen, so no new divergence line.
    sse.push('extraction-complete', { project: 'fixture', fileCount: 1 })
    await sleep(80)
    expect(lines.filter((l) => l.includes('⚠ divergence')).length).toBe(1)

    sse.close()
    const code = await done
    expect(code).toBe(0)
  })
})

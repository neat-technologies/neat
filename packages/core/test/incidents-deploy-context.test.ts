import { describe, it, expect } from 'vitest'
import { runIncidents, type HttpClient } from '../src/cli-client.js'

// `neat incidents` reads a faulted workload's deploy context off the workload node
// (ADR-243), not off the incident. Scenario 414's answer came from this surface: the
// wrong neo4j host in the recommendation container's env.
const svc = 'service:recommendation'
const crash = {
  id: 'k8s:deploy:otel-demo:recommendation:crash-loop',
  timestamp: '2026-10-11T10:00:00.000Z',
  service: 'recommendation',
  traceId: '',
  spanId: '',
  errorType: 'k8s-deploy-failure',
  errorMessage: 'Deployment recommendation is crashlooping (restarts: 6)',
  affectedNode: svc,
  attributes: { 'k8s.namespace': 'otel-demo', 'k8s.deployment': 'recommendation' },
}
const http500 = { ...crash, id: 't9:s9', errorMessage: 'HTTP 500', errorType: 'http-failure' }
const node = {
  id: svc,
  type: 'ServiceNode',
  name: 'recommendation',
  observedDeployContext: {
    incidentId: crash.id,
    observedAt: crash.timestamp,
    fault: 'crash-loop',
    waitingReason: 'CrashLoopBackOff',
    restartCount: 6,
    exitCode: 1,
    containerEnv: ['NEO4J_PRODUCT_DATABASE_ENDPOINT=master-neo4j-productdb:7979', 'DB_PASSWORD=***REDACTED***'],
    processLog: 'Traceback\nsocket.gaierror: [Errno -3] Temporary failure in name resolution',
  },
}

const client = (opts: { nodeFails?: boolean } = {}): HttpClient => ({
  async get<T>(path: string): Promise<T> {
    if (path.includes('/incidents/')) return { count: 2, total: 2, events: [http500, crash] } as T
    if (path.includes('/graph/node/')) {
      if (opts.nodeFails) throw new Error('unreachable')
      return { node } as T
    }
    throw new Error(`unexpected ${path}`)
  },
})

describe('neat incidents — deploy context from the workload node (ADR-243)', () => {
  it('shows the wrong host, the fault and the log tail on the incident it was observed with', async () => {
    const out = await runIncidents(client(), { nodeId: svc })
    const block = out.block ?? ''
    expect(block).toContain('deploy: crash-loop CrashLoopBackOff restarts=6 exit=1')
    expect(block).toContain('NEO4J_PRODUCT_DATABASE_ENDPOINT=master-neo4j-productdb:7979')
    expect(block).toContain('DB_PASSWORD=***REDACTED***')
    expect(block).toContain('log: Traceback ⏎ socket.gaierror')
    // Only under the crash-loop incident, not the unrelated 500 on the same service.
    // Most recent first: the crash-loop event, then the 500, which gets nothing.
    expect(block.indexOf('crashlooping')).toBeLessThan(block.indexOf('HTTP 500'))
    const http500Section = block.slice(block.indexOf('HTTP 500'))
    expect(http500Section).toContain('HTTP 500')
    expect(http500Section).not.toContain('deploy:')
    expect(http500Section).not.toContain('NEO4J')
  })

  it('still lists the incidents when the node read fails', async () => {
    const out = await runIncidents(client({ nodeFails: true }), { nodeId: svc })
    expect(out.block).toContain('crashlooping')
    expect(out.block).not.toContain('deploy:')
  })
})

import { describe, it, expect } from 'vitest'
import { deployContextsFor, deployHintLines } from '../src/incidents-render.js'
import type { ErrorEvent } from '@neat.is/types'

function ev(id: string, affectedNode = 'service:recommendation'): ErrorEvent {
  return {
    id,
    timestamp: '2026-05-01T16:00:00.000Z',
    service: 'recommendation',
    traceId: 't',
    spanId: 's',
    errorMessage: 'boom',
    affectedNode,
  } as ErrorEvent
}

describe('deployHintLines — the one shared incident deploy-context renderer', () => {
  it('returns [] when there is no context', () => {
    expect(deployHintLines(undefined)).toEqual([])
    expect(deployHintLines({})).toEqual([])
  })

  it('renders the fault, env, args and a bounded log tail', () => {
    const lines = deployHintLines({
      fault: 'crash-loop',
      restartCount: 7,
      containerEnv: ['NEO4J_PRODUCT_DATABASE_ENDPOINT=master-neo4j-productdb:7979'],
      containerArgs: ['--serve'],
      processLog: 'line1\nline2\nline3\nline4\nline5',
    })
    expect(lines[0]).toContain('deploy: crash-loop')
    expect(lines[0]).toContain('restarts=7')
    expect(
      lines.some((l) => l.includes('env: NEO4J_PRODUCT_DATABASE_ENDPOINT=master-neo4j-productdb:7979')),
    ).toBe(true)
    expect(lines.some((l) => l.startsWith('args: --serve'))).toBe(true)
    // The log keeps only the last four non-empty lines.
    const logLine = lines.find((l) => l.startsWith('log: '))!
    expect(logLine).toContain('line5')
    expect(logLine).not.toContain('line1')
  })
})

describe('deployContextsFor — the deploy context read off each workload node', () => {
  const observed = {
    incidentId: 'k8s:recommendation:1',
    observedAt: '2026-05-01T16:00:00.000Z',
    fault: 'crash-loop',
    containerEnv: ['NEO4J_PRODUCT_DATABASE_ENDPOINT=master-neo4j-productdb:7979'],
  }

  it('keys the context by the incident it was observed with, one read per node', async () => {
    const reads: string[] = []
    const contexts = await deployContextsFor(
      [ev('k8s:recommendation:1'), ev('otel:older'), ev('k8s:cart:1', 'service:cart')],
      async (nodeId) => {
        reads.push(nodeId)
        return nodeId === 'service:recommendation' ? { observedDeployContext: observed } : {}
      },
    )
    expect(reads).toEqual(['service:recommendation', 'service:cart'])
    expect([...contexts.keys()]).toEqual(['k8s:recommendation:1'])
    const ctx = contexts.get('k8s:recommendation:1')!
    expect(ctx.containerEnv).toEqual(observed.containerEnv)
    // The node-only bookkeeping does not ride into the rendered context.
    expect(ctx).not.toHaveProperty('incidentId')
    expect(ctx).not.toHaveProperty('observedAt')
  })

  it('renders without context when a node read fails', async () => {
    const contexts = await deployContextsFor([ev('k8s:recommendation:1')], async () => {
      throw new Error('404')
    })
    expect(contexts.size).toBe(0)
  })
})

import { describe, it, expect } from 'vitest'
import { deployHintLines } from '../src/incidents-render.js'
import type { ErrorEvent } from '@neat.is/types'

function ev(attributes?: Record<string, unknown>): ErrorEvent {
  return {
    id: 't:s',
    timestamp: '2026-05-01T16:00:00.000Z',
    service: 'recommendation',
    traceId: 't',
    spanId: 's',
    errorMessage: 'boom',
    affectedNode: 'service:recommendation',
    ...(attributes ? { attributes } : {}),
  } as ErrorEvent
}

describe('deployHintLines — the one shared incident deploy-context renderer', () => {
  it('returns [] for a non-k8s incident', () => {
    expect(deployHintLines(ev())).toEqual([])
    expect(deployHintLines(ev({ 'http.method': 'GET' }))).toEqual([])
  })

  it('renders the fault, env, args and a bounded log tail', () => {
    const lines = deployHintLines(
      ev({
        'k8s.fault': 'crash-loop',
        'k8s.restartCount': 7,
        'k8s.containerEnv': ['NEO4J_PRODUCT_DATABASE_ENDPOINT=master-neo4j-productdb:7979'],
        'k8s.containerArgs': ['--serve'],
        'k8s.processLog': 'line1\nline2\nline3\nline4\nline5',
      }),
    )
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

import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { InfraNode, ServiceNode } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'infra')

describe('Supabase project extraction (platform tag)', () => {
  beforeEach(() => resetGraph())

  it('tags the ServiceNode with platform: supabase and platformName from project_id', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'supabase'))
    const service = graph.getNodeAttributes('service:supabase-app') as ServiceNode
    expect(service.platform).toBe('supabase')
    expect(service.platformName).toBe('shop-backend')
  })

  it('emits a supabase runtime node + RUNS_ON edge from the service', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'supabase'))
    const runtimeId = 'infra:supabase:supabase'
    expect(graph.hasNode(runtimeId)).toBe(true)
    expect((graph.getNodeAttributes(runtimeId) as InfraNode).provider).toBe('supabase')
    expect(graph.hasEdge(`RUNS_ON:service:supabase-app->${runtimeId}`)).toBe(true)
  })

  it('each [functions.X] section becomes a supabase-function InfraNode wired DEPENDS_ON', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'supabase'))
    for (const fn of ['send-email', 'process-webhook']) {
      const id = `infra:supabase-function:${fn}`
      expect(graph.hasNode(id)).toBe(true)
      expect(graph.hasEdge(`DEPENDS_ON:service:supabase-app->${id}`)).toBe(true)
    }
  })

  it('declared storage and auth surfaces become DEPENDS_ON InfraNodes', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'supabase'))
    expect(graph.hasNode('infra:supabase-storage:storage')).toBe(true)
    expect(graph.hasNode('infra:supabase-auth:auth')).toBe(true)
  })
})

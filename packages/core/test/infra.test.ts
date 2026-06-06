import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, InfraNode } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'infra')

describe('infrastructure extraction', () => {
  beforeEach(() => resetGraph())

  it('docker-compose: emits InfraNodes for non-service entries + DEPENDS_ON edges', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'compose'))

    expect(graph.hasNode('service:fixture-web')).toBe(true)
    expect(graph.hasNode('infra:postgres:postgres')).toBe(true)
    expect(graph.hasNode('infra:redis:cache')).toBe(true)

    const postgres = graph.getNodeAttributes('infra:postgres:postgres') as InfraNode
    expect(postgres.kind).toBe('postgres')
    expect(postgres.provider).toBe('self')

    const dependsPg = 'DEPENDS_ON:service:fixture-web->infra:postgres:postgres'
    const dependsRedis = 'DEPENDS_ON:service:fixture-web->infra:redis:cache'
    expect(graph.hasEdge(dependsPg)).toBe(true)
    expect(graph.hasEdge(dependsRedis)).toBe(true)
  })

  it('Dockerfile: emits container-image InfraNode + RUNS_ON edge', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'dockerfile'))

    expect(graph.hasNode('infra:container-image:node:20')).toBe(true)
    const image = graph.getNodeAttributes('infra:container-image:node:20') as InfraNode
    expect(image.kind).toBe('container-image')

    // file-awareness §1 — RUNS_ON originates from the FileNode for Dockerfile
    const fileNodeId = 'file:fixture-api:Dockerfile'
    expect(graph.hasNode(fileNodeId)).toBe(true)
    const edgeId = `RUNS_ON:${fileNodeId}->infra:container-image:node:20`
    expect(graph.hasEdge(edgeId)).toBe(true)
    const edge = graph.getEdgeAttributes(edgeId) as GraphEdge
    expect(edge.type).toBe('RUNS_ON')
  })

  it('terraform: catalogues aws_* resources as InfraNodes', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'terraform'))

    const bucket = graph.getNodeAttributes('infra:aws_s3_bucket:uploads') as InfraNode
    expect(bucket.kind).toBe('aws_s3_bucket')
    expect(bucket.provider).toBe('aws')

    const table = graph.getNodeAttributes('infra:aws_dynamodb_table:orders') as InfraNode
    expect(table.kind).toBe('aws_dynamodb_table')
  })

  it('k8s: catalogues Service + Deployment manifests as InfraNodes', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.join(FIXTURES, 'k8s'))

    const svc = graph.getNodeAttributes('infra:k8s-service:default/web') as InfraNode
    expect(svc.kind).toBe('k8s-service')
    expect(svc.provider).toBe('kubernetes')

    const deploy = graph.getNodeAttributes('infra:k8s-deployment:default/web') as InfraNode
    expect(deploy.kind).toBe('k8s-deployment')
  })
})

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, beforeEach } from 'vitest'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  fileId,
  observedEdgeId,
  routeId,
  serviceId,
  symbolId,
} from '@neat.is/types'
import { extractFromDirectory } from '../src/extract.js'
import { getGraph, resetGraph } from '../src/graph.js'
import { handleSpan, type IngestContext } from '../src/ingest.js'
import { javascriptInstaller } from '../src/installers/javascript.js'
import type { ParsedSpan } from '../src/otel.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'nestjs-baseline')
const SERVICE = 'nestjs-api'

function span(overrides: Partial<ParsedSpan>): ParsedSpan {
  return {
    service: SERVICE,
    traceId: 'nest-trace',
    spanId: 'nest-span',
    name: 'nest request',
    startTimeUnixNano: '0',
    endTimeUnixNano: '0',
    durationNanos: 0n,
    env: 'unknown',
    attributes: {},
    statusCode: 0,
    ...overrides,
  }
}

describe('NestJS compatibility (ADR-155)', () => {
  beforeEach(() => resetGraph())

  it('extracts decorator routes with controller prefixes, aliases, arrays, params, and honest computed-path omission', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)

    const users = routeId(SERVICE, 'GET', '/users/:id')
    const members = routeId(SERVICE, 'GET', '/members/:id')
    expect(graph.hasNode(users)).toBe(true)
    expect(graph.hasNode(members)).toBe(true)
    expect(graph.getNodeAttributes(users)).toMatchObject({
      type: NodeType.RouteNode,
      framework: 'nestjs',
      path: 'src/users.controller.ts',
      pathTemplate: '/users/:id',
    } satisfies Partial<RouteNode>)

    expect(graph.hasNode(routeId(SERVICE, 'POST', '/users'))).toBe(true)
    expect(graph.hasNode(routeId(SERVICE, 'POST', '/members'))).toBe(true)
    expect(graph.hasNode(routeId(SERVICE, 'ALL', '/users/health'))).toBe(true)
    expect(graph.hasNode(routeId(SERVICE, 'ALL', '/members/ready'))).toBe(true)
    expect(graph.hasNode(routeId(SERVICE, 'GET', '/users/computed'))).toBe(false)

    const service = graph.getNodeAttributes(serviceId(SERVICE))
    expect(service).toMatchObject({ framework: 'nestjs', language: 'typescript' })
  })

  it('uses the existing vanilla Node installer to instrument the conventional Nest entry point', async () => {
    const plan = await javascriptInstaller.plan(FIXTURE)
    expect(plan.framework).toBeUndefined()
    expect(plan.libOnly).not.toBe(true)
    expect(plan.entrypointEdits.map((edit) => edit.file)).toContain(
      path.join(FIXTURE, 'src/main.ts'),
    )
    expect((plan.generatedFiles ?? []).map((file) => file.file)).toContain(
      path.join(FIXTURE, 'src/otel-init.ts'),
    )
    const hook = plan.generatedFiles?.find((file) => file.file.endsWith('otel-init.ts'))
    expect(hook?.contents).toContain("require('@opentelemetry/sdk-node')")
    expect(hook?.contents).not.toContain('await import(')
    expect(plan.dependencyEdits.map((edit) => edit.name)).toEqual(
      expect.arrayContaining([
        '@opentelemetry/api',
        '@opentelemetry/sdk-node',
        '@opentelemetry/auto-instrumentations-node',
      ]),
    )
  })

  it('fuses runtime-shaped Nest route and call-site spans onto the extracted RouteNode and FileNode', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURE)
    const ctx: IngestContext = {
      graph,
      scanPath: FIXTURE,
      errorsPath: path.join(FIXTURE, 'neat-out', 'errors.ndjson'),
    }

    const routeNode = routeId(SERVICE, 'GET', '/users/:id')
    const controllerFile = fileId(SERVICE, 'src/users.controller.ts')
    expect(graph.hasNode(routeNode)).toBe(true)
    expect(graph.hasNode(controllerFile)).toBe(true)

    await handleSpan(
      ctx,
      span({
        spanId: 'nest-server',
        name: 'GET /users/:id',
        kind: 2,
        httpRoute: '/users/:id',
        httpMethod: 'GET',
        attributes: {
          'http.route': '/users/:id',
          'http.request.method': 'GET',
        },
      }),
    )
    await handleSpan(
      ctx,
      span({
        spanId: 'nest-client',
        name: 'GET inventory.internal',
        kind: 3,
        attributes: {
          'server.address': 'inventory.internal',
          'code.file.path': path.join(FIXTURE, 'src/users.controller.ts'),
          'code.line.number': 9,
          'code.function.name': 'UsersController.findOne',
        },
      }),
    )

    const observedRouteEdge = observedEdgeId(serviceId(SERVICE), routeNode, EdgeType.CONTAINS)
    expect(graph.hasEdge(observedRouteEdge)).toBe(true)
    expect((graph.getEdgeAttributes(observedRouteEdge) as GraphEdge).provenance).toBe(
      Provenance.OBSERVED,
    )

    // The call-site landed one grain finer than the file: on the calling symbol
    // `UsersController.findOne`, whose definition span contains line 9 (ADR-158).
    // `code.function.name` on the span already named it; ingest now lands the
    // edge there instead of dropping the function at the file.
    const findOneSymbol = symbolId(SERVICE, 'src/users.controller.ts', 'UsersController.findOne')
    const observedFromController = graph
      .edges()
      .map((id) => graph.getEdgeAttributes(id) as GraphEdge)
      .filter((edge) => edge.source === findOneSymbol && edge.provenance === Provenance.OBSERVED)
    expect(observedFromController).toHaveLength(1)
    expect(observedFromController[0]).toMatchObject({
      type: EdgeType.CALLS,
      grain: 'file',
      evidence: { file: 'src/users.controller.ts', line: 9 },
    })

    // The symbol is owned by the controller file it was extracted from.
    expect(graph.hasNode(findOneSymbol)).toBe(true)
    const ownedByFile = graph
      .inboundEdges(findOneSymbol)
      .map((id) => graph.getEdgeAttributes(id) as GraphEdge)
      .some((edge) => edge.type === EdgeType.CONTAINS && edge.source === controllerFile)
    expect(ownedByFile).toBe(true)

    const routeTwins: string[] = []
    const fileTwins: string[] = []
    graph.forEachNode((id, attrs) => {
      if ((attrs as { type: string }).type === NodeType.RouteNode) {
        const route = attrs as RouteNode
        if (route.method === 'GET' && route.pathTemplate === '/users/:id') routeTwins.push(id)
      }
      if (
        (attrs as { type: string }).type === NodeType.FileNode &&
        (attrs as { path?: string }).path === 'src/users.controller.ts'
      ) {
        fileTwins.push(id)
      }
    })
    expect(routeTwins).toEqual([routeNode])
    expect(fileTwins).toEqual([controllerFile])
  })
})

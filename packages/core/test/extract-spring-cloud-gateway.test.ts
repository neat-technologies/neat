import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory, type ExtractResult } from '../src/extract.js'
import { gatewayRoutesFromYaml } from '../src/extract/java-gateway.js'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, serviceId } from '@neat.is/types'

// Spring Cloud Gateway: the front door's routing table is application.yml. Each
// route's Path patterns become gateway RouteNodes and the config file CALLS the
// service its `uri` names. The fixture is train-ticket's ts-gateway-service.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'java-spring-train-ticket')

describe('gatewayRoutesFromYaml', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-gw-'))
    await fs.writeFile(path.join(dir, '.env'), 'USERS_HOST=ts-user-service\n')
  })

  it('reads both predicate forms, a Method predicate, and resolves the uri host', async () => {
    const routes = await gatewayRoutesFromYaml(
      `spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://\${ORDER_HOST:ts-order-service}
          predicates:
            - Path=/api/v1/orders/**,/api/v2/orders/**
            - Method=GET,POST
        - id: users
          uri: http://\${USERS_HOST:fallback}:8080
          predicates:
            - name: Path
              args:
                patterns: /api/v1/users/**
`,
      dir,
    )
    expect(routes.map((r) => ({ host: r.host, paths: r.paths, methods: r.methods, line: r.line }))).toEqual([
      { host: 'ts-order-service', paths: ['/api/v1/orders/**', '/api/v2/orders/**'], methods: ['GET', 'POST'], line: 8 },
      { host: 'ts-user-service', paths: ['/api/v1/users/**'], methods: ['ALL'], line: 13 },
    ])
  })

  it('reads the newer webflux key, skips profile documents, and leaves a host with no default unresolved', async () => {
    const routes = await gatewayRoutesFromYaml(
      `spring.cloud.gateway.server.webflux.routes:
  - uri: lb://\${NO_DEFAULT}
    predicates: [Path=/x/**]
---
spring:
  config.activate.on-profile: dev
  cloud.gateway.routes:
    - uri: lb://dev-only
      predicates: [Path=/dev/**]
`,
      dir,
    )
    expect(routes.map((r) => ({ host: r.host, paths: r.paths }))).toEqual([{ host: null, paths: ['/x/**'] }])
  })
})

describe('Spring Cloud Gateway from train-ticket (extractFromDirectory)', () => {
  let result: ExtractResult
  const configFile = 'file:ts-gateway-service:src/main/resources/application.yml'
  beforeAll(async () => {
    resetGraph()
    result = await extractFromDirectory(getGraph(), FIXTURE, { announce: false })
  })

  it('mints a gateway route for each of the 39 routes, with file:line', () => {
    const routes: RouteNode[] = []
    getGraph().forEachNode((_id, a) => {
      const r = a as RouteNode
      if (r.type === NodeType.RouteNode && r.service === 'ts-gateway-service') routes.push(r)
    })
    expect(routes).toHaveLength(39)
    expect(routes.find((r) => r.pathTemplate === '/api/v1/orderservice/**')).toMatchObject({
      method: 'ALL',
      framework: 'spring-cloud-gateway',
      path: 'src/main/resources/application.yml',
      line: 119,
    })
  })

  it('links the config file to each routed service that is in the graph', () => {
    for (const svc of ['ts-order-service', 'ts-preserve-service']) {
      const edge = getGraph().getEdgeAttributes(`${EdgeType.CALLS}:${configFile}->${serviceId(svc)}`) as GraphEdge
      expect(edge.provenance).toBe(Provenance.EXTRACTED)
    }
    // The other 36 targets aren't in this fixture, so they get no edge, and
    // every uri resolved, so nothing was dropped.
    let calls = 0
    getGraph().forEachOutEdge(configFile, (_e, a) => {
      if ((a as GraphEdge).type === EdgeType.CALLS) calls++
    })
    expect(calls).toBe(2)
    expect(result.droppedEntries.filter((d) => d.target === 'service:unresolved')).toHaveLength(0)
    expect(result.extractionErrors).toBe(0)
  })
})

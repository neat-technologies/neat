import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { makeJavaParser, springRoutesFromSource } from '../src/extract/java-routes.js'
import type { GraphEdge, RouteNode } from '@neat.is/types'
import { EdgeType, NodeType, Provenance, extractedEdgeId, routeId, serviceId } from '@neat.is/types'

// Spring MVC route extraction. train-ticket's services (SREGym) are Spring Boot:
// each controller has a class-level @RequestMapping prefix and verb-mapped
// handler methods. The fixture keeps the real shape where `spring-boot-starter-web`
// comes from the parent POM, not the service's own.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'java-spring-train-ticket')

const tuples = (source: string): string[] =>
  springRoutesFromSource(source, makeJavaParser()).map((r) => `${r.method} ${r.pathTemplate}`)

describe('springRoutesFromSource', () => {
  it('composes the class prefix with each verb mapping', () => {
    const got = tuples(`
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/v1/x")
public class C {
  @GetMapping("/a/{id}") public Object a() { return null; }
  @PostMapping(value = "b") public Object b() { return null; }
  @PutMapping public Object c() { return null; }
  @DeleteMapping(path = "/d/") public Object d() { return null; }
  @PatchMapping(path = {"/e", "/f"}) public Object e() { return null; }
}`)
    expect(got).toEqual([
      'GET /api/v1/x/a/{id}',
      'POST /api/v1/x/b',
      'PUT /api/v1/x',
      'DELETE /api/v1/x/d',
      'PATCH /api/v1/x/e',
      'PATCH /api/v1/x/f',
    ])
  })

  it('reads @RequestMapping methods, and ALL when none is named', () => {
    const got = tuples(`
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
@Controller
class C {
  @RequestMapping(value = "/one", method = RequestMethod.GET) void one() {}
  @RequestMapping(path = "/two", method = {RequestMethod.POST, RequestMethod.PUT}) void two() {}
  @RequestMapping("/any") void any() {}
}`)
    expect(got).toEqual(['GET /one', 'POST /two', 'PUT /two', 'ALL /any'])
  })

  it('resolves static final String constants and skips a path it cannot resolve', () => {
    const got = tuples(`
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping(Paths.ROOT)
class Unresolved { @GetMapping("/x") void x() {} }
@RestController
@RequestMapping(Api.BASE)
class AlsoUnresolved { @GetMapping("/y") void y() {} }
@RestController
class C {
  static final String BASE = "/api";
  private static final String ORDERS = BASE + "/orders";
  @GetMapping(ORDERS + "/{id}") void get() {}
  @GetMapping(somethingComputed()) void skipped() {}
}`)
    expect(got).toEqual(['GET /api/orders/{id}'])
  })

  it('never reads a @FeignClient interface or a file without Spring web', () => {
    expect(
      tuples(`
import org.springframework.web.bind.annotation.*;
@FeignClient("ts-order-service")
interface OrderClient { @GetMapping("/api/v1/orderservice/order") Object list(); }`),
    ).toEqual([])
    expect(
      tuples(`
@RestController
class C { @GetMapping("/x") void x() {} }`),
    ).toEqual([])
  })

  it('accepts a fully qualified annotation without the import', () => {
    expect(
      tuples(`
@org.springframework.web.bind.annotation.RestController
class C { @org.springframework.web.bind.annotation.GetMapping("/q") void q() {} }`),
    ).toEqual(['GET /q'])
  })

  it('gives a nested controller its own prefix', () => {
    const got = tuples(`
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/outer")
class Outer {
  @GetMapping("/a") void a() {}
  @RestController @RequestMapping("/inner")
  static class Inner { @GetMapping("/b") void b() {} }
}`)
    expect(got).toEqual(['GET /outer/a', 'GET /inner/b'])
  })
})

describe('Spring routes from train-ticket (extractFromDirectory)', () => {
  let routes: RouteNode[]
  beforeAll(async () => {
    resetGraph()
    await extractFromDirectory(getGraph(), FIXTURE, { announce: false })
    routes = []
    getGraph().forEachNode((_id, a) => {
      if ((a as RouteNode).type === NodeType.RouteNode) routes.push(a as RouteNode)
    })
  })

  it('mints every handler route of both services, prefixed, with file:line', () => {
    const order = routes.filter((r) => r.service === 'ts-order-service')
    const preserve = routes.filter((r) => r.service === 'ts-preserve-service')
    // 16 handlers in OrderController, 2 in PreserveController.
    expect(order).toHaveLength(16)
    expect(preserve).toHaveLength(2)
    expect(routes.every((r) => r.framework === 'spring' && r.discoveredVia === 'static')).toBe(true)

    const r = order.find((x) => x.name === 'GET /api/v1/orderservice/order/{travelDate}/{trainNumber}')
    expect(r).toMatchObject({
      method: 'GET',
      pathTemplate: '/api/v1/orderservice/order/{travelDate}/{trainNumber}',
      path: 'src/main/java/order/controller/OrderController.java',
      line: 73,
    })
    expect(preserve.map((x) => x.name).sort()).toEqual([
      'GET /api/v1/preserveservice/welcome',
      'POST /api/v1/preserveservice/preserve',
    ])
  })

  it('owns each route from its service with an EXTRACTED CONTAINS edge', () => {
    const svc = serviceId('ts-order-service')
    const rid = routeId('ts-order-service', 'DELETE', '/api/v1/orderservice/order/{orderId}')
    const edge = getGraph().getEdgeAttributes(extractedEdgeId(svc, rid, EdgeType.CONTAINS)) as GraphEdge
    expect(edge.provenance).toBe(Provenance.EXTRACTED)
    expect(edge.evidence).toMatchObject({ file: 'src/main/java/order/controller/OrderController.java', line: 142 })
  })
})

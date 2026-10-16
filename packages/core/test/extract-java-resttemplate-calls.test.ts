import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Parser from 'tree-sitter'
import Java from 'tree-sitter-java'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory, type ExtractResult } from '../src/extract.js'
import { javaCallSitesFromSource } from '../src/extract/java-calls.js'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance, routeId, serviceId } from '@neat.is/types'

// Java outbound HTTP through RestTemplate / WebClient. train-ticket's services
// call each other as `restTemplate.exchange(getServiceUrl("ts-x") + "/api/…",
// HttpMethod.POST, …)`, where getServiceUrl returns "http://" + name; the URL
// is evaluated from literals, constants, locals and that helper.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'java-spring-train-ticket')

function sites(source: string) {
  const p = new Parser()
  p.setLanguage(Java)
  return javaCallSitesFromSource(source, p).map((s) => ({
    method: s.method,
    host: s.host,
    path: s.pathTemplate,
    approximate: s.approximate,
  }))
}

const HEADER = `
import org.springframework.web.client.RestTemplate;
import org.springframework.http.HttpMethod;
`

describe('javaCallSitesFromSource', () => {
  it('reads a literal URL with a port, and the verb from each RestTemplate method', () => {
    expect(
      sites(`${HEADER}
class C {
  private RestTemplate restTemplate;
  void a() {
    restTemplate.getForObject("http://ts-order-service:12031/api/v1/orderservice/order/" + id, String.class);
    restTemplate.postForObject("http://ts-order-service:12031/api/v1/orderservice/order", body, String.class);
    this.restTemplate.delete("http://ts-order-service/api/v1/orderservice/order/42");
  }
}`),
    ).toEqual([
      { method: 'GET', host: 'ts-order-service', path: '/api/v1/orderservice/order/:param', approximate: true },
      { method: 'POST', host: 'ts-order-service', path: '/api/v1/orderservice/order', approximate: false },
      { method: 'DELETE', host: 'ts-order-service', path: '/api/v1/orderservice/order/42', approximate: false },
    ])
  })

  it("resolves train-ticket's getServiceUrl helper through a local, with exchange's method", () => {
    expect(
      sites(`${HEADER}
class C {
  @Autowired private RestTemplate restTemplate;
  private String getServiceUrl(String serviceName) { return "http://" + serviceName; }
  void a() {
    String order_service_url = getServiceUrl("ts-order-service");
    restTemplate.exchange(order_service_url + "/api/v1/orderservice/order", HttpMethod.POST, entity, T.class);
  }
}`),
    ).toEqual([{ method: 'POST', host: 'ts-order-service', path: '/api/v1/orderservice/order', approximate: false }])
  })

  it('resolves static final constants and a WebClient verb chain', () => {
    expect(
      sites(`
import org.springframework.web.reactive.function.client.WebClient;
class C {
  static final String BASE = "http://ts-user-service:12342";
  private WebClient client;
  void a() { client.get().uri(BASE + "/api/v1/userservice/users").retrieve(); }
  void b() { client.method(HttpMethod.PUT).uri(BASE + "/x").retrieve(); }
}`),
    ).toEqual([
      { method: 'GET', host: 'ts-user-service', path: '/api/v1/userservice/users', approximate: false },
      { method: 'PUT', host: 'ts-user-service', path: '/x', approximate: false },
    ])
  })

  it('leaves the host unknown when it is injected or picked by a branch', () => {
    const got = sites(`${HEADER}
class C {
  private RestTemplate restTemplate;
  @Value("\${orders.url}") private String ordersUrl;
  void a() { restTemplate.getForObject(ordersUrl + "/orders", String.class); }
  void b(boolean g) {
    String url;
    if (g) { url = "http://ts-travel-service/trips"; } else { url = "http://ts-travel2-service/trips"; }
    restTemplate.exchange(url, HttpMethod.POST, e, T.class);
  }
}`)
    expect(got.map((s) => s.host)).toEqual([null, null])
  })

  it('never reads put/delete on something that is not a RestTemplate', () => {
    expect(
      sites(`${HEADER}
class C {
  private RestTemplate restTemplate;
  void a() { java.util.HashMap<String, String> prices = new java.util.HashMap<>(); prices.put("http://ts-x/", "1"); repo.delete("http://ts-x/y"); }
}`),
    ).toEqual([])
  })
})

describe('Java calls from train-ticket (extractFromDirectory)', () => {
  let result: ExtractResult
  const file = 'file:ts-preserve-service:src/main/java/preserve/service/PreserveServiceImpl.java'
  beforeAll(async () => {
    resetGraph()
    result = await extractFromDirectory(getGraph(), FIXTURE, { announce: false })
  })

  it('links the calling file to the service it names', () => {
    const edge = getGraph().getEdgeAttributes(`${EdgeType.CALLS}:${file}->${serviceId('ts-order-service')}`) as GraphEdge
    expect(edge.provenance).toBe(Provenance.EXTRACTED)
    expect(edge.evidence).toMatchObject({ line: 396, method: 'POST', pathTemplate: '/api/v1/orderservice/order' })
  })

  it('lands the call on the route it names when the target declares it', () => {
    const rid = routeId('ts-order-service', 'POST', '/api/v1/orderservice/order')
    const edge = getGraph().getEdgeAttributes(`${EdgeType.CALLS}:${file}->${rid}`) as GraphEdge
    expect(edge.provenance).toBe(Provenance.EXTRACTED)
    expect(edge.confidence).toBeGreaterThanOrEqual(0.85)
  })

  it('makes no edge to a service outside the graph, and claims no unresolved host', () => {
    // preserve calls a dozen services; only ts-order-service is in this fixture.
    const targets = new Set<string>()
    getGraph().forEachOutEdge(file, (_e, a) => {
      if ((a as GraphEdge).type === EdgeType.CALLS) targets.add((a as GraphEdge).target)
    })
    expect([...targets].every((t) => t.includes('ts-order-service'))).toBe(true)
    expect(result.extractionErrors).toBe(0)
  })
})

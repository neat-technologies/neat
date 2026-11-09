import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge } from '@neat.is/types'
import { EdgeType, Provenance } from '@neat.is/types'

// Java symbol→symbol CALLS (ADR-158 §3, the Java rung): same-file, and only when
// the callee resolves to exactly one method.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'java-spring-train-ticket')

// "caller -> callee" for every Java symbol CALLS in the graph, by simple name.
function calls(): string[] {
  const out: string[] = []
  getGraph().forEachEdge((_id, a) => {
    const e = a as GraphEdge
    if (e.type !== EdgeType.CALLS || !e.source.startsWith('symbol:') || !e.target.startsWith('symbol:')) return
    out.push(`${e.source.split('.').pop()} -> ${e.target.split('.').pop()}`)
  })
  return out.sort()
}

describe('Java symbol CALLS', () => {
  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-javasym-'))
    await fs.writeFile(path.join(dir, 'pom.xml'), '<project><artifactId>svc</artifactId></project>')
    await fs.mkdir(path.join(dir, 'src', 'main', 'java', 'a'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'src', 'main', 'java', 'a', 'Svc.java'),
      `package a;
public class Svc extends Base {
  private Repo repo;
  public void run() {
    helper();
    this.other();
    Util.format("x");
    over(1);
    inherited();
    repo.save();
    new Thread(new Runnable() { public void run() { helper(); } });
  }
  void helper() {}
  void other() {}
  void over(int a) {}
  void over(String a) {}
}
class Util {
  static String format(String s) { return s; }
}
`,
    )
    resetGraph()
    await extractFromDirectory(getGraph(), dir, { announce: false })
  })

  it('resolves unqualified, this. and same-file Type. calls, and nothing else', () => {
    // over(): overloaded. inherited(): not declared here. repo.save(): needs the
    // receiver's type. helper() inside the anonymous Runnable: its own run() shadows.
    expect(calls()).toEqual(['run -> format', 'run -> helper', 'run -> other'])
  })
})

describe('Java symbol CALLS on train-ticket (extractFromDirectory)', () => {
  beforeAll(async () => {
    resetGraph()
    await extractFromDirectory(getGraph(), FIXTURE, { announce: false })
  })

  it("links preserve's createConsign to its getServiceUrl helper", () => {
    const file = 'src/main/java/preserve/service/PreserveServiceImpl.java'
    let edge: GraphEdge | undefined
    getGraph().forEachEdge((_id, a) => {
      const e = a as GraphEdge
      if (e.type === EdgeType.CALLS && e.source.endsWith('.createConsign') && e.target.endsWith('.getServiceUrl')) edge = e
    })
    expect(edge?.provenance).toBe(Provenance.EXTRACTED)
    expect(edge?.evidence).toMatchObject({ file, line: 424 })
  })
})

describe('Java symbol CALLS through typed receivers and interfaces (ADR-257)', () => {
  beforeAll(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-javatyped-'))
    const write = async (rel: string, content: string) => {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
      await fs.writeFile(path.join(root, rel), content)
    }
    await write('orders/pom.xml', '<project><artifactId>orders</artifactId></project>')
    const j = 'orders/src/main/java/shop/'
    await write(`${j}api/OrderController.java`, `package shop.api;
import shop.svc.OrderService;
import shop.svc.*;
import org.springframework.data.repository.CrudRepository;
public class OrderController {
  private OrderService orderService;
  private PaymentService payments;
  private Audit audit;
  private OrderRepo repo;
  public void handle(Clock clock, java.util.List<Audit> audits) {
    orderService.create();
    this.orderService.cancel();
    payments.charge();
    audit.record();
    repo.save();
    clock.now();
    var a = new Audit();
    a.viaVar();
    audits.forEach(x -> x.viaLambda());
    Audit local = new Audit();
    local.flush();
  }
}`)
    await write(`${j}svc/OrderService.java`, `package shop.svc;\npublic interface OrderService { void create(); void cancel(); }`)
    await write(`${j}svc/OrderServiceImpl.java`, `package shop.svc;\npublic class OrderServiceImpl implements OrderService { public void create() {} public void cancel() {} }`)
    await write(`${j}svc/PaymentService.java`, `package shop.svc;\npublic interface PaymentService { void charge(); }`)
    await write(`${j}svc/CardPayments.java`, `package shop.svc;\npublic class CardPayments implements PaymentService { public void charge() {} }`)
    await write(`${j}svc/CashPayments.java`, `package shop.svc;\npublic class CashPayments implements PaymentService { public void charge() {} }`)
    await write(`${j}svc/Audit.java`, `package shop.svc;\npublic class Audit { public void record() {} public void flush() {} public void viaVar() {} public void viaLambda() {} }`)
    await write(`${j}api/OrderRepo.java`, `package shop.api;\npublic interface OrderRepo extends CrudRepository<Object, String> {}`)
    // A second service with the same type names: never a target from orders.
    await write('billing/pom.xml', '<project><artifactId>billing</artifactId></project>')
    await write('billing/src/main/java/shop/svc/OrderServiceImpl.java', `package shop.svc;\npublic class OrderServiceImpl implements OrderService { public void create() {} }`)
    resetGraph()
    await extractFromDirectory(getGraph(), root, { announce: false })
  })

  it('lands a typed call on the class, and an interface call on its one implementation', () => {
    expect(calls()).toEqual([
      // orderService.create() / this.orderService.cancel(): one implementor.
      'handle -> cancel',
      'handle -> create',
      // audit.record() via a field and local.flush() via a typed local.
      'handle -> flush',
      'handle -> record',
    ])
    let target = ''
    getGraph().forEachEdge((_id, a) => {
      const e = a as GraphEdge
      if (e.type === EdgeType.CALLS && e.target.endsWith('.create')) target = e.target
    })
    // In the orders service, never billing's same-named class.
    expect(target).toMatch(/^symbol:orders:.*OrderServiceImpl\.create$/)
  })

  it('leaves two implementors, a repository, an outside type, var and lambda receivers unclaimed', () => {
    // payments.charge(): two implementations. repo.save(): no implementation in
    // the service. clock.now(): Clock isn't a service type. a.record(): `var`.
    // x.record(): an untyped lambda parameter. Covered by the exact list above.
    expect(calls().filter((c) => /charge|save|now|viaVar|viaLambda/.test(c))).toEqual([])
  })
})

describe('Java interface CALLS on train-ticket (extractFromDirectory)', () => {
  beforeAll(async () => {
    resetGraph()
    await extractFromDirectory(getGraph(), FIXTURE, { announce: false })
  })

  it("links OrderController's createNewOrder to OrderServiceImpl.create", () => {
    let edge: GraphEdge | undefined
    getGraph().forEachEdge((_id, a) => {
      const e = a as GraphEdge
      if (e.type === EdgeType.CALLS && e.source.endsWith('OrderController.createNewOrder') && e.target.endsWith('OrderServiceImpl.create')) edge = e
    })
    expect(edge?.provenance).toBe(Provenance.EXTRACTED)
    expect(edge?.evidence).toMatchObject({ file: 'src/main/java/order/controller/OrderController.java', line: 47 })
  })
})

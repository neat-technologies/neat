import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { jpaEndpoints } from '../src/extract/calls/jpa.js'
import { parse as parseSpringDatasource } from '../src/extract/databases/spring.js'
import type { DatabaseNode, GraphEdge, InfraNode } from '@neat.is/types'
import { EdgeType, Provenance, databaseId, infraId } from '@neat.is/types'

// Java data access. A Spring service names its database in application.yml
// (`spring.datasource.url`, a JDBC URL with `${VAR:default}` placeholders) and
// its tables on JPA entities (`@Table(name = "orders")`), queried through Spring
// Data repositories. The fixture is train-ticket's order service.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, 'fixtures', 'java-spring-train-ticket')

const file = (name: string, content: string) => ({ path: `/svc/src/main/java/${name}`, content })
const tables = (files: { path: string; content: string }[]) =>
  jpaEndpoints(files, '/svc').map((e) => `${e.name} <- ${e.evidence.file}:${e.evidence.line}`)

describe('jpaEndpoints', () => {
  it('reads the literal @Table name and attributes it to the entity and its repositories', () => {
    expect(
      tables([
        file(
          'Order.java',
          `import javax.persistence.*;
@Table(name = "orders")
@Entity
public class Order { }`,
        ),
        file(
          'OrderRepository.java',
          `import org.springframework.data.repository.CrudRepository;
public interface OrderRepository extends CrudRepository<Order, String> { }`,
        ),
        file(
          'OrderPages.java',
          `public interface OrderPages extends org.springframework.data.jpa.repository.JpaRepository<Order, Long> { }`,
        ),
      ]),
    ).toEqual(['orders <- src/main/java/Order.java:2', 'orders <- src/main/java/OrderRepository.java:2', 'orders <- src/main/java/OrderPages.java:1'])
  })

  it('leaves an entity without a literal table name unclaimed, and its repository with it', () => {
    expect(
      tables([
        file('Contacts.java', `import jakarta.persistence.Entity;\n@Entity\npublic class Contacts { }`),
        file('Consign.java', `import javax.persistence.*;\n@Entity\n@Table(schema = "ts-consign-mysql")\nclass Consign { }`),
        file('Named.java', `import javax.persistence.*;\n@Entity\n@Table(name = Tables.NAMED)\nclass Named { }`),
        file('ContactsRepository.java', `interface ContactsRepository extends CrudRepository<Contacts, String> { }`),
        file('Unknown.java', `interface UnknownRepository extends CrudRepository<Elsewhere, String> { }`),
      ]),
    ).toEqual([])
  })

  it('declines an entity class name declared twice in one service', () => {
    expect(
      tables([
        file('a/Order.java', `import javax.persistence.*;\n@Entity @Table(name = "orders")\nclass Order { }`),
        file('b/Order.java', `import javax.persistence.*;\n@Entity @Table(name = "orders_archive")\nclass Order { }`),
        file('OrderRepository.java', `interface OrderRepository extends CrudRepository<Order, String> { }`),
      ]),
    ).toEqual([])
  })
})

describe('Spring datasource config', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-spring-'))
  })

  const write = async (rel: string, content: string) => {
    const p = path.join(dir, rel)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, content)
  }

  it('reads the default-profile JDBC URL, resolving placeholders from .env, then their defaults', async () => {
    await write(
      'src/main/resources/application.yml',
      `spring:
  datasource:
    url: jdbc:mysql://\${ORDER_MYSQL_HOST:ts-order-mysql}:\${ORDER_MYSQL_PORT:3306}/\${DB:ts}?useSSL=false
---
spring:
  config:
    activate:
      on-profile: test
  datasource:
    url: jdbc:mysql://test-db:3306/test
`,
    )
    await write('.env', 'ORDER_MYSQL_PORT=3307\n')
    const got = await parseSpringDatasource(dir)
    expect(got.map((c) => ({ host: c.host, port: c.port, database: c.database, engine: c.engine, hostSource: c.hostSource }))).toEqual([
      { host: 'ts-order-mysql', port: 3307, database: 'ts', engine: 'mysql', hostSource: 'config' },
    ])
  })

  it('reads application.properties and a Mongo URI, and skips a placeholder with no value', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-spring-'))
    await fs.writeFile(
      path.join(d, 'application.properties'),
      `# comment
spring.datasource.url=jdbc:postgresql://pg:5432/orders
spring.data.mongodb.uri=mongodb://mongo:27017/catalog
spring.r2dbc.url=r2dbc:mysql://\${NO_DEFAULT}/x
`,
    )
    const got = await parseSpringDatasource(d)
    expect(got.map((c) => `${c.engine} ${c.host}:${c.port}/${c.database}`)).toEqual([
      'postgresql pg:5432/orders',
      'mongodb mongo:27017/catalog',
    ])
  })
})

describe('Java data access from train-ticket (extractFromDirectory)', () => {
  beforeAll(async () => {
    resetGraph()
    await extractFromDirectory(getGraph(), FIXTURE, { announce: false })
  })

  it('mints the datasource as a DatabaseNode, connected from application.yml', () => {
    const id = databaseId('10.176.122.1')
    const db = getGraph().getNodeAttributes(id) as DatabaseNode
    expect(db).toMatchObject({ engine: 'mysql', host: '10.176.122.1', port: 3306, name: 'ts' })
    const edge = getGraph().getEdgeAttributes(
      `${EdgeType.CONNECTS_TO}:file:ts-order-service:src/main/resources/application.yml->${id}`,
    ) as GraphEdge
    expect(edge.provenance).toBe(Provenance.EXTRACTED)
    expect(edge.evidence).toMatchObject({ hostSource: 'config' })
  })

  it('mints the orders table, called from the entity and from the repository', () => {
    const table = infraId('sql-table', 'orders')
    expect((getGraph().getNodeAttributes(table) as InfraNode).kind).toBe('sql-table')
    for (const f of ['src/main/java/order/entity/Order.java', 'src/main/java/order/repository/OrderRepository.java']) {
      const edge = getGraph().getEdgeAttributes(`${EdgeType.CALLS}:file:ts-order-service:${f}->${table}`) as GraphEdge
      expect(edge.provenance).toBe(Provenance.EXTRACTED)
    }
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import {
  EdgeType,
  NodeType,
  databaseId,
  extractedEdgeId,
  fileId,
  infraId,
  type DatabaseNode,
  type GraphEdge,
  type InfraNode,
} from '@neat.is/types'
import { efcoreEndpointsFromFile } from '../src/extract/calls/efcore.js'
import { csharpParser } from '../src/extract/databases/csharp.js'

// ADR-203 — C# datastore recognizers. The connection axis (databases/csharp.ts:
// Npgsql -> Postgres, StackExchange.Redis -> Redis/Valkey) mints the DatabaseNode
// the OBSERVED CONNECTS_TO span fuses onto; the table axis (calls/efcore.ts: EF
// Core `[Table("...")]` / `.ToTable("...")`) mints the `infra:sql-table:<name>` an
// OBSERVED db-statement CALLS fuses onto. The otel-demo `accounting` (Postgres +
// `orderitem`) and `cart` (`valkey-cart`) services are the shapes under test.

const SVC = '/svc'
const eps = (content: string) => efcoreEndpointsFromFile({ path: '/svc/Model.cs', content }, SVC)
const tableNames = (content: string) => eps(content).map((e) => e.name).sort()

// A minimal EF Core signal so the gate fires; the annotations themselves live in
// System.ComponentModel.DataAnnotations.Schema.
const USING = 'using System.ComponentModel.DataAnnotations.Schema;\nusing Microsoft.EntityFrameworkCore;\n'

describe('efcoreEndpointsFromFile — [Table] / ToTable → sql-table', () => {
  it('reads the literal table name from a [Table("...")] annotation', () => {
    const src = `${USING}
[Table("orderitem", Schema = "accounting")]
public class OrderItemEntity {
  public required string ProductId { get; set; }
}
`
    const ep = eps(src).find((e) => e.name === 'orderitem')
    expect(ep).toBeDefined()
    // The id must EQUAL the OBSERVED node id so the two layers fuse (not twin).
    expect(ep!.infraId).toBe('infra:sql-table:orderitem')
    expect(ep!.infraId).toBe(infraId('sql-table', 'orderitem'))
    expect(ep!.kind).toBe('sql-table')
    expect(ep!.edgeType).toBe('CALLS')
    expect(ep!.confidenceKind).toBe('structural')
    expect(ep!.evidence.file).toBe('Model.cs')
    expect(ep!.evidence.line).toBeGreaterThan(0)
  })

  it('reads every entity in a file and dedupes by table name', () => {
    const src = `${USING}
[Table("orderitem", Schema = "accounting")]
public class OrderItemEntity { public string ProductId { get; set; } }
[Table("order", Schema = "accounting")]
public class OrderEntity { public string Id { get; set; } }
[Table("shipping", Schema = "accounting")]
public class ShippingEntity { public string ShippingTrackingId { get; set; } }
`
    expect(tableNames(src)).toEqual(['order', 'orderitem', 'shipping'])
  })

  it('reads a .ToTable("...") fluent-API mapping', () => {
    const src = `${USING}
internal class Ctx : DbContext {
  protected override void OnModelCreating(ModelBuilder modelBuilder) {
    modelBuilder.Entity<OrderEntity>().ToTable("order");
  }
}
`
    expect(tableNames(src)).toEqual(['order'])
  })

  it('strips the delimiters of a verbatim @"..." table name', () => {
    const src = `${USING}
[Table(@"shipping")]
public class ShippingEntity { public string Id { get; set; } }
`
    expect(tableNames(src)).toEqual(['shipping'])
  })

  it('tolerates a fully-qualified / Attribute-suffixed spelling', () => {
    const src = `${USING}
[System.ComponentModel.DataAnnotations.Schema.TableAttribute("orderitem")]
public class OrderItemEntity { public string ProductId { get; set; } }
`
    expect(tableNames(src)).toEqual(['orderitem'])
  })

  it('never mints from a non-string [Table(nameof(X))]', () => {
    const src = `${USING}
[Table(nameof(OrderItemEntity))]
public class OrderItemEntity { public string ProductId { get; set; } }
`
    expect(eps(src)).toEqual([])
  })

  it('never mints from a [Table("...")] inside a comment', () => {
    const src = `${USING}
// [Table("ghost")]
/* [Table("phantom")] */
[Table("orderitem")]
public class OrderItemEntity { public string ProductId { get; set; } }
`
    expect(tableNames(src)).toEqual(['orderitem'])
  })

  it('is inert on a .cs file with no EF Core signal', () => {
    const src = `
[Table("orderitem")]
public class OrderItemEntity { public string ProductId { get; set; } }
`
    // No `using Microsoft.EntityFrameworkCore` / DataAnnotations.Schema / DbContext /
    // DbSet<> — the gate declines rather than mint a table from a stray attribute.
    expect(eps(src)).toEqual([])
  })

  it('is inert on a non-.cs file', () => {
    expect(efcoreEndpointsFromFile({ path: '/svc/model.ts', content: `${USING}[Table("x")]class X{}` }, SVC)).toEqual(
      [],
    )
  })
})

// ── connection axis (databases/csharp.ts) ────────────────────────────────────

describe('csharpParser — Npgsql / StackExchange.Redis → DatabaseNode host', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-csharp-db-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  const write = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(dir, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
  }

  it('parses a literal Npgsql keyword connection string → host', async () => {
    await write(
      'Ctx.cs',
      `using Microsoft.EntityFrameworkCore;
class Ctx : DbContext {
  void C(DbContextOptionsBuilder b) {
    b.UseNpgsql("Host=postgresql;Port=5432;Username=u;Password=p;Database=otel");
  }
}`,
    )
    const configs = await csharpParser.parse(dir)
    expect(configs).toHaveLength(1)
    const pg = configs[0]!
    expect(pg.host).toBe('postgresql')
    expect(databaseId(pg.host)).toBe('database:postgresql')
    expect(pg.engine).toBe('postgresql')
    expect(pg.port).toBe(5432)
    expect(pg.database).toBe('otel')
    expect(pg.sourceFile).toBe(path.join(dir, 'Ctx.cs'))
  })

  it('resolves an env-driven Npgsql connection string from a .env', async () => {
    await write(
      'Consumer.cs',
      `using Microsoft.EntityFrameworkCore;
class DBContext : DbContext {
  protected override void OnConfiguring(DbContextOptionsBuilder b) {
    var cs = Environment.GetEnvironmentVariable("DB_CONNECTION_STRING");
    b.UseNpgsql(cs).UseSnakeCaseNamingConvention();
  }
}`,
    )
    await write('.env', 'DB_CONNECTION_STRING=Host=pgprod;Database=app\n')
    const configs = await csharpParser.parse(dir)
    expect(configs.map((c) => c.host)).toEqual(['pgprod'])
    expect(configs[0]!.engine).toBe('postgresql')
  })

  it('resolves a ${VAR}-interpolated env value one level deep', async () => {
    await write(
      'Ctx.cs',
      `using Microsoft.EntityFrameworkCore;
class Ctx : DbContext { void C(DbContextOptionsBuilder b) {
  b.UseNpgsql(Environment.GetEnvironmentVariable("DB_CONNECTION_STRING"));
} }`,
    )
    await write('.env', 'POSTGRES_HOST=postgresql\nDB_CONNECTION_STRING=Host=${POSTGRES_HOST};Database=otel\n')
    const configs = await csharpParser.parse(dir)
    expect(configs.map((c) => c.host)).toEqual(['postgresql'])
  })

  it('parses a literal StackExchange.Redis endpoint → host', async () => {
    await write(
      'Store.cs',
      `using StackExchange.Redis;
class Store { void C() {
  var redis = ConnectionMultiplexer.Connect("valkey-cart:6379,ssl=false,abortConnect=false");
} }`,
    )
    const configs = await csharpParser.parse(dir)
    expect(configs).toHaveLength(1)
    const redis = configs[0]!
    expect(redis.host).toBe('valkey-cart')
    expect(databaseId(redis.host)).toBe('database:valkey-cart')
    expect(redis.engine).toBe('redis')
    expect(redis.port).toBe(6379)
  })

  it('joins a cross-file Redis client (call in one file, VALKEY_ADDR in another)', async () => {
    // cart's real shape: the ConnectionMultiplexer.Connect call lives in the store,
    // the address is read from config in Program.cs.
    await write(
      'cartstore/ValkeyCartStore.cs',
      `using StackExchange.Redis;
class ValkeyCartStore {
  ValkeyCartStore(string valkeyAddress) {
    var cs = $"{valkeyAddress},ssl=false,allowAdmin=true,abortConnect=false";
    var opts = ConfigurationOptions.Parse(cs);
    var redis = ConnectionMultiplexer.Connect(opts);
  }
}`,
    )
    await write(
      'Program.cs',
      `class Program { static void Main() {
  string valkeyAddress = builder.Configuration["VALKEY_ADDR"];
  var store = new ValkeyCartStore(valkeyAddress);
} }`,
    )
    await write('.env', 'VALKEY_PORT=6379\nVALKEY_ADDR=valkey-cart:${VALKEY_PORT}\n')
    const configs = await csharpParser.parse(dir)
    expect(configs.map((c) => `${c.engine}:${c.host}`)).toEqual(['redis:valkey-cart'])
  })

  it('mints no phantom DatabaseNode when a verified client has no resolvable host', async () => {
    // A real `UseNpgsql` call but the host lives in a runtime value with no `.env`
    // to recover it (the otel-demo's `DB_CONNECTION_STRING` sits in compose, not a
    // reachable `.env`). A placeholder host would share the `database:<host>` shape
    // an OBSERVED span carries yet never fuse onto it — so nothing is minted.
    await write(
      'Ctx.cs',
      `using Microsoft.EntityFrameworkCore;
class Ctx : DbContext { void C(DbContextOptionsBuilder b) {
  b.UseNpgsql(someRuntimeValue);
} }`,
    )
    expect(await csharpParser.parse(dir)).toEqual([])
  })

  it('extracts BOTH the config-driven valkey-cart and the genuinely-declared badhost peer', async () => {
    // The otel-demo cart declares two redis peers, both real: the primary store
    // connects to the config-driven `VALKEY_ADDR` (`valkey-cart`), and a second
    // `new ValkeyCartStore(logger, "badhost:1234")` is a deliberately-bad fault
    // probe. Both are genuinely declared, so both mint — `valkey-cart` fuses with
    // the OBSERVED peer, `badhost` is a declared-but-unobserved connection (an
    // honest divergence), NOT a phantom to drop. The id keys on the host alone.
    await write(
      'Program.cs',
      `class Program { static void Main() {
  string valkeyAddress = builder.Configuration["VALKEY_ADDR"];
  var store = new ValkeyCartStore(logger, valkeyAddress);
  var probe = new ValkeyCartStore(logger, "badhost:1234");
} }`,
    )
    await write(
      'cartstore/ValkeyCartStore.cs',
      `using StackExchange.Redis;
class ValkeyCartStore {
  ValkeyCartStore(object logger, string valkeyAddress) {
    var cs = $"{valkeyAddress},ssl=false,allowAdmin=true,abortConnect=false";
    var redis = ConnectionMultiplexer.Connect(ConfigurationOptions.Parse(cs));
  }
}`,
    )
    await write('.env', 'VALKEY_PORT=6379\nVALKEY_ADDR=valkey-cart:${VALKEY_PORT}\n')
    const configs = await csharpParser.parse(dir)
    // Config-driven host first, then the literal; both engines are redis.
    expect(configs.map((c) => `${c.engine}:${c.host}`).sort()).toEqual([
      'redis:badhost',
      'redis:valkey-cart',
    ])
    expect(configs.map((c) => databaseId(c.host)).sort()).toEqual([
      'database:badhost',
      'database:valkey-cart',
    ])
    // No driver-suffixed id — the engine is an attribute, not part of the host id.
    expect(configs.some((c) => c.host.includes('-stackexchange'))).toBe(false)
    expect(configs.every((c) => c.engine === 'redis')).toBe(true)
  })

  it('is inert on a service with no Npgsql / Redis client', async () => {
    await write('Plain.cs', `class Plain { void Log() { var s = "Information"; } }`)
    expect(await csharpParser.parse(dir)).toEqual([])
  })
})

// ── end-to-end: the otel-demo shape through the full extractor ────────────────

describe('C# datastore fusion end-to-end (ADR-203)', () => {
  let dir: string
  beforeEach(async () => {
    resetGraph()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-csharp-e2e-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  const write = async (rel: string, content: string): Promise<void> => {
    const abs = path.join(dir, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
  }

  it('mints database:postgresql + infra:sql-table:orderitem + database:valkey-cart with matching ids', async () => {
    // A repo root so the env up-tree walk stops here (mirrors the otel-demo layout,
    // where VALKEY_ADDR sits in a root .env above each service). `VALKEY_ADDR`
    // resolves the real peer (`valkey-cart`); the `badhost:1234` fault-probe below is
    // a second genuine declaration and mints its own node. In the live otel-demo
    // `DB_CONNECTION_STRING` lives in compose (Host=${POSTGRES_HOST} → astronomy-db),
    // unreachable from a `.env` — so the fixture places it here to exercise the
    // resolved-host id path; when it can't resolve, no node is minted at all (no
    // fabricated placeholder — covered by the unit negative above).
    await fs.mkdir(path.join(dir, '.git'), { recursive: true })
    await write('.env', 'VALKEY_PORT=6379\nVALKEY_ADDR=valkey-cart:${VALKEY_PORT}\nDB_CONNECTION_STRING=Host=postgresql;Database=otel\n')

    // accounting — flat layout, EF Core + Npgsql.
    await write('accounting/Accounting.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>')
    await write(
      'accounting/Consumer.cs',
      `using Microsoft.EntityFrameworkCore;
internal class DBContext : DbContext {
  public DbSet<OrderItemEntity> CartItems { get; set; }
  protected override void OnConfiguring(DbContextOptionsBuilder b) {
    var cs = Environment.GetEnvironmentVariable("DB_CONNECTION_STRING");
    b.UseNpgsql(cs).UseSnakeCaseNamingConvention();
  }
}`,
    )
    await write(
      'accounting/Entities.cs',
      `using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;
[Table("orderitem", Schema = "accounting")]
public class OrderItemEntity { public required string ProductId { get; set; } }
[Table("order", Schema = "accounting")]
public class OrderEntity { public required string Id { get; set; } }
`,
    )

    // cart — nested src/ layout, StackExchange.Redis / Valkey.
    await write('cart/src/cart.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>')
    await write(
      'cart/src/Program.cs',
      `class Program { static void Main() {
  string valkeyAddress = builder.Configuration["VALKEY_ADDR"];
  var store = new ValkeyCartStore(valkeyAddress);
  // The otel-demo's deliberately-bad fault-probe store — a genuine second declared
  // peer, so it mints database:badhost too (declared-but-unobserved divergence).
  var probe = new ValkeyCartStore("badhost:1234");
} }`,
    )
    await write(
      'cart/src/cartstore/ValkeyCartStore.cs',
      `using StackExchange.Redis;
class ValkeyCartStore {
  ValkeyCartStore(string valkeyAddress) {
    var cs = $"{valkeyAddress},ssl=false,abortConnect=false";
    var redis = ConnectionMultiplexer.Connect(ConfigurationOptions.Parse(cs));
  }
}`,
    )

    const graph = getGraph()
    await extractFromDirectory(graph, dir)

    // Postgres DatabaseNode — the id EQUALS the observed `database:postgresql`.
    expect(graph.hasNode(databaseId('postgresql'))).toBe(true)
    const pg = graph.getNodeAttributes(databaseId('postgresql')) as DatabaseNode
    expect(pg.type).toBe(NodeType.DatabaseNode)
    expect(pg.engine).toBe('postgresql')

    // orderitem table — the id EQUALS the observed `infra:sql-table:orderitem`.
    expect(graph.hasNode(infraId('sql-table', 'orderitem'))).toBe(true)
    const orderitem = graph.getNodeAttributes(infraId('sql-table', 'orderitem')) as InfraNode
    expect(orderitem.type).toBe(NodeType.InfraNode)
    expect(orderitem.kind).toBe('sql-table')
    // `order` too, from the second entity.
    expect(graph.hasNode(infraId('sql-table', 'order'))).toBe(true)

    // Valkey DatabaseNode — the id EQUALS the observed `database:valkey-cart`.
    expect(graph.hasNode(databaseId('valkey-cart'))).toBe(true)
    const valkey = graph.getNodeAttributes(databaseId('valkey-cart')) as DatabaseNode
    expect(valkey.type).toBe(NodeType.DatabaseNode)
    expect(valkey.engine).toBe('redis')

    // The `badhost:1234` fault-probe is genuinely declared, so it mints a real
    // (declared-but-unobserved) node — an honest divergence, kept, not dropped.
    expect(graph.hasNode(databaseId('badhost'))).toBe(true)
    // What is NEVER minted is the old fabricated, driver-suffixed placeholder host.
    expect(graph.hasNode(databaseId('postgresql-npgsql'))).toBe(false)

    // CONNECTS_TO edge, file-grained, carrying evidence.file.
    const pgEdgeId = extractedEdgeId(
      fileId('Accounting', 'Consumer.cs'),
      databaseId('postgresql'),
      EdgeType.CONNECTS_TO,
    )
    expect(graph.hasEdge(pgEdgeId)).toBe(true)
    const pgEdge = graph.getEdgeAttributes(pgEdgeId) as GraphEdge
    expect(pgEdge.evidence.file).toBe('accounting/Consumer.cs')

    // CALLS edge to the orderitem table, carrying evidence.file.
    const tblEdgeId = extractedEdgeId(
      fileId('Accounting', 'Entities.cs'),
      infraId('sql-table', 'orderitem'),
      EdgeType.CALLS,
    )
    expect(graph.hasEdge(tblEdgeId)).toBe(true)
    const tblEdge = graph.getEdgeAttributes(tblEdgeId) as GraphEdge
    expect(tblEdge.evidence.file).toBe('Entities.cs')

    // CONNECTS_TO edge for valkey, from the store file that holds the client call.
    const valkeyEdgeId = extractedEdgeId(
      fileId('cart', 'cartstore/ValkeyCartStore.cs'),
      databaseId('valkey-cart'),
      EdgeType.CONNECTS_TO,
    )
    expect(graph.hasEdge(valkeyEdgeId)).toBe(true)
  })
})

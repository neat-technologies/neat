---
name: static-extraction
description: Producers under packages/core/src/extract/* read source code and config to build the EXTRACTED layer. Every edge carries evidence.file. Ghost-edge cleanup keys on it. Producers are idempotent and pre-emit gate against five precision filters. Per-file failures route to errors.ndjson with a loud aggregate banner and surface as coverage on /health.
governs:
  - "packages/core/src/extract/**"
  - "packages/core/src/watch.ts"
adr: [ADR-032, ADR-065, ADR-115, ADR-119, ADR-123, ADR-030, ADR-031, ADR-024, ADR-055, ADR-133, ADR-138, ADR-155, ADR-158, ADR-161]
enforcement: [lint, review]
---

# Static-extraction contract

The first producer-layer contract. `packages/core/src/extract/**` reads source code and config files to build the EXTRACTED layer of the graph. Mutation authority for static creation is locked here per the lifecycle contract (ADR-030).

## Producer interface

Every producer module exports a single async function with the signature:

```ts
async function addX(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
): Promise<{ nodesAdded?: number; edgesAdded?: number }>
```

Producers are pure with respect to graph state outside their own writes. They:

- read from the filesystem within `scanPath` and each service's `dir`,
- write nodes and edges via `graph.addNode` / `graph.addEdgeWithKey`,
- guard every write with `graph.hasNode(id)` / `graph.hasEdge(id)` for idempotency,
- never read the OBSERVED layer,
- never trigger REST or MCP,
- never call `compat.json` outside `compat.ts`.

## Evidence on EXTRACTED edges (binding)

Every EXTRACTED edge carries an `evidence` field:

```ts
evidence: {
  file: string         // path relative to scanPath, forward slashes
  line?: number        // 1-indexed
  snippet?: string     // small source fragment, max ~120 chars
}
```

`file` is required. `line` and `snippet` are optional but strongly preferred when the producer can compute them cheaply.

Today the CALLS-family producers (`calls/http.ts`, `calls/aws.ts`, `calls/kafka.ts`, `calls/grpc.ts`, `calls/redis.ts`) carry evidence. CONNECTS_TO, CONFIGURED_BY, DEPENDS_ON, and RUNS_ON producers do not. Issue #140 closes that gap.

Evidence extends to an EXTRACTED **attribute**, not only an edge (ADR-157). A declared column on a `sql-table` node (`ColumnAttr`) records `{ name, provenances, confidence }` and no evidence of its own; its file:line is the table definition's, carried on the `file ──CALLS──▶ infra:sql-table:<name>` EXTRACTED edge the same producer mints — one evidence record for the definition, shared by the table edge and the columns it declares.

## Ghost-edge cleanup

When a file changes or disappears between extract passes, every EXTRACTED edge whose `evidence.file` matches that path is **dropped before the producer reruns**. Re-extraction recreates the edges that still apply; the deleted code's edges stay deleted.

`watch.ts` owns the cleanup trigger per ADR-030's mutation authority. The order is:

1. `classifyChange` decides which producer phases the changed file belongs to.
2. For each phase, `watch.ts` calls a `retireEdgesByFile(graph, file)` step that drops every edge in that phase whose `evidence.file` matches.
3. The producer reruns. Idempotent writes recreate surviving edges.

This is the v0.1.x bug closed by issue #140. Without it, watch-driven re-extraction accumulates stale EXTRACTED edges indefinitely.

## Idempotency

Every producer is idempotent. Running the same producer twice on the same input produces the same graph state. `graph.hasNode(id)` and `graph.hasEdge(id)` guards already enforce this; the contract reaffirms it.

Idempotency is what makes ghost-edge cleanup safe — the path-keyed retire step plus re-extraction always converges on the source's current state, regardless of how many times either fires.

## Language dispatch

Source-file parsing routes by file extension:

| Extension                                | Grammar                          |
|------------------------------------------|----------------------------------|
| `.js` `.jsx` `.mjs` `.cjs` `.ts` `.tsx`  | `tree-sitter-javascript`         |
| `.py`                                    | `tree-sitter-python`             |
| `.go`                                    | `tree-sitter-go`                 |
| `.rb`                                    | `tree-sitter-ruby`               |
| `.php`                                   | `tree-sitter-php` (`php_only`)   |

`tree-sitter-typescript` is installed but currently unused — `.ts` / `.tsx` fall through to the JS parser. Replacing the JS fallback with the dedicated TS grammar is a future improvement, not in scope for this contract.

Other extensions are skipped silently by `walkSourceFiles` per `IGNORED_DIRS` and `SERVICE_FILE_EXTENSIONS` in `extract/shared.ts`. New language support requires a grammar import and an extension entry in one place.

Go services are discovered from `go.mod`. `tree-sitter-go@0.21.2` declares `tree-sitter ^0.21.0`, matching the repository's native binding without an ABI upgrade (ADR-154). Local package imports resolve only when one non-test source file is unambiguous; gin routes require literal method paths and literal in-file `Group` prefixes; `database/sql` calls require a literal statement resolving to one table. Ambiguous or computed identities stay unattributed.

Ruby services are discovered from the `Gemfile` (`extract/ruby.ts`), the analog of the `go.mod` reader — a Gemfile names no project, so the service takes its directory's basename and each `gem` line is a dependency gate. `tree-sitter-ruby` is pinned at exactly `0.21.0`, the one ABI-14 release: the grammar jumps to ABI-15 at `0.23.0`, which the pinned `tree-sitter@^0.21.1` runtime can't load, so the pin is exact, not a caret (ADR-173). Ruby is a route-and-service-grain pilot: `.rb` files are FileNodes and `config/routes.rb` is read for Rails routes, but the ActiveRecord data axis and Ruby's autoload-driven require graph are later rungs and stay unmodelled — `imports.ts` skips `.rb` rather than parse it with the wrong grammar.

PHP services are discovered from `composer.json` (`extract/php.ts`), the same manifest-reader analog — the `require` block (merged with `require-dev`) becomes the dependency gates, so the route producer gates on `laravel/framework`, and the service takes its directory's basename the way the Gemfile/go.mod readers do. `tree-sitter-php` is pinned at exactly `0.22.8`: the `0.21.x` line ships the legacy `nan` binding whose language object never unwraps against the `node-addon-api`-based `tree-sitter@^0.21.1` runtime, and `0.22.8` is the lowest release that both carries the compatible binding and still generates an ABI-14 grammar (`0.23.0`+ is where the line moves past what the pinned runtime loads), so the pin is exact, not a caret (ADR-177). The grammar exports `{ php, php_only }`; NEAT parses with `php_only` because Laravel route files are pure PHP with no `?>`-delimited HTML islands. PHP reads at route, table, and service grain: `.php` files are FileNodes, `routes/web.php` + `routes/api.php` are read for Laravel routes (ADR-177), and `database/migrations` + `app/Models` are read for the Laravel data axis (`calls/eloquent.ts`, ADR-178). Doctrine (Symfony's ORM), Symfony routes, PHP's PSR-4 autoload require graph, and file-grain call-site stamping are later rungs and stay unmodelled — `imports.ts` skips `.php` rather than parse it with the wrong grammar.

`calls/eloquent.ts` (ADR-178) is the Laravel data axis, the declared-schema reader for Laravel the way `calls/activerecord.ts` is for Rails. **`database/migrations/*.php` is the anchor**, because its names are literal: `laravelMigrationEndpointsFromFile` reads each `Schema::create('orders', function (Blueprint $table) { … })` into an `infra:sql-table:orders` node carrying the `$table->` columns as `ColumnAttr`s (ADR-157) — the string-arg columns, `$table->id()`, and `$table->timestamps()`. `laravelMigrationForeignKeys` mints `REFERENCES` edges (ADR-161) from `$table->foreignId('user_id')->constrained()` (parent by the `<name>_id` convention or the explicit `constrained('accounts')` argument), `$table->foreignIdFor(User::class)`, and `$table->foreign('buyer_id')->references('id')->on('buyers')` — a bare `foreignId` with no `->constrained()` is a column only and mints no edge. **The Eloquent models corroborate**: `laravelModelEndpointsFromFile` links `class Order extends Model` to its table via `$table` or the snake-case pluralization fallback, and `laravelModelForeignKeys` turns `belongsTo`/`hasMany`/`hasOne` into `REFERENCES` edges, deduped after the migration literals. `belongsToMany` pivots, `hasManyThrough`, and Doctrine are deferred; the OBSERVED twin fuses on the table name via the DB adapter's `db.statement`.

## Discovery policy

- Recursive directory walk from `scanPath`, bounded by `NEAT_SCAN_DEPTH` (default 5, configurable via env).
- `.gitignore` honored.
- `IGNORED_DIRS` skip set: `node_modules`, `.git`, `.turbo`, `dist`, `build`, `.next`. (`__pycache__` and `vendor` are pending — see open-questions list in `docs/audits/verification.md`.)
- `package.json#workspaces` triggers monorepo expansion. `pnpm-workspace.yaml` and `turbo.json` are not yet read (deferred).

## Producers in scope

| Module               | Produces                                       | Evidence today |
|----------------------|------------------------------------------------|----------------|
| `services.ts`        | ServiceNode (npm + Python)                     | n/a (nodes)    |
| `aliases.ts`         | host:port aliases on existing ServiceNodes     | n/a            |
| `databases/*`        | DatabaseNode + CONNECTS_TO                     | ❌ — #140      |
| `configs.ts`         | ConfigNode + CONFIGURED_BY                     | ❌ — #140      |
| `calls/{aws,grpc,http,kafka,redis,supabase,mongoose}.ts` | CALLS / PUBLISHES_TO / CONSUMES_FROM | ✅          |
| `symbols.ts`         | SymbolNode + `file ──CONTAINS──▶ symbol` per function/method/constructor/class definition (ADR-158) | ✅ |
| `symbol-edges.ts`    | symbol→symbol `INHERITS` / `IMPLEMENTS` (heritage) + `CALLS`, confident-resolved only (ADR-158 §3) | ✅ |
| `routes.ts`          | RouteNode + `service ──CONTAINS──▶ route` (ADR-119) | ✅         |
| `actions.ts`         | ServerActionNode + `file ──CONTAINS──▶ action` per exported `"use server"` function, and `file ──CALLS──▶ action` on any client reference to an imported action binding (ADR-168) | ✅ |
| `calls/route-match.ts` | client `file ──CALLS──▶ route` cross-service match (ADR-119) | ✅ |
| `proto.ts`           | GrpcMethodNode + `service ──CONTAINS──▶ method` from `.proto` (ADR-123) | ✅ |
| `infra/{docker-compose,dockerfile,k8s,terraform}.ts` | InfraNode + DEPENDS_ON / RUNS_ON / CONNECTS_TO | ✅ (evidence populated) |
| `infra/cloudflare.ts` | `platform` tag on ServiceNode/FileNode + InfraNode + DEPENDS_ON / RUNS_ON / CONNECTS_TO (ADR-133) | ✅ |
| `infra/{vercel,railway,supabase}.ts` | `platform` tag on ServiceNode (+ `platformName`) + InfraNode + DEPENDS_ON / RUNS_ON / CONNECTS_TO (ADR-138) | ✅ |
| `calls/drizzle.ts` | `infra:sql-table:<name>` + EXTRACTED `columns` from a `pgTable` / `mysqlTable` / `sqliteTable` schema (ADR-157 §3) | ✅ |
| `calls/prisma.ts` | `infra:sql-table:<name>` + EXTRACTED `columns` from `schema.prisma` model blocks, at Prisma's verbatim (non-snake-cased) naming with `@map` / `@@map` overrides (ADR-157 §3) | ✅ |
| `zod-shapes.ts` | `infra:zod-schema:<name>` InfraNode + EXTRACTED `columns` from a top-level `z.object({…})` / `z.enum([…])` literal, owned by its file via `file ──CONTAINS──▶ zod-schema` (ADR-170) | ✅ |
| `calls/firestore.ts` | `infra:firestore-collection:<path>` + EXTRACTED `columns` from Firestore write/query field names, each written field tagged with its writing SDK (`sdkWrites`: client vs admin) (ADR-167) | ✅ |
| `table-edges.ts` | `infra:sql-table:<child> ──REFERENCES──▶ infra:sql-table:<parent>` foreign keys read per-ORM (Drizzle `.references`, Prisma `@relation(fields:)`, SQLAlchemy `ForeignKey`), parent at DB-name fidelity (ADR-161) | ✅ |
| `firestore-rules.ts` | `guardedFields` folded onto `firestore-collection` InfraNodes from a checked-in `firestore.rules` (ADR-169). A **standalone** phase, not a CALLS producer; adds no nodes or edges — it only enriches existing nodes | n/a (attribute fold) |

New producers under `calls/` for source-level DB connections (`new pg.Pool(...)`) and inter-service imports land under issue #141. They follow the same interface, same evidence shape, same idempotency.

`calls/mongoose.ts` (ADR-147, #832) is the collection-grained analog of `calls/supabase.ts`. Gated on a `mongoose` or `mongodb` import, it names the collection a file reads or writes: the native-driver literal path (`db.collection('orders')`, collection = the string argument) and the Mongoose model path (`mongoose.model('Order', schema)` → `orders`, deriving the name with Mongoose's own pluralization rules **verbatim** so it matches the collection Mongoose actually created — `Goose`→`gooses`, not `geese`; that fidelity is the fusion key the Atlas connector's observed edges land on). It emits a file-grained `mongodb-collection:<name>` edge at `verified-call-site` confidence when the collection resolves in-file, and falls back to `mongodb-model:<Model>` (lower confidence) when the model is known but the collection is defined cross-file or computed at runtime — never a fabricated name. Cross-file model→collection resolution (ADR-149) is handled by a whole-program pass, `mongooseCrossFileEndpoints`, that runs once per service after the per-file scan: it builds a model registry, resolves each query file's imported bindings to their defining file through the same resolver `imports.ts` uses (`resolveJsImport`), and names the collection at the *query* site — so `routes/orders.js` calling `Order.find()` on a model defined in `models/Order.js` is attributed, not just the definition file. Bare-alias (`baseUrl`) imports and barrel *re-export* chains are the remaining edges; a binding whose model name or collection is computed stays unattributed rather than guessed.

`calls/firestore.ts` (ADR-167) is the collection-grained recognizer for the Firebase/Next.js stack, a sibling of `calls/mongoose.ts`. Gated on a `firebase/firestore` (client SDK) or `firebase-admin/firestore` (admin SDK) import, it reads the `.ts`/`.js` AST and names the collection a file reads or writes across the modular shape (`collection(db, 'orders')`, `doc(db, 'orders', id)`) and the namespaced shape (`db.collection('orders').doc(id)`), scoping matches to a recognized Firestore client var (`getFirestore(...)`, `admin.firestore()`) exactly as `calls/supabase.ts` scopes `.from()`. Nested subcollections compose to a full path-template node (`collection(doc(db,'users',id),'posts')` → `infra:firestore-collection:users/{}/posts`, a document id collapsing to the `{}` placeholder); a computed or interpolated path segment is left unclaimed rather than guessed. Field names read from `.set` / `.update` / `.add({...})` object keys and `where(...)` / `orderBy(...)` arguments land as `ColumnAttr` on the collection node through the same `foldColumns` path as the SQL recognizers — the Firestore field name is the JS field name, no remap. Firestore has no least-privilege telemetry path (ADR-128 makes its runtime a connector non-goal), so the node is EXTRACTED-only; its load-bearing extra is that each **written** field records the SDK that wrote it (`sdkWrites`: `client` = `firebase/firestore`, governed by security rules, vs `admin` = `firebase-admin/firestore`, which bypasses them), folded by the parallel `foldSdkWrites` helper (`foldColumns` stays byte-identical) — the seam the field-guard policy (ADR-169) joins on. A file that imports both SDKs leaves the tag off rather than guessing which client issued a write.

`calls/sqlalchemy.ts` (ADR-151, ADR-152) is the SQL analog for Python. Gated on a `sqlalchemy` / `flask_sqlalchemy` import, it names the table a model maps to by reading the `.py` AST (`tree-sitter-python`): an explicit `__tablename__ = 'orders'` (plain declarative), a Flask-SQLAlchemy model whose table is derived from the class name via `camel_to_snake_case` reproduced **verbatim** (`UserProfile` → `user_profile`, `OAuth2Token` → `o_auth2_token` — the fusion key the OBSERVED side lands on), or a native `Table('orders', …)` literal. It emits a file-grained `infra:sql-table:<name>` edge at `verified-call-site` confidence; a computed `__tablename__` or a cross-file model stays unattributed rather than guessed. The table node is engine-agnostic — the engine lives on the `database:<host>` node one layer up (ADR-141). The OBSERVED twin recovers the table by parsing `db.statement` (ADR-152), since the SQLAlchemy instrumentation emits no table attribute. `calls/django-orm.ts` names a Django model's table `<app_label>_<lowercased-model>` — the app_label defaulting to the model file's app package (parent directory), overridable by `Meta.app_label` / `Meta.db_table` — onto the same `sql-table` node. A whole-program pass (`pythonOrmCrossFileEndpoints`, the ADR-149 analog) then attributes a query to its table at the *query* site: a file running `session.query(Order)` / `select(Order)` / `Order.query` on a model imported from another file gets the `file → sql-table` edge, so the code that actually reads the table is named — bounded to a model imported by name; a model reached only dynamically stays unattributed.

`calls/activerecord.ts` (ADR-174) is the Ruby/Rails data axis, the declared-schema reader for Rails the way `calls/prisma.ts` is for Prisma. Gated per-file on the `ActiveRecord::Schema` marker (schema readers) and on an `< ApplicationRecord` / `< ActiveRecord::Base` superclass (model readers), it parses `.rb` via `tree-sitter-ruby` — the raw file, not the JS-comment-masked copy, so Ruby `#` comments are excluded structurally as `comment` nodes. **`db/schema.rb` is the anchor**, because its names are literal — the exact strings the database uses. `railsSchemaEndpointsFromFile` reads each `create_table "orders" do |t| … end` into an `infra:sql-table:orders` node carrying the literal columns as `ColumnAttr`s (ADR-157 §3): the implicit `id` unless `id: false`, each `t.string "name"` / `t.integer "qty"` / `t.column "name","type"` type method, a `t.references :user` / `t.belongs_to :user` as a `<name>_id` column (plus `<name>_type` when `polymorphic:`), and `t.timestamps` as `created_at` + `updated_at`. `railsSchemaForeignKeys` mints `REFERENCES` edges (ADR-161) from the two literal FK sources — `t.references :user, foreign_key: true` (parent pluralised, or `to_table:` verbatim) and top-level `add_foreign_key "orders", "users"` (both names literal) — a polymorphic reference names no single parent and is left unclaimed. **The models corroborate**: `railsModelEndpointsFromFile` links `class Order < ApplicationRecord` to its table (a `file → sql-table` CALLS edge, no columns — ActiveRecord reads those from the DB) via `self.table_name` or the ActiveSupport pluralisation fallback, and `railsModelForeignKeys` turns `belongs_to`/`has_many`/`has_one` into `REFERENCES` edges (the FK lives on the table holding the `<name>_id` column, so `belongs_to` points outward and `has_many`/`has_one` point inward), honouring `class_name:` and deferring `has_many :through` / `has_and_belongs_to_many`. Model FKs are appended after the schema/ORM literals in `table-edges.ts`, so a relationship declared on both sides collapses to one edge with the schema.rb literal winning the graph-level dedup. `structure.sql`, `create_join_table`, and virtual/generated columns are deferred. The OBSERVED twin fuses on the table name via the `pg`/`mysql2` adapter's `db.statement` (Rails' `active_record` instrumentation emits no SQL) — a deployment fact, not a code dependency.

## Declared columns at database-name fidelity (ADR-157 §3)

The declared side of column grain — the schema-grain twin of the OBSERVED read off `db.statement` — reproduces each column at the **database column name, not the code field name**. That is the load-bearing constraint: the fusion key the running query carries is the DB name, so an extractor that reads the code field name would name `userId` where production writes `user_id` and fuse onto nothing — the same fidelity rule the Mongoose pluralizer (ADR-147) and the SQLAlchemy tablename port (ADR-152) follow. A column whose name is computed or unresolved is left unclaimed rather than guessed. The columns land on the same `infra:sql-table:<name>` node the OBSERVED side uses, with EXTRACTED provenance, folded through `columns.ts` (`foldColumns`) — the graph mutation stays with `extract/calls/*`, a lifecycle authority.

`calls/drizzle.ts` is the primary producer (JS/TS). Gated on a `drizzle-orm` import, it reads the `.ts`/`.js` AST — `tree-sitter-typescript` for `.ts`/`.tsx`, `tree-sitter-javascript` otherwise (`GRAMMAR_BY_EXT`, so a TypeScript schema parses without ERROR nodes) — for a `pgTable('orders', { … })` (or `mysqlTable` / `sqliteTable`) and names both the table (the first string literal) and its columns (the keys of the second-argument object). Each column name is the explicit column-builder name where given (`integer('user_id')` → `user_id`) and the object key as the fallback Drizzle itself uses when a builder is given no name (`total: integer()` → `total`).

`calls/sqlalchemy.ts` is the Python declared-column producer, extending the ADR-152 table read: for a declarative model it reads each `x = Column(...)` / `x: Mapped[…] = mapped_column(...)` assignment in the class body, where the DB column name is the explicit first-string argument if present (`Column('total_amount', Integer)` → `total_amount`) and the **attribute name itself** otherwise (`user_id = Column(Integer)` → `user_id`, SQLAlchemy's own rule) — a `relationship(...)` or non-`Column` assignment is not a column.

`calls/prisma.ts` completes the ADR-157 §3 follow-on for Prisma. `schema.prisma` is not JS, so it is read as text (the read-polyglot-as-data discipline `proto.ts` follows) with a small `model … { … }` block scanner — no grammar, no new language enters the toolchain. Each model's **scalar** fields become the table's columns; the table name is the model name **verbatim** (Prisma's default is PascalCase, not snake-cased) unless `@@map("name")` overrides it, and the column name is the field name **verbatim** unless `@map("db_col")` overrides it — Prisma does no snake_casing, so the reproduction is the identity plus the explicit maps, the fusion key the running query carries. A relation field is not a column and is skipped: a field carrying `@relation(...)`, or one whose base type is another declared model (`author User`, `tagList Tag[]`, `comments Comment[]`). A foreign-key scalar (`authorId Int`) and an enum-typed field are columns; a field whose type is neither a scalar, a declared enum, nor a declared model (a composite type, `Unsupported(...)`) is left unclaimed rather than guessed. The producer runs once per service (the schema is not a walked source file), reads the standard `prisma/schema.prisma` location `databases/prisma.ts` already reads, and folds through the same `foldColumns` path as Drizzle. Raw `CREATE TABLE` and TypeORM are the remaining named follow-ons, each a new recognizer emitting `columns` on the endpoint, not a model change.

## Zod-as-contract declared shapes (ADR-170)

`zod-shapes.ts` is a standalone phase (not a `calls/` producer) that reaches the declared field contract of an app treating Zod as the source of truth — a shape the graph could not see before, because a `const UserSchema = z.object({...})` is not even a SymbolNode (`collectSymbolDefs` mints `const` only for arrow / function values, not call expressions). Gated per service on the `zod` dependency, it reads each `.ts`/`.js` AST — `tree-sitter-typescript` for `.ts`/`.tsx`, `tree-sitter-javascript` otherwise (`GRAMMAR_BY_EXT`) — for a **top-level** `z.object({ … })` or `z.enum([ … ])` bound directly to a module-level `const`, and mints it as an `InfraNode` of kind `zod-schema` (`infraId('zod-schema', <const name>)`). The declared fields — the object's top-level keys, or the enum's string members — fold onto the node as EXTRACTED `ColumnAttr` through the read-only `foldColumns`, the same column grain a `sql-table` node carries (ADR-157 §3), so a future declared-vs-observed field comparison has a static twin to land on. The node is owned by its file through a `file ──CONTAINS──▶ zod-schema` edge, the containment spine symbols use one level up. A dedicated `kind` — an open string, so **no** `SCHEMA_VERSION` step and **no** new `NodeType` — rather than a `SymbolKind` (minting Zod consts as symbols would ripple into `symbol-edges.ts`, symbol-grain OBSERVED fusion, and `divergences.ts`). Scope is deliberately narrow: a composed or computed form (`.extend()`, `.merge()`, `.pick()`, a union, a refinement, an object with a spread or a computed key, an enum with a non-literal member) names a partial or dynamic field set, so it is left **unclaimed** — no node — rather than claimed at a partial contract. The read is EXTRACTED-only: a runtime `parse()` failure is not observed at field grain today, so no OBSERVED fusion is wired.

## Foreign-key table→table edges (ADR-161)

`table-edges.ts` is the data-axis sibling of `symbol-edges.ts`: as symbol grain (ADR-158 §3) gave a function its `INHERITS`/`IMPLEMENTS` heritage edges, this gives a table its foreign keys. It mints one `infra:sql-table:<child> ──REFERENCES──▶ infra:sql-table:<parent>` EXTRACTED edge per resolved foreign key, so the data axis — edgeless after column grain (ADR-157) gave tables their columns but no edges between them — becomes walkable: blast radius from a parent table reaches the child tables that reference it, and a child's dependencies include its parent.

The FK is read by a per-ORM reader beside the column reader each already carries, and the parent is always resolved to the **DATABASE table name** — the fusion key `infra:sql-table:<name>` the column/table read and the OTLP `db.statement` parse already land on, so the FK edge fuses onto the existing table node rather than minting a code-model twin. Drizzle's `.references(() => users.id)` names a schema *variable*, resolved through the in-file variable→`pgTable('...')` map (`appUsers` → the table `app_users`). Prisma's `@relation(fields: […], references: […])` mints only on the `fields:` side (the side holding the FK column), so the edge is emitted once and in the child→parent direction, the parent being the relation field's base-type model resolved to its `@@map`/verbatim table name; the back-relation side declares no FK. SQLAlchemy's `ForeignKey('users.id')` names the DB table directly — the parent is the segment before the last dot (`public.users.id` → `users`), the child the enclosing model's table.

The never-guess bar is load-bearing and identical to the symbol-edge one: a computed reference (Drizzle `.references(() => makeRef().id)`), a reference to a table not declared in this file, or a non-string `ForeignKey(User.id)` resolves to nothing and is left **unclaimed** rather than fuzzy-matched — a missing FK edge is a correct partial, a wrong fusion is a bug. Every edge grades `structural` EXTRACTED with `evidence.file`/`line` pinned to the FK declaration site (so `retire.ts` ghost-cleanup keys off it like any EXTRACTED edge), every write is `hasNode`/`hasEdge`-guarded, and a self-referential FK is skipped (the graph disallows self-loops). Raw `CREATE TABLE … REFERENCES`, cross-file FK resolution, composite/table-level constraints, and TypeORM are the named follow-ons — each a new reader emitting a `TableReference`, not a change to the edge or the traversal. Per ADR-161.

## firestore.rules guard sets (ADR-169)

`firestore-rules.ts` is a **standalone** extract phase — registered directly in `extract/index.ts` after the calls phase, not a `calls/` producer — that reads each service's checked-in `firestore.rules` as text (the read-polyglot-as-data discipline `calls/prisma.ts` follows for `schema.prisma`) and folds a `guardedFields` set onto the `firestore-collection` InfraNodes the F1 recognizer (ADR-167) mints. It adds no nodes or edges: it only enriches existing nodes, so it feeds neither extract count and is inert when no `firestore-collection` node exists. It reads no OBSERVED layer, triggers no REST/MCP, and — like every producer — mutates only its own writes.

The scanner recovers the **explicit** field set the rules name on the write path (`create` / `update` / `write`): the string literals in a `request.resource.data.keys().hasAll([...])` / `hasOnly([...])` / `hasAny([...])` call, keyed to the collection the enclosing `match` block declares (nested subcollections compose to a full path, the `/databases/{db}/documents` wrapper and `{wildcard}` document-id segments stripped, lowercased to match `foldColumns`). The never-guess bar is the load-bearing part and it degrades to **silence, not a false claim**: a write guard that is condition-based, function-indirected, or otherwise not reducible to an explicit field list leaves the collection **indeterminate** — no `guardedFields` folded — and any single non-reducible write rule poisons the whole collection to indeterminate. The `field-guard` policy (ADR-169, [`policy-evaluation.md`](./policy-evaluation.md)) then reads this set as its set B; a collection with no folded `guardedFields` is skipped by the check entirely, so an unparseable rules file never manufactures a violation.

## `framework` on ServiceNode

Issue #142 adds `framework?: string` to `ServiceNodeSchema`. This is **schema growth** governed by ADR-031, not a new field on this contract. The producer (`extract/services.ts`) populates it from `dependencies` and `devDependencies` via a package-name → framework-label table:

| Package                | Framework label  |
|------------------------|------------------|
| `express`              | `express`        |
| `fastify`              | `fastify`        |
| `@nestjs/core`         | `nestjs`         |
| `hono`                 | `hono`           |
| `koa`                  | `koa`            |
| `next`                 | `next`           |
| `fastapi` (Python)     | `fastapi`        |
| `flask` (Python)       | `flask`          |
| `django` (Python)      | `django`         |

The table lives in `compat.json` or a sibling data file. Population happens at extract time. The snapshot guard catches schema drift.

## `platform` on ServiceNode/FileNode — Cloudflare Workers/Pages extraction (ADR-133)

`infra/cloudflare.ts` reads `wrangler.toml`/`wrangler.jsonc` (TOML via `smol-toml`; JSONC via the existing comment-mask helper + `JSON.parse` — no new grammar) and stamps two additive fields:

- `platform?: string` on `ServiceNodeSchema` — `'cloudflare'` when the service has a wrangler config. The frontend's icon key at the service-rollup level; a free string, not an enum, the same discipline `framework` already established.
- `platform?: string` + `platformName?: string` on `FileNodeSchema` — stamped on the Worker's entry file (resolved from wrangler's own `main` field, verbatim; not the SDK installer's eight-step entry-detection precedence). `platformName` is the Worker's own script name (wrangler's `name` field) — the only identifier Cloudflare's telemetry carries, and what the Cloudflare connector's `resolveTarget` looks up against (`connectors.md` §4).

Declared Cloudflare resources — KV/D1/R2/Durable Object/Queue bindings, cron triggers, service bindings, routes/custom domains, declared env-var names (never values) — become `InfraNode`s at `infraId(kind, name)` (kinds: `cloudflare-kv`, `cloudflare-d1`, `cloudflare-r2`, `cloudflare-durable-object`, `cloudflare-queue`, `cloudflare-cron`, `cloudflare-route`, `cloudflare-env-var`, `cloudflare-service-binding`), wired from the entry FileNode: `CONNECTS_TO` for routes (network-reachability, matching `dockerfile.ts`'s EXPOSE→port pattern), `DEPENDS_ON` for everything else declarative, `RUNS_ON` to a single shared `infra:workerd:cloudflare` node carrying `compatibility_date` as `evidence.snippet` (matching `dockerfile.ts`'s image-node + entrypoint-snippet pattern). A service binding resolves directly onto the target Worker's own entry FileNode (`CALLS`) when that Worker is tagged in the same scan; otherwise it falls back to a `cloudflare-service-binding` InfraNode, honestly. No new `NodeType`. Per-environment `[env.X]` wrangler sections are out of scope for v1 — only top-level config is read.

**ADR-138 extends the same `platform` field to three more providers.** `infra/vercel.ts` (`vercel.json`/`vercel.jsonc`, plus `.vercel/project.json` for `platformName`), `infra/railway.ts` (`railway.toml`/`railway.json`/`railway.jsonc` — no `platformName`, since Railway's config names no service), and `infra/supabase.ts` (`supabase/config.toml`, `project_id` → `platformName`) each stamp `platform` on the ServiceNode and model their declared resources — Vercel crons/env-var-names/routes, Railway healthcheck/cron, Supabase functions/storage/auth — as `InfraNode`s wired `DEPENDS_ON`/`RUNS_ON`/`CONNECTS_TO` through the shared `emitPlatformResourceEdge` helper. Same discipline as Cloudflare: no new `NodeType`, env-var values never read, `evidence.file` on every edge. Vercel and Railway have no Worker-style entry file, so the tag and the edges anchor on the ServiceNode itself.

## Route extraction + HTTP client↔route matching (ADR-119)

Static extraction reaches route grain. Two producers turn the two static islands — a client that names a URL and a server that declares a route — into one matched, file-precise relationship.

**Server routes (`routes.ts`).** A mainstream router's route table becomes `RouteNode`s at `(method, path-template)` grain, one per declared route, owned by the service through a `service ──CONTAINS──▶ route` edge (structural, evidence pinned to the defining `file:line`). The node id is `routeId(service, method, pathTemplate)` → `route:<service>:<METHOD> <template>`, built from the identity helper. Coverage is a dependency-gated registry — a service is read for routes only when its manifest declares one of the supported routers:

| Router | Recognised shape |
|---|---|
| Express | `app.<method>('/path', …)` / `router.<method>('/path', …)` |
| Fastify | `fastify.<method>('/path', …)` and `fastify.route({ method, url })` |
| Hono | `app.<method>('/path', …)` — same call shape as Express, gated on the `hono` manifest dependency (ADR-133 §5). `app.on([...methods], '/path', …)` isn't recognised — a Cloudflare Worker using it stays at the whole-file grain the connector already falls back to |
| Next.js | app-router `app/**/route.*` handler exports (`GET`/`POST`/…), pages `pages/api/**` handlers |
| NestJS | `@Controller('prefix')` classes with standard HTTP method decorators (`@Get(':id')`, `@Post()`, …), gated on the service's `@nestjs/core` dependency and an `@nestjs/common` import in the source file (ADR-155). Static string prefixes and method paths compose exactly; string arrays expand to their alternatives. Parameter tokens stay verbatim. Computed paths, custom composed decorators, application-level global prefixes, versioning, and inherited metadata stay unattributed rather than guessed. |
| FastAPI / Flask (Python) | `@<router>.<method>('/path', …)` decorators, FastAPI's multi-method `@<router>.api_route('/path', methods=[…])`, and Flask's `@<router>.route('/path', methods=[…])` (defaulting to GET), gated on the `fastapi` / `flask` manifest dependency (ADR-151). Read from the decorator's `.py` AST (`tree-sitter-python`), so a path on its own line in a multi-line decorator is captured. An in-file `APIRouter(prefix='/x')` (FastAPI) or `Blueprint(..., url_prefix='/x')` (Flask) composes its leaf prefix onto each decorator path (`@router.get('/{id}')` on `APIRouter(prefix='/items')` → `/items/{id}`); a prefix built from a config symbol (`prefix=settings.API_V1_STR`) leaves the router unprefixed rather than guessed. An in-file mount composes onto the route: `app.include_router(items, prefix='/api/v1')` (FastAPI) / `app.register_blueprint(bp, url_prefix='/api')` (Flask), with the prefix resolved from a literal or an in-file config constant (`prefix=API_V1_STR`), so the full path is mount + router prefix + decorator path. Cross-file / nested mounting stays the Python analog of Express's out-of-scope `app.use('/api', router)` — a follow-on. |
| Django (Python) | `path('orders/<int:pk>/', view)` entries in a `urlpatterns = […]` list, gated on the `django` manifest dependency (ADR-151). Django dispatches HTTP methods inside the view, not at the URLconf, so a route is method-agnostic (`ALL`). A `path('api/', include('app.urls'))` mount is skipped (cross-file, a follow-on) rather than fabricated; the modern `path()` converter form is recognised, legacy `re_path` regex patterns are a follow-on. The `<int:pk>` converter collapses to `:param` at match time. |
| Rails (Ruby) | `config/routes.rb` read with `tree-sitter-ruby`, gated on the `rails` Gemfile dependency (ADR-173). Explicit verb routes (`get '/x', to: 'c#a'`, the hash-rocket `'/x' => 'c#a'`, and bare `get 'x'`) and `root` are read directly; `resources`/`resource` reimplement Rails' resourceful expansion (`resources` → the seven index/new/create/show/edit/update/destroy rows with update on both PATCH and PUT; the singular `resource` → no index, no `:id`, pluralized controller); `namespace` contributes a path and a controller-module prefix; `scope` contributes a path and/or module prefix; `member`/`collection` add routes to the enclosing resource; `only:`/`except:` restrict the set; one level of nesting stamps the parent's `:<singular>_id` param. The template keeps Rails' `:id` form verbatim — the action_pack OTel instrumentation (Rails ≥ 7.1) sets `http.route` to exactly that string with `(.:format)` stripped, so it fuses through `normalizePathTemplate` with no change. routes.rb metaprogramming (`%i[…].each { resources … }`), `draw(:file)` split files, mounted engines (`mount X => '/y'`), `constraints`, and nesting past one level are deferred — those routes surface as observed-but-not-declared divergence rather than a fabricated node. |
| Laravel (PHP) | `routes/web.php` and `routes/api.php` read with `tree-sitter-php` (`php_only`), gated on the `laravel/framework` composer dependency (ADR-177). Explicit verb routes (`Route::get('/orders/{id}', …)` / `post`/`put`/`patch`/`delete`/`options`, and `any` → `ALL`) read the first string argument; the `{id?}` optional param keeps its braces (the `?` is dropped so the template stays readable); a `->where(...)` / `->name(...)` chained after the verb doesn't change the template. `Route::resource`/`apiResource` reimplement Laravel's convention (`resource` → the seven index/create/store/show/edit/update/destroy rows with update on both PUT and PATCH; `apiResource` → the same minus create and edit) with the singularized resource name as the param; a dotted resource name (`photos.comments`) composes into a nested path best-effort. `Route::prefix('admin')->group(…)` composes a `/admin` prefix across nesting (the `middleware`/`controller`/`name` group forms are recognised too but only `prefix` changes the URL); **every route in `routes/api.php` gets the framework's automatic `/api` prefix**, which isn't in the source. The template keeps Laravel's `{id}` form verbatim — Laravel's OTel auto-instrumentation sets `http.route` to the templated URI, so it fuses through `normalizePathTemplate` (which drops the leading slash and collapses `{…}` to `:param`) with no change. **Symfony is a deliberate non-goal of this rung**: its OTel emits the route NAME, not the path, so it needs a distinct extractor + ingest name-join — extracting its routes without one would mint RouteNodes that never fuse and read as false missing-observed divergences. `config/routes.yaml`, controller-array handler resolution beyond the template, `match`/`redirect`/`view`/`fallback`/singleton/domain routing, resource `->only`/`->except` filtering, and cross-file `require`-split route files are deferred — those routes surface as observed-but-not-declared divergence rather than a fabricated node. |

The declared template is kept verbatim on the node (`/users/:id`, `/items/{item_id}`), so a future OBSERVED server span carrying the same `http.route` lands on the same node — `normalizePathTemplate` collapses `:id`/`{id}`/`[id]` param styles to one matching key. A cross-file Express mount prefix — `app.use('/api', router)` with the router and its routes defined in other files — composes onto the leaf path through `expressMountPrefixes` (ADR-160), a whole-program pass that runs once per Express service after the per-file scan. It resolves each mounted router to its defining file(s) through the same `resolveJsImport` the import graph uses (which reads a dotted module name like `foo.controller` as a filename, not a `.controller` extension, so the `*.controller` / `*.model` naming convention resolves), and prepends the prefix transitively through a chained aggregating `.use()` — `Router().use(ctrl)` mounted under `Router().use('/api', api)` composes `/api/tags`, the exact string a production span carries. The discipline mirrors the Mongoose cross-file pass (ADR-149): a prefix that isn't a `/`-leading string literal (a config symbol or a computed expression), or a mounted router that resolves to no file or ambiguously to many, leaves the leaf un-prefixed rather than guessing — evidence on each route unchanged, mutation authority still in `extract/*`. Intra-file call-graph resolution stays out of scope for this slice. Coverage grows one router at a time through the registry, the same way instrumentation coverage grows; exhaustive router heuristics are a non-goal.

**Client↔route matching (`calls/route-match.ts`).** A recognised HTTP client call site — `fetch`, `axios` (default instance + method calls), node `http`/`https` — carries its method and path-template alongside the host. The host resolves to a service through the shared `buildServiceHostIndex` / `urlMatchesHost` path (ADR-065 #5); the path-template matches a server route by reducing both sides to a param-agnostic key (`normalizePathTemplate`: every dynamic segment — `:id`, `{id}`, `[id]`, a `${…}` interpolation, or a concrete id — collapses to `:param`, literals lowercase). A match mints a route-grained `file ──CALLS──▶ route` EXTRACTED edge from the client's FileNode to the server's RouteNode, carrying the method + path-template on its evidence. It grades `verified-call-site` (0.85) — both endpoints are recognised — so it clears the precision floor. The host + path must sit in the same URL literal for a match; split base-URL + path is out of scope for this slice. Route extraction runs before the calls phase so the matcher sees the full route table.

This realises the cross-service contract-matching idea: the route-grained edge is the shared target an OBSERVED server-span edge (issue #576) also lands on, so `get_divergences` compares declared against observed at route grain, not only at service grain — see [`divergence-query.md`](./divergence-query.md). Per [ADR-119](../decisions.md#adr-119--http-client-call-site--cross-service-route-matching).

## gRPC `.proto` method extraction (ADR-123)

Static extraction reaches gRPC method grain. `proto.ts` reads each service's `.proto` files **as data** — a bounded, brace-balanced line-scan for `service X { rpc Method(Req) returns (Res); }`, the way `calls/kafka.ts` scans for topics and the infra extractors read terraform / Dockerfiles. No tree-sitter grammar and no new language enter the toolchain (CLAUDE.md: Node 20 + TS only; polyglot files are read as data). Each `rpc` becomes a `GrpcMethodNode`, owned by the service the proto lives in through a `service ──CONTAINS──▶ method` edge (structural, evidence pinned to the `rpc` line). Streaming qualifiers (`stream Req` / `stream Res`) don't change method identity.

The node id is `grpcMethodId(rpcService, rpcMethod)` → `grpc:<rpcService>/<rpcMethod>`, built from the identity helper, where `rpcService` is the **fully-qualified** `<package>.<Service>` name the `.proto` declares (`orders.OrderService`). That FQN is precisely the `rpc.service` an OBSERVED gRPC execution span carries (see [`otel-ingest.md`](./otel-ingest.md) §gRPC methods), so the declared method and its observed counterpart fuse onto **one node** rather than twinning — the static half of two-sided gRPC observation. This is the same shape as route extraction: a static producer and an OBSERVED span landing on a shared node, so `get_divergences` compares declared gRPC methods against observed traffic at method grain. Message / field grain, `import` resolution across proto files, and error-detail enrichment are out of scope for this slice. Per ADR-123.

## Symbol-node extraction (ADR-158)

Static extraction reaches symbol grain under the file. `symbols.ts` parses each JS/TS source file with `tree-sitter-javascript` (the language dispatch above — `.ts` / `.tsx` ride the JS grammar) and mints one `SymbolNode` per function, method, constructor, and class **definition**, including the common `const foo = () => {}` arrow/function-expression form. Each symbol carries its source-declared `qualname` (`OrderService.create`, `merge`), its `kind`, and its definition span `{ startLine, endLine }`, and is owned by its file through a `file ──CONTAINS──▶ symbol` edge — the same containment shape files use under services (file-awareness.md §2), one level deeper. The edge is `structural`-graded EXTRACTED with `evidence.file`/`line` pinned to the definition, and every write is `hasNode` / `hasEdge`-guarded like every other producer.

The node id is `symbolId(service, relPath, qualname, disambiguator?)` → `symbol:<service>:<relPath>#<qualname>`, built from the identity helper ([identity.md](./identity.md)); same-named siblings in one file get an ordinal `~<n>` in source order so the id stays collision-free without inventing a name. The node is language-neutral — the tree-sitter grammar is the per-language adapter — so a symbol produced from JS/TS and one a future Python/Go extractor produces are the same shape. The span is the fusion key ingest joins a runtime `code.line` against to land an OBSERVED edge on the calling symbol ([otel-ingest.md](./otel-ingest.md) / file-awareness.md §4). An observed call landing where this producer emitted no symbol mints a `discoveredVia:'otel'` twin in ingest (lifecycle.md), which is the `missing-extracted` signal at symbol grain — static-first fields override it on the next pass.

A `class` definition covers the abstract form too: `abstract class Foo` parses as its own `abstract_class_declaration` node in the TS grammar, and it mints a `class` SymbolNode identically — so a heritage edge to an abstract base (the most common `extends` / `implements` target) has a symbol to resolve onto.

## Symbol-edge extraction (ADR-158 §3)

`symbol-edges.ts` reaches symbol→symbol edges — the confident ones only. Running after `symbols.ts` (the inventory it resolves against) and `imports.ts` (so the import graph is in place), it re-parses each JS/TS file with the same grammars and emits:

- **`INHERITS` / `IMPLEMENTS` (heritage).** From a class's parsed `extends` / `implements` clause: `class ──INHERITS──▶ superclass` and `class ──IMPLEMENTS──▶ implemented`, symbol→symbol, minted only when the parent name resolves to exactly one known SymbolNode of kind `class` — a same-file class, or a named import resolved through `resolveJsImport` to the exported class in the defining file. A qualified parent (`ns.Base`), a mixin call, or an unresolvable/re-exported/default/namespace import emits nothing. Because an interface is not a SymbolNode (a SymbolNode's `kind` is fixed to function/method/constructor/class, ADR-158 §2), `implements <interface>` resolves to nothing and emits no edge — honest, not guessed; interface symbols are a later rung.
- **`CALLS` (symbol→symbol).** For a call expression, the source is the enclosing caller symbol (the innermost definition span containing the call line — the same span-containment ingest uses) and the target is the callee resolved to exactly one symbol: a same-file function/const-arrow, or a named import resolved to a specific exported function. Emitted only for a bare-identifier callee; method dispatch on a receiver (`obj.foo()` — needs the receiver's type), computed/dynamic callees, and callees resolving to zero or many candidates emit nothing. Self-loops (recursion) are not emitted.

Every symbol edge grades `structural` EXTRACTED with `evidence.file`/`line` pinned to the real heritage clause / call site (never fabricated, file-awareness.md §6), and every write is `hasNode` / `hasEdge`-guarded. The never-guess bar is load-bearing: an edge is emitted only when its target resolves to one symbol without a type or a runtime value, because a guessed symbol edge poisons the determinism the graph sells. The type-hard edges (dynamic dispatch, DI, higher-order, reflection) are left to OBSERVED at boundaries and to an optional SCIP ingest, not fuzzy-matched here. Python/Go symbol grain and symbol-grain divergence/traversal are follow-on rungs. Per ADR-158.

## Server Action extraction (ADR-168)

`actions.ts` reaches Next.js Server Actions — the mutation boundary of an App Router app. Gated on the `next` manifest dependency (the same registry discipline `routes.ts` uses), it parses each JS/TS file with the shared `GRAMMAR_BY_EXT` grammars and detects a `"use server"` directive two ways: a **module-level** directive (the leading string statement of the module — every exported async function in the file is then an action) and an **in-body** directive (the leading statement of a function's own body — that one function). Each exported action mints a `ServerActionNode` at `(service, module, exportName)` grain, owned by its file through a `file ──CONTAINS──▶ action` edge — the same containment shape symbols use (file-awareness.md §2). The node id is `serverActionId(service, module, exportName)` → `action:<service>:<module>#<exportName>`, built from the identity helper ([identity.md](./identity.md)).

A second, client-stitch pass mints `file ──CALLS──▶ action` on **any reference** to an imported action binding — a call (`fn(...)`), an `action={fn}` JSX attribute, a `useActionState(fn)` argument, a `fn.bind(...)` receiver — where the imported binding resolves through `resolveJsImport` (honoring `@/*` tsconfig paths, the same specifier→file mechanism `symbol-edges.ts` uses) to exactly one known `ServerActionNode`. "Referenced, not only called" is what closes the form-action gap symbol grain leaves open. Both edges reuse `CONTAINS` / `CALLS` — no new edge type — grade `structural` EXTRACTED with `evidence.file`/`line` pinned to the declaration / reference site, and every write is `hasNode` / `hasEdge`-guarded. The node mirrors the `GraphQLOperationNode` precedent: a first-class node for a surface that collapses onto one HTTP edge, with OBSERVED fusion deferred — Next serializes an action call to an opaque `Next-Action` hash carrying no action name, so there is no declared-vs-observed twin at action grain yet. Per ADR-168.

## Precision filters (ADR-065)

Five pre-emit gates inside the producer pass. A filtered candidate edge is never written to the graph — not added-then-retired. Idempotency stays intact (a re-run filters the same candidates, produces the same graph). Filtered candidates are silent; only true parse failures go to `errors.ndjson`.

All five apply universally across JS / TS / Python. No per-language opt-out.

### 1. Test-scope exclusion

Files matching any of the following are excluded from outbound CALLS / CONNECTS_TO inference:

- `**/__tests__/**`
- `**/__fixtures__/**`
- `**/integration-tests/**`
- `*.spec.{ts,tsx,js,jsx,py}`
- `*.test.{ts,tsx,js,jsx,py}`

The files remain registered as service-internal (a test file belongs to its package); only inferred outbound edges from them are filtered. Path matching is on the file path relative to `scanPath`, normalised to forward slashes. Highest-signal fixture: `packages/core/test/fixtures/precision/test-scope-postgres.spec.ts` (experiment row 0016).

### 2. Comment-body exclusion

No edge is inferred from a string literal whose AST parent (or any ancestor) is a comment node. tree-sitter exposes these via the `comment`, `block_comment`, `line_comment`, and `documentation_comment` node types depending on grammar; the producer's URL-string walker must skip them.

Highest-signal fixture: `packages/core/test/fixtures/precision/comment-body-jsdoc.ts` (experiment row 0014 — a JSDoc `@example` block containing `http://localhost:9000` was extracted as a real CONNECTS_TO edge).

### 3. JSX external-link exclusion

No edge is inferred from a URL string passed as a JSX attribute on an element whose tag matches `/^(a|Link|NavLink|ExternalLink|Anchor)$/`. The semantic shape is "user-clickable hyperlink to a documentation / marketing site," not "service-to-service call." Applies to common attrs (`to`, `href`) and any string-valued attr on a matching tag.

Highest-signal fixture: `packages/core/test/fixtures/precision/jsx-external-link.tsx` (experiment row 0006 — `<Link to="https://medusajs.com/changelog/" target="_blank">` became a CALLS edge to `@medusajs/medusa`).

### 4. `.env.template` exclusion

Files matching the following are documentation, not runtime config. They are not registered as ConfigNodes and produce no CONFIGURED_BY edges:

- `.env.template`
- `.env.example`
- `.env.sample`
- `.env.*.template`
- `.env.*.example`
- `.env.*.sample`

ADR-016 binds ConfigNode to file existence at runtime; templates have no runtime semantics. Highest-signal fixture: `packages/core/test/fixtures/precision/env-template/.env.template` (experiment rows 0008, 0015).

### 5. No URL-substring service matching

A URL whose hostname is `medusa.cloud` does not match the service `@medusajs/medusa` by substring containment. Cross-service inference from URL strings requires:

- An exact hostname match against a registered ServiceNode alias (host:port set in `aliases.ts`), **or**
- An exact hostname match against a registered InfraNode hostname.

`.includes(serviceName.slice(after-slash))` is forbidden. Common-word service names (`api`, `core`, `web`, `medusa`) make substring matching unconditionally wrong. Highest-signal fixtures: experiment rows 0001, 0002, 0003, 0012, 0013.

An exact match that clears this filter — a scheme-qualified URL literal (`http://service-c:3102`, `//service-c/path`) whose hostname equals a registered service's name, dir, or alias — is a **declared HTTP dependency**: the source code names another in-mesh service's URL. It is graded `url-literal-service-target` and lands **at** the precision floor (ADR-066), so it enters the EXTRACTED layer and `missing-observed` can measure it. This is the case a declared-but-never-driven service (`service-c` present in source, never started) must surface through: without a floor-level EXTRACTED CALLS edge there is nothing for `missing-observed` to compare against, and the OBSERVED-thesis blind spot stays open (issue #592). The grade sits below `structural` / `verified-call-site` (0.85) because no call expression wraps the literal — a URL string can be a config default that never runs — and above `url-with-structural-support` (0.5) because scheme + exact host + a resolved registered target is tighter than a bare `redis://host` scheme read. `urlMatchesHost` (scheme + `://` or `//`, exact hostname, exact port when the token carries one) is what keeps this distinct from the sub-floor `hostname-shape-match` tier; a bare hostname token still grades 0.2 and stays out of the graph. The `url-literal-service-target` grade and the infra producers' populated-evidence `CONNECTS_TO` emission are per [ADR-115](../decisions.md#adr-115--url-literal-service-target-grade--infra-connects_to-extraction-amends-adr-066--adr-032).

## Loud failure mode (ADR-065)

Silent partial extraction is forbidden. The previous behaviour — `console.warn(...)` per file with no aggregate — let ~90 medusa files quietly drop out of the snapshot during the v0.3.0 experiment with `neat init` exiting 0.

Per-file extraction failures route through these five behaviours:

1. **`<projectDir>/neat-out/errors.ndjson` append.** One JSON object per line: `{file, error, stack, ts, source: 'extract'}`. Append-only. The `errors.ndjson` artifact already exists for OTel error events (per ADR-033); the `source` discriminator separates extract failures from OTel error events for consumers.

2. **Banner aggregate.** `neat init` and `neat watch` summaries print `[neat] N files skipped due to parse errors` unconditionally. `0 files skipped` is a positive signal that no quiet skipping happened.

3. **`NEAT_STRICT_EXTRACTION=1` flips the exit code.** Any per-file failure causes `neat init` to exit non-zero. Useful in CI ("did this commit make extraction worse?"). Default unset — local dev wants forgiving behaviour with a banner.

4. **Catch + log the real stack at the call site.** "Invalid argument" is the Node N-API generic; the real cause was an extractor calling a method on a missing tree-sitter field. Per-call-site `try`/`catch` captures the parser context, not blanket suppression at the phase level.

5. **Coverage on the query surface (#883).** The banner and `errors.ndjson` are loud at extraction time, but anything querying the graph later saw no signal that a pass partially failed. A daemon reports the most recent full pass's skipped-file count on `/health` as an optional `coverage` field (`{skippedFiles, byProducer, files, updatedAt}`), fed by an overwrite-each-pass sidecar at `<projectDir>/neat-out/extraction-health.json` — per-project-named, mirroring `errors.ndjson`. That sidecar is append-only `errors.ndjson`'s missing counterpart: it answers "is the *current* graph complete?" (each pass overwrites it, zero included), which the append-only log can't. `skippedFiles: 0` is the positive signal; the field is absent only until a pass records it.

## Regression fixture corpus (ADR-065)

`packages/core/test/fixtures/precision/` holds verbatim minimisations of the highest-signal v0.3.0 experiment evidence rows. Each fixture is the smallest reproduction of a row that v0.3.0's extractor produced a false-positive edge for. The contract assertions parameterise over them: "fixture X should produce no extracted edges of type Y."

| Fixture | Filter | Experiment row |
|---|---|---|
| `comment-body-jsdoc.ts` | comment-body exclusion | 0014 |
| `test-scope-postgres.spec.ts` | test-scope exclusion | 0016 |
| `jsx-external-link.tsx` | JSX external-link exclusion | 0006 |
| `env-template/.env.template` | `.env.template` exclusion | 0008 |
| `aws-client-raw.ts` | (also #238 AWS-SDK kind) | 0007 |

Adding a new false-positive shape to the corpus: drop a fixture, add an assertion line.

## Per-file parse-failure isolation (ADR-055)

Every producer that parses per-file content wraps the parse in `try / catch`. On failure: `console.warn` with the producer name, file path, and error message; `continue` to the next file. The phase completes even if some files are unparseable.

```ts
for (const file of files) {
  let parsed: T
  try {
    parsed = await readJson<T>(file)
  } catch (err) {
    console.warn(`[neat] <phase> skipped ${file}: ${(err as Error).message}`)
    continue
  }
  // … use `parsed` …
}
```

Wrap at the call site, not in shared helpers. `readJson` and `readYaml` in `extract/shared.ts` continue to throw on malformed input; producers wrap their call. Keeps warning messages contextual (producer name, file path, failure mode).

File reads that don't parse follow the same pattern when they sit inside a per-file walk — a permission error on one file shouldn't kill the phase.

Conformant sites today: `calls/http.ts`, `owners.ts`, `infra/k8s.ts`, `databases/*`. Sites needing the fix: `services.ts` (×2), `aliases.ts` (×2), `infra/docker-compose.ts`, `infra/dockerfile.ts`. See ADR-055 for the full enumeration and the implementation hand-off.

## Owner extraction (ADR-054)

`extract/services.ts` populates `ServiceNode.owner` per service. Source priority:

1. **CODEOWNERS file.** Read `<scanPath>/CODEOWNERS` first, then `<scanPath>/.github/CODEOWNERS`. Match each service's `repoPath` against the file's patterns. Use the literal RHS of the first matching line (`@org/team`, `email@addr`, etc.).
2. **`package.json` `author` field.** If CODEOWNERS doesn't cover the service's path, read `<service.repoPath>/package.json` and use `author` if present (string form or `name` from object form).
3. **Otherwise undefined.** No git-blame fallback (last-toucher ≠ owner; per-service git invocations are slow).

Format is the literal source value — no normalization in extract. Display-time normalization is the consumer's job.

OTel-auto-created services (per ADR-033) start with `owner: undefined`; static extraction backfills when `extract/services.ts` later discovers source. Property updates on existing nodes are allowed by extract producers per ADR-030.

CODEOWNERS pattern matching in MVP is minimal: support `*`, `**`, and exact paths. No full gitignore-style parser.

## Enforcement

`packages/core/test/audits/contracts.test.ts` includes:

- A scan asserting every EXTRACTED-edge construction site in `extract/` includes an `evidence` field with at least `file`. Lands as `it.todo` keyed to #140 and flips when the issue closes.
- A producer-interface assertion: every `addX` export under `extract/` accepts `(graph, services, scanPath)` (or a strict subset).
- An idempotency assertion: run a producer twice on the same fixture, expect identical graph state.
- Owner-extraction block (`it.todo`s for ADR-054): schema includes optional `owner`; CODEOWNERS at root + at `.github/`; package.json `author` fallback; undefined when neither source covers; backfill on existing nodes from OTel ingest.
- ADR-065 precision-filter block (five `it.todo`s — one per filter — flip live in #237): each loads its fixture, runs the producer, asserts no false-positive edge.
- ADR-065 loud-failure block (three `it.todo`s — flip live in #239): `errors.ndjson` shape, init-banner skipped-count phrase, `NEAT_STRICT_EXTRACTION=1` exit-code flip.

The PreToolUse hook surfaces this contract whenever any file under `extract/` or `watch.ts` is edited.

## Rationale

Static extraction was the most-FAIL'd layer in the verification pass — 7 FAILs and 13 PARTIALs across the tree-sitter audit. Most of them clustered around two missing structural rules: evidence shape on every EXTRACTED edge, and a cleanup mechanism keyed to it. Both rules already informally existed (CALLS edges carry evidence; the audit asks for cleanup). This contract made them universal across producers and tied them to the lifecycle authority that owns retirement.

ADR-065 closes the second cluster: producer-side precision (the v0.3.0 medusa run produced 20 EXTRACTED edges, 100% false positives) and observable failure mode (~90 medusa files silently dropped during the same run). Until both close, `get_divergences` (ADR-060) cannot be load-bearing — the layer it sits on is hallucinated and silently incomplete.

Full rationale and historical context: [ADR-032](../decisions.md#adr-032--static-extraction-contract), [ADR-065](../decisions.md#adr-065--static-extraction-precision-filters--loud-failure-mode-amends-adr-032).

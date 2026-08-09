import { describe, it, expect } from 'vitest'
import {
  laravelMigrationEndpointsFromFile,
  laravelMigrationForeignKeys,
  laravelModelEndpointsFromFile,
  laravelModelForeignKeys,
} from '../src/extract/calls/eloquent.js'

// ADR-178 — PHP/Laravel data axis, rung 2 of the PHP pilot. `database/migrations`
// Schema::create + Blueprint names tables, columns, and foreign keys LITERALLY —
// the schema.rb analog — so a Laravel table joins the graph at the same
// `infra:sql-table:<name>` grain (and ColumnAttr / REFERENCES types) every other
// ORM NEAT reads. Eloquent models add the class↔table link and relation edges;
// the migration literals are the anchor.

const SVC = '/svc'
const mig = (content: string) =>
  laravelMigrationEndpointsFromFile({ path: '/svc/database/migrations/2024_01_01_create.php', content }, SVC)
const migFks = (content: string) =>
  laravelMigrationForeignKeys({ path: '/svc/database/migrations/2024_01_01_create.php', content }, SVC).map(
    (f) => `${f.childTable}->${f.parentTable}`,
  )
const model = (content: string) => laravelModelEndpointsFromFile({ path: '/svc/app/Models/Order.php', content }, SVC)
const modelFks = (content: string) =>
  laravelModelForeignKeys({ path: '/svc/app/Models/Order.php', content }, SVC).map((f) => `${f.childTable}->${f.parentTable}`)

describe('laravelMigrationEndpointsFromFile — Schema::create → sql-table + columns (literal)', () => {
  const MIGRATION = `<?php
    use Illuminate\\Database\\Migrations\\Migration;
    use Illuminate\\Database\\Schema\\Blueprint;
    use Illuminate\\Support\\Facades\\Schema;
    return new class extends Migration {
      public function up(): void {
        Schema::create('orders', function (Blueprint $table) {
          $table->id();
          $table->string('code');
          $table->decimal('total');
          $table->foreignId('user_id')->constrained();
          $table->timestamps();
        });
      }
    };`

  it('reads Schema::create into a sql-table node with the literal name and columns', () => {
    const tables = mig(MIGRATION)
    const orders = tables.find((t) => t.name === 'orders')
    expect(orders).toBeDefined()
    expect(orders!.infraId).toBe('infra:sql-table:orders')
    expect(orders!.kind).toBe('sql-table')
    // Literal string-arg columns are always present; id()/timestamps() expand too.
    expect(orders!.columns).toEqual(expect.arrayContaining(['code', 'total', 'user_id']))
    expect(orders!.evidence.file).toBe('database/migrations/2024_01_01_create.php')
    expect(orders!.evidence.line).toBeGreaterThan(0)
  })
})

describe('laravelMigrationForeignKeys — constrained / explicit / column-only', () => {
  it('mints REFERENCES from foreignId()->constrained() by convention and explicit target', () => {
    const fks = migFks(`<?php
      Schema::create('orders', function (Blueprint $table) {
        $table->foreignId('user_id')->constrained();
        $table->foreignId('acct_id')->constrained('accounts');
      });`)
    expect(fks).toContain('orders->users')
    expect(fks).toContain('orders->accounts')
  })

  it('mints REFERENCES from an explicit foreign()->on() and skips a bare foreignId (column-only)', () => {
    const fks = migFks(`<?php
      Schema::create('orders', function (Blueprint $table) {
        $table->foreign('buyer_id')->references('id')->on('buyers');
        $table->foreignId('note_id');
      });`)
    expect(fks).toContain('orders->buyers')
    // A bare foreignId with no ->constrained() is a column, not a DB foreign key.
    expect(fks.some((f) => f.endsWith('->notes'))).toBe(false)
  })
})

describe('laravelModelEndpointsFromFile — class Order extends Model → table', () => {
  it('derives the table from the pluralized snake_case class name', () => {
    const t = model(`<?php
      namespace App\\Models;
      use Illuminate\\Database\\Eloquent\\Model;
      class Order extends Model {}`)
    expect(t.find((e) => e.name === 'orders')).toBeDefined()
  })

  it('honors a $table override', () => {
    const t = model(`<?php
      namespace App\\Models;
      use Illuminate\\Database\\Eloquent\\Model;
      class Order extends Model {
        protected $table = 'sales_orders';
      }`)
    expect(t.find((e) => e.name === 'sales_orders')).toBeDefined()
  })
})

describe('laravelModelForeignKeys — belongsTo / hasMany relations', () => {
  it('maps belongsTo onto the current table and hasMany onto the related table', () => {
    const fks = modelFks(`<?php
      namespace App\\Models;
      use Illuminate\\Database\\Eloquent\\Model;
      class Order extends Model {
        public function user() { return $this->belongsTo(User::class); }
        public function lineItems() { return $this->hasMany(LineItem::class); }
      }`)
    // belongsTo: this table (orders) references the parent (users).
    expect(fks).toContain('orders->users')
    // hasMany: the FK lives on the other table (line_items references orders).
    expect(fks).toContain('line_items->orders')
  })
})

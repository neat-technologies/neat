# This file is auto-generated from the current state of the database. It is the
# authoritative schema — the table, column, and foreign-key names here are literal.

ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do
  create_table "users", force: :cascade do |t|
    t.string "email"
    t.string "name"
    t.boolean "admin"
    t.timestamps
  end

  create_table "orders", force: :cascade do |t|
    t.string "code"
    t.decimal "total"
    t.jsonb "metadata"
    t.references :user, foreign_key: true
    t.index ["code"], name: "index_orders_on_code"
    t.timestamps
  end

  create_table "line_items", force: :cascade do |t|
    t.integer "quantity"
    t.bigint "order_id"
    t.text "note"
  end

  # No implicit primary key — a join/event table keyed on its own columns.
  create_table "audit_events", id: false, force: :cascade do |t|
    t.string "event"
    t.datetime "occurred_at"
  end

  add_foreign_key "line_items", "orders"
end

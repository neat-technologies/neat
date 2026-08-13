package main

import (
	"context"
	"database/sql"
)

var db *sql.DB

// A plain Query — the SQL is the first (and only string-literal) argument.
func getUser(id int) {
	_, _ = db.Query("SELECT id, email FROM users WHERE id = $1", id)
}

// A *Context variant — ctx is the first argument, the SQL the first string
// literal after it. The old seed read argument 0 blindly and missed these.
func createOrder(ctx context.Context, total int) {
	_, _ = db.ExecContext(ctx, "INSERT INTO orders (total) VALUES ($1)", total)
}

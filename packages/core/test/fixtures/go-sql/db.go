package inventory

import (
	"context"
	"database/sql"

	"github.com/jmoiron/sqlx"
)

type User struct {
	ID    int
	Email string
}

// database/sql, *Context variant — the SQL is the second argument (ctx is first).
func GetUser(ctx context.Context, db *sql.DB, id int) {
	db.QueryRowContext(ctx, "SELECT id, email FROM users WHERE id = $1", id)
}

// database/sql write.
func CreateOrder(db *sql.DB, total int) {
	db.Exec("INSERT INTO orders (total) VALUES ($1)", total)
}

// sqlx — the SQL is the second argument (the destination pointer is first), and the
// statement is a multi-line backtick string.
func GetAccount(dbx *sqlx.DB, id int) {
	var u User
	dbx.Get(&u, `SELECT id, email
		FROM accounts
		WHERE id = $1`, id)
}

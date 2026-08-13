package main

import "github.com/jmoiron/sqlx"

type account struct {
	ID    int    `db:"id"`
	Email string `db:"email"`
}

// sqlx Get puts the destination pointer first, so the SQL is a later argument —
// the "first string-literal argument" scan finds it. The statement is a
// multi-line raw backtick string, the idiomatic Go form.
func getAccount(dbx *sqlx.DB, id int) {
	var a account
	_ = dbx.Get(&a, `SELECT id, email
FROM accounts
WHERE id = $1`, id)
}

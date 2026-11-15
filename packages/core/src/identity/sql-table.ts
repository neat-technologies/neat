// SQL-statement table and column recovery (identity.md, #1641 option B). The
// static SQL-literal extractors (extract/calls/go, dbapi-python, mysql-js) and the
// observed span parser (otel.ts) both run these on a SQL statement, so a declared
// SQL access and an observed one land on the same infra:sql-table:<name> node and
// the same column attributes. Pure string/regex; no imports.

// SQLAlchemy / dbapi instrumentation emits no dedicated table attribute (verified
// against a live app — ADR-152); the table lives only in the `db.statement` SQL.
// Conservative by design: the single table after FROM / INTO / UPDATE, quote- and
// schema-stripped. A joined or multi-`FROM` (subquery) statement degrades to
// `null` — the database-grain edge stands, and the table is never guessed.
// MySQL-style ORMs (xorm, GORM on MySQL, Sequelize on MySQL) quote identifiers
// with backticks, and SQL Server with brackets. Both parsers below read
// double-quoted identifiers, so the other two styles are rewritten to that one
// first. A bracket only counts as quoting where an identifier can start (after
// whitespace, `.`, `(` or `,`), so a Postgres subscript like `tags[i]` is left as
// it is.
function normalizeSqlQuotes(sql: string): string {
  return sql
    .replace(/`([^`]*)`/g, '"$1"')
    .replace(/(^|[\s.(,])\[([A-Za-z_][\w$]*)\]/g, '$1"$2"')
}

export function tableFromSqlStatement(sql: string): string | null {
  if (typeof sql !== 'string' || sql.length === 0) return null
  sql = normalizeSqlQuotes(sql)
  if (/\bjoin\b/i.test(sql)) return null
  const froms = sql.match(/\bfrom\b/gi)
  if (froms && froms.length > 1) return null // subquery / multi-table — degrade
  const m = /\b(?:from|into|update)\s+(?:"?[\w$]+"?\s*\.\s*)?"?([a-zA-Z_][\w$]*)"?/i.exec(sql)
  return m ? m[1]! : null
}

// The columns a SQL statement TOUCHES, for the OBSERVED column-grain attributes
// (ADR-157 §2) — the column sibling of `tableFromSqlStatement` above. Production
// statements are parameterized (values redacted to `$1`), but the column NAMES
// are still in the text: an INSERT names its column list, an UPDATE its SET
// targets, a SELECT its projection, and each of those plus a DELETE names the
// columns in its WHERE predicate. Real ORM SQL is quoted and schema-qualified,
// and SQLAlchemy projects every column as `<table>.<col> AS <table>_<col>`, so
// the parse strips quotes and the table/schema qualifier and drops the `AS`
// alias to recover the REAL column name, never the alias (`orders.id AS
// orders_id` → `id`). Aggregate / function / `*` projections yield no column.
// It degrades to `[]` on the same JOIN / multi-`FROM` (subquery) shapes
// `tableFromSqlStatement` degrades to `null` on — there the columns belong to
// more than one table and can't be attributed honestly. Returned names are
// lowercased and de-duplicated; an unparseable or empty statement yields `[]`.
// Ported verbatim from the proven column-grain spike.
export function columnsFromSqlStatement(sql: string): string[] {
  if (typeof sql !== 'string' || sql.length === 0) return []
  const s = normalizeSqlQuotes(sql).replace(/\s+/g, ' ').trim()
  if (/\bjoin\b/i.test(s)) return []
  if ((s.match(/\bfrom\b/gi) ?? []).length > 1) return [] // subquery / multi-table — degrade

  // One projected/assigned term → its bare column name, or null to skip it (an
  // aggregate / function / wildcard, or a token that isn't a plain identifier).
  const bare = (raw: string): string | null => {
    let t = raw.trim().replace(/"/g, '')
    if (/[()*]/.test(t)) return null // aggregate / func / wildcard — skip
    t = t.split(/\s+as\s+/i)[0]!.trim() // drop "AS alias" — keep the real column
    t = t.split('.').pop()! // drop table / schema qualifier
    return /^[a-z_][\w$]*$/i.test(t) ? t.toLowerCase() : null
  }
  const isCol = (c: string | null): c is string => c !== null
  const cols = (list: string): string[] => [...new Set(list.split(',').map(bare).filter(isCol))]
  const whereCols = (w: string | undefined): string[] =>
    w
      ? [
          ...new Set(
            [
              ...w.matchAll(
                /(?:"?[\w$]+"?\.)?"?([a-z_][\w$]*)"?\s*(?:=|<|>|<=|>=|<>|!=|\bis\b|\bin\b|\blike\b)/gi,
              ),
            ]
              .map((match) => match[1]!.toLowerCase())
              .filter((c) => !/^(and|or|not|null)$/i.test(c)),
          ),
        ]
      : []

  let m: RegExpExecArray | null
  if ((m = /\binsert\s+into\s+(?:"?[\w$]+"?\.)?"?[\w$]+"?\s*\(([^)]*)\)/i.exec(s))) {
    return cols(m[1]!)
  }
  if ((m = /\bupdate\s+(?:"?[\w$]+"?\.)?"?[\w$]+"?\s+set\s+(.+?)(?:\bwhere\b(.+))?$/i.exec(s))) {
    const set = m[1]!
      .split(',')
      .map((p) => bare(p.split('=')[0]!))
      .filter(isCol)
    return [...new Set([...set, ...whereCols(m[2] ?? undefined)])]
  }
  if ((m = /\bdelete\s+from\s+(?:"?[\w$]+"?\.)?"?[\w$]+"?(?:\s+where\b(.+))?$/i.exec(s))) {
    return whereCols(m[1] ?? undefined)
  }
  if ((m = /\bselect\s+(.+?)\s+from\s+(?:"?[\w$]+"?\.)?"?[\w$]+"?(?:\s+where\b(.+))?$/i.exec(s))) {
    if (m[1]!.trim() === '*') return [] // SELECT * — no column list to attribute
    return [...new Set([...cols(m[1]!), ...whereCols(m[2] ?? undefined)])]
  }
  return []
}

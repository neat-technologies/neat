import { describe, it, expect } from 'vitest'
import { tableFromSqlStatement, columnsFromSqlStatement } from '../src/otel.js'

// The OBSERVED table and column grain read the target out of `db.statement`.
// Postgres ORMs quote identifiers with double quotes, MySQL-style ORMs (xorm,
// GORM on MySQL, Sequelize on MySQL) with backticks, SQL Server with brackets.
// All three name the same table.

describe('tableFromSqlStatement across quoting styles', () => {
  const cases: Array<[string, string, string]> = [
    ['double quotes', 'SELECT "id", "name" FROM "user" WHERE "id" = $1', 'user'],
    ['backticks', 'SELECT `id`, `name` FROM `user` WHERE `id`=?', 'user'],
    ['brackets', 'SELECT [id], [name] FROM [user] WHERE [id] = @p0', 'user'],
    ['bare', 'SELECT id FROM user WHERE id = ?', 'user'],
  ]
  for (const [style, sql, table] of cases) {
    it(`reads the table from ${style}`, () => expect(tableFromSqlStatement(sql)).toBe(table))
  }

  it('strips a quoted schema in every style', () => {
    expect(tableFromSqlStatement('SELECT * FROM "public"."repository"')).toBe('repository')
    expect(tableFromSqlStatement('SELECT * FROM `gitea`.`repository`')).toBe('repository')
    expect(tableFromSqlStatement('SELECT * FROM [dbo].[repository]')).toBe('repository')
  })

  it('reads INSERT and UPDATE targets the way xorm writes them', () => {
    expect(tableFromSqlStatement('INSERT INTO `action` (`user_id`,`op_type`) VALUES (?,?)')).toBe('action')
    expect(tableFromSqlStatement('UPDATE `repository` SET `num_stars`=? WHERE `id`=?')).toBe('repository')
    expect(tableFromSqlStatement('UPDATE [repository] SET [num_stars] = @p0 WHERE [id] = @p1')).toBe('repository')
  })

  it('still degrades a join to null whatever the quoting', () => {
    expect(tableFromSqlStatement('SELECT * FROM `a` INNER JOIN `b` ON `a`.`id`=`b`.`a_id`')).toBeNull()
  })

  it('leaves a Postgres subscript alone', () => {
    expect(columnsFromSqlStatement('UPDATE "post" SET "tags"[1] = $1 WHERE "id" = $2')).toContain('id')
  })
})

describe('columnsFromSqlStatement across quoting styles', () => {
  it('reads the same columns from all three styles', () => {
    const want = ['id', 'name', 'owner_id']
    expect(columnsFromSqlStatement('SELECT "id", "name" FROM "repository" WHERE "owner_id" = $1').sort()).toEqual(want)
    expect(columnsFromSqlStatement('SELECT `id`, `name` FROM `repository` WHERE `owner_id`=?').sort()).toEqual(want)
    expect(columnsFromSqlStatement('SELECT [id], [name] FROM [repository] WHERE [owner_id] = @p0').sort()).toEqual(want)
  })

  it('reads an xorm INSERT column list', () => {
    expect(columnsFromSqlStatement('INSERT INTO `action` (`user_id`,`op_type`) VALUES (?,?)').sort()).toEqual(['op_type', 'user_id'])
  })
})

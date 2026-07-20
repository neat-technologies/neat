import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseDotenv } from '../src/extract/databases/dotenv.js'
import { parse as parsePrisma } from '../src/extract/databases/prisma.js'
import { parse as parseDrizzle } from '../src/extract/databases/drizzle.js'
import { parse as parseKnex } from '../src/extract/databases/knex.js'
import { parse as parseOrmConfig } from '../src/extract/databases/ormconfig.js'
import { parse as parseTypeorm } from '../src/extract/databases/typeorm.js'
import { parse as parseSequelize } from '../src/extract/databases/sequelize.js'
import { parse as parseDockerCompose } from '../src/extract/databases/docker-compose.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'db')

describe('database source parsers', () => {
  it('reads DATABASE_URL out of .env', async () => {
    const configs = await parseDotenv(path.join(FIXTURES, 'dotenv'))
    expect(configs).toHaveLength(3)
    expect(configs[0]).toMatchObject({
      engine: 'postgresql',
      host: 'db.internal',
      port: 5432,
      database: 'orders',
      engineVersion: 'unknown',
    })
    expect(configs[1]).toMatchObject({
      engine: 'redis',
      host: 'cache.internal',
      port: 6379,
      database: '',
      engineVersion: 'unknown',
    })
    // #832 — MONGODB_URL is the most common Mongo env-var name and was missing
    // from the recognized keys, so an app's own DB connection went unextracted
    // and the runtime span minted a twin `database:<host>` instead of fusing.
    expect(configs[2]).toMatchObject({
      engine: 'mongodb',
      host: 'mongo.internal',
      port: 27017,
      database: 'events',
    })
    // Every parsed config carries the source file it came from (#140).
    expect(configs[0]!.sourceFile).toMatch(/\.env$/)
  })

  it('reads provider + url out of prisma/schema.prisma', async () => {
    const configs = await parsePrisma(path.join(FIXTURES, 'prisma'))
    expect(configs[0]).toMatchObject({ engine: 'postgresql', host: 'prisma-db', port: 5432 })
  })

  it('reads dialect + host out of drizzle.config.ts', async () => {
    const configs = await parseDrizzle(path.join(FIXTURES, 'drizzle'))
    expect(configs[0]).toMatchObject({ engine: 'postgresql', host: 'drizzle-host', port: 5432 })
  })

  it('reads client + host out of knexfile.js', async () => {
    const configs = await parseKnex(path.join(FIXTURES, 'knex'))
    expect(configs[0]).toMatchObject({ engine: 'mysql', host: 'knex-host', port: 3306 })
  })

  it('reads ormconfig.json', async () => {
    const configs = await parseOrmConfig(path.join(FIXTURES, 'ormconfig'))
    expect(configs[0]).toMatchObject({ engine: 'postgresql', host: 'ormconfig-host', port: 5432 })
  })

  it('reads new DataSource() out of data-source.ts', async () => {
    const configs = await parseTypeorm(path.join(FIXTURES, 'typeorm'))
    expect(configs[0]).toMatchObject({ engine: 'postgresql', host: 'typeorm-host', port: 5432 })
  })

  it('reads each environment in sequelize config/config.json', async () => {
    const configs = await parseSequelize(path.join(FIXTURES, 'sequelize'))
    expect(configs).toHaveLength(2)
    expect(configs.find((c) => c.engine === 'mysql')?.host).toBe('sequelize-host')
    expect(configs.find((c) => c.engine === 'sqlite')?.host).toBe('sequelize-host')
  })

  it('reads docker-compose services + image versions', async () => {
    const configs = await parseDockerCompose(path.join(FIXTURES, 'docker-compose'))
    const postgres = configs.find((c) => c.host === 'postgres')
    const cache = configs.find((c) => c.host === 'cache')
    expect(postgres).toMatchObject({
      engine: 'postgresql',
      engineVersion: '15',
      port: 5432,
      database: 'shop',
    })
    expect(cache).toMatchObject({ engine: 'redis', engineVersion: '7', port: 6379 })
    // node:20 is not a DB image — must not appear.
    expect(configs.find((c) => c.host === 'app')).toBeUndefined()
  })

  it('returns nothing for an unknown source type', async () => {
    const dir = path.join(FIXTURES, 'unknown-source')
    expect(await parseDotenv(dir)).toEqual([])
    expect(await parsePrisma(dir)).toEqual([])
    expect(await parseDrizzle(dir)).toEqual([])
    expect(await parseKnex(dir)).toEqual([])
    expect(await parseOrmConfig(dir)).toEqual([])
    expect(await parseTypeorm(dir)).toEqual([])
    expect(await parseSequelize(dir)).toEqual([])
    expect(await parseDockerCompose(dir)).toEqual([])
  })
})

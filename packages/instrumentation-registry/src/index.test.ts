import { describe, expect, it } from 'vitest'
import { list, resolve } from './index.js'

describe('schema validation', () => {
  it('seed JSON validates against the Zod schema without throwing', () => {
    expect(() => list()).not.toThrow()
  })
})

describe('resolve()', () => {
  it('resolves @prisma/client@5.3.0 to the Prisma 5 entry', () => {
    const entry = resolve('@prisma/client', '5.3.0')
    expect(entry).not.toBeNull()
    expect(entry!.coverage).toBe('first-party')
    expect(entry!.instrumentation_package).toBe('@prisma/instrumentation')
    expect(entry!.package_version).toBe('^5.0.0')
  })

  it('resolves @prisma/client@6.1.0 to the Prisma 6 entry', () => {
    const entry = resolve('@prisma/client', '6.1.0')
    expect(entry).not.toBeNull()
    expect(entry!.coverage).toBe('first-party')
    expect(entry!.instrumentation_package).toBe('@prisma/instrumentation')
    expect(entry!.package_version).toBe('^6.0.0')
  })

  it('returns null for an unknown library', () => {
    expect(resolve('not-a-real-library')).toBeNull()
  })

  it('resolves express to bundled', () => {
    const entry = resolve('express')
    expect(entry).not.toBeNull()
    expect(entry!.coverage).toBe('bundled')
  })

  it('resolves hono to gap', () => {
    const entry = resolve('hono')
    expect(entry).not.toBeNull()
    expect(entry!.coverage).toBe('gap')
  })

  it('resolves stripe to http-only', () => {
    const entry = resolve('stripe')
    expect(entry).not.toBeNull()
    expect(entry!.coverage).toBe('http-only')
  })
})

describe('list()', () => {
  it('returns at least 80 entries', () => {
    expect(list().length).toBeGreaterThanOrEqual(80)
  })

  it('every entry has library and coverage', () => {
    for (const entry of list()) {
      expect(entry.library).toBeTruthy()
      expect(entry.coverage).toBeTruthy()
    }
  })
})

describe('postgres.js', () => {
  it('points at the instrumentation @neat.is/otel-node ships', () => {
    const entry = resolve('postgres', '3.4.9')
    expect(entry?.coverage).toBe('third-party')
    expect(entry && 'instrumentation_package' in entry ? entry.instrumentation_package : undefined).toBe('@neat.is/otel-node')
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { FastifyInstance } from 'fastify'
import { buildApi } from '../src/api.js'
import { Projects, pathsForProject } from '../src/projects.js'
import { getGraph, resetGraph } from '../src/graph.js'
import {
  writeExtractionHealth,
  readExtractionHealth,
  extractionHealthPathFor,
  type ExtractionError,
} from '../src/extract/errors.js'

// #883 — per-file parse failures already land in errors.ndjson + the init/watch
// banner, but the count never reached the query surface, so an agent queried a
// silently-incomplete graph. A daemon now surfaces the latest pass's coverage on
// /health, fed by an overwrite-each-pass sidecar (errors.ndjson is append-only
// and can't answer "is the current graph complete?").

function err(producer: string, file: string): ExtractionError {
  return {
    producer,
    file,
    error: 'Invalid argument',
    ts: '2026-07-29T00:00:00.000Z',
    source: 'extract',
  }
}

describe('#883 — extraction coverage sidecar', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-883-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('names the sidecar beside errors.ndjson, mirroring per-project naming', () => {
    expect(extractionHealthPathFor('/x/neat-out/errors.ndjson')).toBe(
      '/x/neat-out/extraction-health.json',
    )
    expect(extractionHealthPathFor('/x/neat-out/errors.api.ndjson')).toBe(
      '/x/neat-out/extraction-health.api.json',
    )
  })

  it('round-trips the count, per-producer tally and a file sample', async () => {
    const p = path.join(dir, 'extraction-health.json')
    await writeExtractionHealth(
      [err('http', 'a.ts'), err('http', 'b.ts'), err('services', 'c.ts')],
      p,
    )
    const cov = await readExtractionHealth(p)
    expect(cov).toMatchObject({ skippedFiles: 3, byProducer: { http: 2, services: 1 } })
    expect(cov!.files).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('overwrites each pass so a clean re-run clears a prior gap', async () => {
    const p = path.join(dir, 'extraction-health.json')
    await writeExtractionHealth([err('http', 'a.ts')], p)
    await writeExtractionHealth([], p)
    expect((await readExtractionHealth(p))!.skippedFiles).toBe(0)
  })

  it('reads back undefined for an absent or malformed sidecar', async () => {
    expect(await readExtractionHealth(path.join(dir, 'nope.json'))).toBeUndefined()
    await fs.writeFile(path.join(dir, 'bad.json'), 'not-json', 'utf8')
    expect(await readExtractionHealth(path.join(dir, 'bad.json'))).toBeUndefined()
  })

  it('surfaces coverage on /health when the sidecar exists', async () => {
    resetGraph('cov')
    const paths = pathsForProject('cov', dir)
    await writeExtractionHealth(
      [err('http call extraction', 'src/lib/fixtures.ts')],
      extractionHealthPathFor(paths.errorsPath),
    )
    const registry = new Projects()
    registry.set('cov', { graph: getGraph('cov'), paths })
    const app: FastifyInstance = await buildApi({ projects: registry })
    try {
      const res = await app.inject({ method: 'GET', url: '/projects/cov/health' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { coverage?: { skippedFiles: number; files: string[] } }
      expect(body.coverage?.skippedFiles).toBe(1)
      expect(body.coverage?.files).toContain('src/lib/fixtures.ts')
    } finally {
      await app.close()
      resetGraph('cov')
    }
  })

  it('omits coverage on /health when no pass has recorded it', async () => {
    resetGraph('nocov')
    const paths = pathsForProject('nocov', dir)
    const registry = new Projects()
    registry.set('nocov', { graph: getGraph('nocov'), paths })
    const app: FastifyInstance = await buildApi({ projects: registry })
    try {
      const res = await app.inject({ method: 'GET', url: '/projects/nocov/health' })
      expect(res.statusCode).toBe(200)
      expect((res.json() as { coverage?: unknown }).coverage).toBeUndefined()
    } finally {
      await app.close()
      resetGraph('nocov')
    }
  })
})

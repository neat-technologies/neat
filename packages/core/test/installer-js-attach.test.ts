import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { javascriptInstaller } from '../src/installers/index.js'
import { attachPackageRange } from '../src/installers/javascript.js'
import { readPackageVersion } from '../src/banner.js'

// ADR-232 — the JS installer's default delivery is runtime attachment: it adds
// @neat.is/otel-node and a NODE_OPTIONS preload in .env.neat, and edits no
// source. Source-edit injection runs only when the caller asks for it.

const dirs: string[] = []

async function service(pkg: Record<string, unknown>, files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-js-attach-'))
  dirs.push(dir)
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), body)
  }
  return dir
}

afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true })
})

function envNeat(plan: { generatedFiles?: { file: string; contents: string }[] }): string {
  return plan.generatedFiles?.find((f) => f.file.endsWith('.env.neat'))?.contents ?? ''
}

describe('JS installer — attachment by default (ADR-232)', () => {
  it('adds otel-node at the lockstep version and a --require preload for a CJS service, with no source edit', async () => {
    const dir = await service(
      { name: 'orders', version: '1.0.0', main: 'index.js', dependencies: { express: '^4.19.0' } },
      { 'index.js': "require('express')().listen(3000)\n" },
    )
    const plan = await javascriptInstaller.plan(dir, { project: 'shop' })

    expect(plan.entrypointEdits).toEqual([])
    expect(plan.dependencyEdits).toEqual([
      expect.objectContaining({ kind: 'add', name: '@neat.is/otel-node', version: attachPackageRange() }),
    ])
    expect(plan.generatedFiles?.some((f) => /otel-init/.test(f.file))).toBe(false)
    expect(envNeat(plan)).toContain('NODE_OPTIONS="--require @neat.is/otel-node/register"')
    // The preload resolves the project daemon's port itself; an exported fixed
    // endpoint would override it and misroute a second project's spans (#879).
    expect(envNeat(plan)).not.toMatch(/^OTEL_EXPORTER_OTLP_(TRACES_)?ENDPOINT=/m)
    expect(envNeat(plan)).toMatch(/^NEAT_PROJECT=shop$/m)
  })

  it('uses --import for an ESM service', async () => {
    const dir = await service(
      { name: 'web', version: '1.0.0', type: 'module', main: 'server.js', dependencies: { express: '^4.19.0' } },
      { 'server.js': "import express from 'express'\nexpress().listen(3000)\n" },
    )
    const plan = await javascriptInstaller.plan(dir, { project: 'shop' })
    expect(envNeat(plan)).toContain('NODE_OPTIONS="--import @neat.is/otel-node/register"')
  })

  it("names the registry's non-bundled instrumentations for the preload and adds their packages", async () => {
    const dir = await service(
      {
        name: 'api',
        version: '1.0.0',
        main: 'main.js',
        dependencies: { '@prisma/client': '^6.1.0', '@nestjs/core': '^11.0.0' },
      },
      { 'main.js': "require('@nestjs/core')\n" },
    )
    const plan = await javascriptInstaller.plan(dir, { project: 'shop' })
    const added = plan.dependencyEdits.map((d) => `${d.name}@${d.version}`)
    expect(added).toContain('@prisma/instrumentation@^6.0.0')
    expect(added).toContain('@opentelemetry/instrumentation-nestjs-core@^0.67.0')
    expect(envNeat(plan)).toMatch(
      /^NEAT_OTEL_INSTRUMENTATIONS=@prisma\/instrumentation#PrismaInstrumentation,@opentelemetry\/instrumentation-nestjs-core#NestInstrumentation$/m,
    )
    expect(plan.entrypointEdits).toEqual([])
  })

  it('does not add otel-node twice', async () => {
    const dir = await service(
      { name: 'orders', version: '1.0.0', main: 'index.js', dependencies: { '@neat.is/otel-node': '^0.10.5' } },
      { 'index.js': 'module.exports = 1\nconsole.log(1)\n' },
    )
    const plan = await javascriptInstaller.plan(dir, { project: 'shop' })
    expect(plan.dependencyEdits).toEqual([])
  })

  it('still skips a library with no entry point', async () => {
    const dir = await service({ name: 'lib', version: '1.0.0' }, {})
    const plan = await javascriptInstaller.plan(dir, { project: 'shop' })
    expect(plan.libOnly).toBe(true)
    expect(plan.dependencyEdits).toEqual([])
  })

  it('injects into source only under an explicit sourceEdit', async () => {
    const dir = await service(
      { name: 'orders', version: '1.0.0', main: 'index.js', dependencies: { express: '^4.19.0' } },
      { 'index.js': "require('express')().listen(3000)\n" },
    )
    const plan = await javascriptInstaller.plan(dir, { project: 'shop', sourceEdit: true })
    expect(plan.entrypointEdits.length).toBeGreaterThan(0)
    expect(plan.dependencyEdits.some((d) => d.name === '@neat.is/otel-node')).toBe(false)
  })
})

describe('attachPackageRange', () => {
  it('tracks this core version, so the installed otel-node is the one released with it', () => {
    expect(attachPackageRange()).toBe(`^${readPackageVersion()}`)
    expect(attachPackageRange('0.11.0')).toBe('^0.11.0')
    expect(attachPackageRange('0.10.6-dev.20261008')).toBe('^0.10.6-dev.20261008')
    expect(attachPackageRange('unknown')).toBe('latest')
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Parser from 'tree-sitter'
import Php from 'tree-sitter-php'
import { phpInstaller, isEmptyPlan } from '../src/installers/index.js'
import { neatOtelPhp } from '../src/installers/php.js'

// ADR-186 — the PHP SDK installer. Detects a composer.json, adds the
// OpenTelemetry Composer packages (auto-laravel for a Laravel app), and
// generates a neat_otel.php bootstrap. PHP OTel auto-instrumentation needs the
// `opentelemetry` PECL extension, which composer cannot install — the installer
// plans it and surfaces it as a required user step rather than pretending
// composer alone instruments PHP. File-grain is a documented follow-up.

function hasErrorNode(node: Parser.SyntaxNode): boolean {
  if (node.type === 'ERROR' || node.isMissing) return true
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (c && hasErrorNode(c)) return true
  }
  return false
}

describe('generated neat_otel.php', () => {
  it('is syntactically valid PHP', () => {
    const parser = new Parser()
    parser.setLanguage(Php.php_only)
    const tree = parser.parse(neatOtelPhp({ project: 'blog' }))
    expect(hasErrorNode(tree.rootNode)).toBe(false)
  })

  it('surfaces the PECL requirement and degrades without the extension', () => {
    const src = neatOtelPhp({ project: 'blog' })
    // The honesty requirement: the PECL step must be named plainly.
    expect(src).toContain('pecl install opentelemetry')
    expect(src).toContain('NEAT CANNOT DO THIS FOR YOU')
    // Degrade to a no-op when the extension is absent (never break the host).
    expect(src).toContain("extension_loaded('opentelemetry')")
    // File-grain is deferred, and the file says so.
    expect(src).toMatch(/FILE-GRAIN.*follow-up/s)
  })

  it('turns on the SDK autoloader and bakes the project-scoped OTLP path (ADR-183)', () => {
    const src = neatOtelPhp({ project: 'blog' })
    expect(src).toContain('OTEL_PHP_AUTOLOAD_ENABLED')
    expect(src).toContain('http://localhost:4318/projects/blog/v1/traces')
    // Ad-hoc / test callers with no project fall back to the bare traces path.
    expect(neatOtelPhp()).toContain('http://localhost:4318/v1/traces')
  })
})

describe('php installer plan + apply (Laravel)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-php-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function laravelFixture(): Promise<void> {
    await fs.writeFile(
      path.join(dir, 'composer.json'),
      JSON.stringify(
        {
          name: 'acme/blog',
          type: 'project',
          require: { php: '^8.2', 'laravel/framework': '^11.0' },
          'require-dev': { 'phpunit/phpunit': '^11.0' },
        },
        null,
        2,
      ) + '\n',
    )
  }

  it('detect claims a composer.json', async () => {
    await laravelFixture()
    expect(await phpInstaller.detect(dir)).toBe(true)
  })

  it('plan adds the OTel packages + auto-laravel + bootstrap, and surfaces the PECL step', async () => {
    await laravelFixture()
    const plan = await phpInstaller.plan(dir, { project: 'blog' })
    expect(plan.language).toBe('php')
    expect(isEmptyPlan(plan)).toBe(false)

    const composer = path.join(dir, 'composer.json')
    const names = plan.dependencyEdits.map((d) => d.name)
    expect(names).toContain('open-telemetry/sdk')
    expect(names).toContain('open-telemetry/exporter-otlp')
    expect(names).toContain('open-telemetry/opentelemetry-auto-laravel')
    for (const dep of plan.dependencyEdits) {
      expect(dep.kind).toBe('add')
      expect(dep.file).toBe(composer)
    }
    const bootstrap = path.join(dir, 'neat_otel.php')
    const generated = plan.generatedFiles ?? []
    expect(generated.map((g) => g.file)).toContain(bootstrap)
    // The generated bootstrap carries the PECL step so the dry-run patch shows it.
    expect(generated.find((g) => g.file === bootstrap)!.contents).toContain('pecl install opentelemetry')
  })

  it('plan is pure data — it writes nothing to disk (dry-run parity)', async () => {
    await laravelFixture()
    const before = await fs.readFile(path.join(dir, 'composer.json'), 'utf8')
    await phpInstaller.plan(dir, { project: 'blog' })
    expect(await fs.readFile(path.join(dir, 'composer.json'), 'utf8')).toBe(before)
    await expect(fs.stat(path.join(dir, 'neat_otel.php'))).rejects.toThrow()
  })

  it('apply merges composer.json (never clobbers), writes the bootstrap, surfaces PECL, and is idempotent', async () => {
    await laravelFixture()
    const plan = await phpInstaller.plan(dir, { project: 'blog' })
    const result = await phpInstaller.apply(plan)
    expect(result.outcome).toBe('instrumented')
    // The apply result surfaces the PECL step to the caller / summary.
    expect(result.reason).toContain('pecl install opentelemetry')

    const composer = JSON.parse(await fs.readFile(path.join(dir, 'composer.json'), 'utf8'))
    // merge, never clobber — every original key survives.
    expect(composer.name).toBe('acme/blog')
    expect(composer.type).toBe('project')
    expect(composer.require.php).toBe('^8.2')
    expect(composer.require['laravel/framework']).toBe('^11.0')
    expect(composer['require-dev']['phpunit/phpunit']).toBe('^11.0')
    // new packages landed in require
    expect(composer.require['open-telemetry/sdk']).toBeDefined()
    expect(composer.require['open-telemetry/opentelemetry-auto-laravel']).toBeDefined()

    const bootstrap = await fs.readFile(path.join(dir, 'neat_otel.php'), 'utf8')
    expect(bootstrap).toContain('http://localhost:4318/projects/blog/v1/traces')

    // Second pass: packages present + bootstrap present → empty plan → no-op.
    const plan2 = await phpInstaller.plan(dir, { project: 'blog' })
    expect(isEmptyPlan(plan2)).toBe(true)
    const result2 = await phpInstaller.apply(plan2)
    expect(result2.outcome).toBe('already-instrumented')
  })

  it('preserves an existing bootstrap (createOnly)', async () => {
    await laravelFixture()
    const bootstrap = path.join(dir, 'neat_otel.php')
    await fs.writeFile(bootstrap, '<?php // hand-written\n')
    const plan = await phpInstaller.plan(dir, { project: 'blog' })
    expect((plan.generatedFiles ?? []).some((g) => g.file === bootstrap)).toBe(false)
    await phpInstaller.apply(plan)
    expect(await fs.readFile(bootstrap, 'utf8')).toBe('<?php // hand-written\n')
  })

  it('a non-Laravel PHP service skips the auto-laravel package', async () => {
    await fs.writeFile(
      path.join(dir, 'composer.json'),
      JSON.stringify({ name: 'acme/lib', require: { php: '^8.2' } }, null, 2) + '\n',
    )
    const plan = await phpInstaller.plan(dir, { project: 'svc' })
    const names = plan.dependencyEdits.map((d) => d.name)
    expect(names).toContain('open-telemetry/sdk')
    expect(names).not.toContain('open-telemetry/opentelemetry-auto-laravel')
  })
})

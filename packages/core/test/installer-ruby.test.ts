import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Parser from 'tree-sitter'
import Ruby from 'tree-sitter-ruby'
import { rubyInstaller, isEmptyPlan } from '../src/installers/index.js'
import { neatOtelRb } from '../src/installers/ruby.js'

// ADR-186 — the Ruby SDK installer. Detects a Gemfile, adds the OpenTelemetry
// gems, and for a Rails app generates a config/initializers/neat_otel.rb that
// wires the OTLP exporter and a call-site span processor stamping the stable
// code.* attributes on CLIENT/PRODUCER spans for file-grain fusion.

function hasErrorNode(node: Parser.SyntaxNode): boolean {
  if (node.type === 'ERROR' || node.isMissing) return true
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (c && hasErrorNode(c)) return true
  }
  return false
}

describe('generated neat_otel.rb', () => {
  it('is syntactically valid Ruby', () => {
    const parser = new Parser()
    parser.setLanguage(Ruby)
    const tree = parser.parse(neatOtelRb({ project: 'blog' }))
    expect(hasErrorNode(tree.rootNode)).toBe(false)
  })

  it('stamps the stable OTel code attributes off an app-root-filtered caller frame', () => {
    const src = neatOtelRb({ project: 'blog' })
    // The stable names ingest reads for file-grain fusion (matches go.ts).
    expect(src).toContain('code.file.path')
    expect(src).toContain('code.line.number')
    expect(src).toContain('code.function.name')
    // Only CLIENT/PRODUCER spans are stamped; SERVER stays route/service-grained.
    expect(src).toContain('OpenTelemetry::Trace::SpanKind::CLIENT')
    expect(src).toContain('OpenTelemetry::Trace::SpanKind::PRODUCER')
    // The call site is found by walking caller_locations to the first frame
    // under the app root, skipping vendored gems.
    expect(src).toContain('caller_locations')
    expect(src).toContain('start_with?(@root)')
    expect(src).toContain('/vendor/')
    // Absolute path is emitted; ingest anchors it against the service root.
    expect(src).toContain('loc.absolute_path')
  })

  it('turns on the auto-instrumentation set and degrades without the gems', () => {
    const src = neatOtelRb({ project: 'blog' })
    expect(src).toContain('c.use_all')
    expect(src).toContain('OpenTelemetry::SDK.configure')
    // ADR-144 discipline: a bare app without the gems must still boot.
    expect(src).toContain('rescue LoadError')
    expect(src).toContain('# never break the host application')
  })

  it('bakes the project-scoped OTLP path when a project is known (ADR-183)', () => {
    expect(neatOtelRb({ project: 'blog' })).toContain('http://localhost:4318/projects/blog/v1/traces')
    // Ad-hoc / test callers with no project fall back to the bare traces path.
    expect(neatOtelRb()).toContain('http://localhost:4318/v1/traces')
  })
})

describe('ruby installer detect', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-ruby-detect-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('claims a Gemfile', async () => {
    await fs.writeFile(path.join(dir, 'Gemfile'), "source 'https://rubygems.org'\n")
    expect(await rubyInstaller.detect(dir)).toBe(true)
  })

  it('claims a Gemfile.lock but plans no lockfile edits', async () => {
    await fs.writeFile(path.join(dir, 'Gemfile.lock'), 'GEM\n  remote: https://rubygems.org/\n')
    expect(await rubyInstaller.detect(dir)).toBe(true)
    const plan = await rubyInstaller.plan(dir)
    // No Gemfile on disk → nothing to safely edit, and never a lockfile ref.
    expect(isEmptyPlan(plan)).toBe(true)
    const files = [
      ...plan.dependencyEdits.map((e) => e.file),
      ...(plan.generatedFiles ?? []).map((g) => g.file),
    ]
    expect(files.some((f) => f.endsWith('Gemfile.lock'))).toBe(false)
  })

  it('ignores a directory with neither', async () => {
    expect(await rubyInstaller.detect(dir)).toBe(false)
  })
})

describe('ruby installer plan + apply (Rails)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-ruby-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function railsFixture(): Promise<void> {
    await fs.writeFile(
      path.join(dir, 'Gemfile'),
      "source 'https://rubygems.org'\n\ngem 'rails', '~> 7.1'\ngem 'pg'\n",
    )
    await fs.mkdir(path.join(dir, 'config'), { recursive: true })
    await fs.writeFile(path.join(dir, 'config', 'application.rb'), "module Blog\n  class Application; end\nend\n")
  }

  it('plan adds the OTel gems and the Rails initializer, targeting the Gemfile', async () => {
    await railsFixture()
    const plan = await rubyInstaller.plan(dir, { project: 'blog' })
    expect(plan.language).toBe('ruby')
    expect(isEmptyPlan(plan)).toBe(false)

    const gemfile = path.join(dir, 'Gemfile')
    const names = plan.dependencyEdits.map((d) => d.name)
    expect(names).toContain('opentelemetry-sdk')
    expect(names).toContain('opentelemetry-exporter-otlp')
    expect(names).toContain('opentelemetry-instrumentation-all')
    for (const dep of plan.dependencyEdits) {
      expect(dep.kind).toBe('add')
      expect(dep.file).toBe(gemfile)
    }
    const initializer = path.join(dir, 'config', 'initializers', 'neat_otel.rb')
    expect((plan.generatedFiles ?? []).map((g) => g.file)).toContain(initializer)
  })

  it('plan is pure data — it writes nothing to disk (dry-run parity)', async () => {
    await railsFixture()
    const before = await fs.readFile(path.join(dir, 'Gemfile'), 'utf8')
    await rubyInstaller.plan(dir, { project: 'blog' })
    const after = await fs.readFile(path.join(dir, 'Gemfile'), 'utf8')
    expect(after).toBe(before)
    // The initializer must not exist until apply runs.
    await expect(fs.stat(path.join(dir, 'config', 'initializers', 'neat_otel.rb'))).rejects.toThrow()
  })

  it('apply writes the gems + initializer, preserves the Gemfile, and is idempotent', async () => {
    await railsFixture()
    const plan = await rubyInstaller.plan(dir, { project: 'blog' })
    const result = await rubyInstaller.apply(plan)
    expect(result.outcome).toBe('instrumented')
    // NEAT stages the gems but instructs bundler rather than spawning it (ADR-186).
    expect(result.followUpInstall).toBe('bundle install')

    const gemfile = await fs.readFile(path.join(dir, 'Gemfile'), 'utf8')
    // merge, never clobber — the original gems survive.
    expect(gemfile).toContain("gem 'rails', '~> 7.1'")
    expect(gemfile).toContain("gem 'pg'")
    expect(gemfile).toContain("gem 'opentelemetry-sdk'")
    expect(gemfile).toContain("gem 'opentelemetry-instrumentation-all'")

    const initializer = await fs.readFile(path.join(dir, 'config', 'initializers', 'neat_otel.rb'), 'utf8')
    expect(initializer).toContain('NeatCallSiteSpanProcessor')
    expect(initializer).toContain('http://localhost:4318/projects/blog/v1/traces')

    // Second pass: gems present + initializer present → empty plan → no-op.
    const plan2 = await rubyInstaller.plan(dir, { project: 'blog' })
    expect(isEmptyPlan(plan2)).toBe(true)
    const result2 = await rubyInstaller.apply(plan2)
    expect(result2.outcome).toBe('already-instrumented')
    // Nothing staged on the re-run → no install instruction.
    expect(result2.followUpInstall).toBeUndefined()
    // The gem block was not duplicated.
    const gemfile2 = await fs.readFile(path.join(dir, 'Gemfile'), 'utf8')
    expect(gemfile2.match(/gem 'opentelemetry-sdk'/g)?.length).toBe(1)
  })

  it('preserves an existing initializer (createOnly, merge-not-clobber)', async () => {
    await railsFixture()
    const initializer = path.join(dir, 'config', 'initializers', 'neat_otel.rb')
    await fs.mkdir(path.dirname(initializer), { recursive: true })
    await fs.writeFile(initializer, '# hand-written, do not touch\n')
    const plan = await rubyInstaller.plan(dir, { project: 'blog' })
    // A present initializer is not queued for regeneration.
    expect((plan.generatedFiles ?? []).some((g) => g.file === initializer)).toBe(false)
    await rubyInstaller.apply(plan)
    expect(await fs.readFile(initializer, 'utf8')).toBe('# hand-written, do not touch\n')
  })

  it('a plain-Ruby service (no Rails) gets the gems but no initializer', async () => {
    await fs.writeFile(path.join(dir, 'Gemfile'), "source 'https://rubygems.org'\n\ngem 'sinatra'\n")
    const plan = await rubyInstaller.plan(dir, { project: 'svc' })
    expect(plan.dependencyEdits.length).toBeGreaterThan(0)
    expect(plan.generatedFiles ?? []).toEqual([])
  })
})

import { describe, expect, it, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileId, infraId, routeId, symbolId } from '@neat.is/types'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { ensureObservedFileNode } from '../src/ingest.js'
import { goInstaller, neatOtelGo } from '../src/installers/go.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'go-baseline')
const execFileAsync = promisify(execFile)

describe('Go compatibility vertical slice (ADR-154)', () => {
  beforeEach(() => resetGraph())

  it('discovers Go, resolves a local import, gin routes, and a SQL call site', async () => {
    const graph = getGraph()
    const result = await extractFromDirectory(graph, fixture)
    expect(result.extractionErrors).toBe(0)
    expect(graph.hasNode('service:orders-api')).toBe(true)
    expect(graph.hasNode(fileId('orders-api', 'main.go'))).toBe(true)
    expect(graph.hasEdge('IMPORTS:file:orders-api:main.go->file:orders-api:internal/store/store.go')).toBe(true)
    expect(graph.hasNode(routeId('orders-api', 'GET', '/api/orders/:id'))).toBe(true)
    expect(graph.hasNode(routeId('orders-api', 'POST', '/api/orders'))).toBe(true)
    expect(graph.hasEdge(`CALLS:file:orders-api:main.go->${infraId('sql-table', 'orders')}`)).toBe(true)
  })

  it('reconciles a Go runtime frame and lands it on the extracted symbol (ADR-192)', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, fixture)
    // A frame inside `getOrder` (lines 17–20). The deployed `/srv/...` path
    // reconciles onto the extracted `main.go`, and — now that Go has symbol grain
    // (ADR-192) — the frame lands one rung finer, on the `getOrder` SymbolNode the
    // extractor minted, rather than degrading to the file. No absolute-path twin.
    const observed = ensureObservedFileNode(graph, 'orders-api', 'service:orders-api', {
      relPath: '/srv/orders-api/main.go',
      line: 19,
      fn: 'getOrder',
    })
    expect(observed).toBe(symbolId('orders-api', 'main.go', 'getOrder'))
    expect(graph.hasNode(fileId('orders-api', '/srv/orders-api/main.go'))).toBe(false)
  })

  it('generates the OnStart runtime.Callers stamper and applies idempotently', async () => {
    const source = neatOtelGo()
    expect(source).toContain('OnStart')
    expect(source).toContain('runtime.Callers')
    expect(source).toContain('code.file.path')
    expect(source).toContain('code.line.number')
    expect(source).toContain('code.function.name')

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-go-'))
    try {
      await fs.writeFile(path.join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.23\n')
      await fs.writeFile(path.join(dir, 'main.go'), 'package main\nfunc main() {}\n')
      const plan = await goInstaller.plan(dir)
      const first = await goInstaller.apply(plan)
      expect(first.outcome).toBe('instrumented')
      expect(await fs.readFile(path.join(dir, 'neat_otel.go'), 'utf8')).toContain('neatCallSiteSpanProcessor')
      // A go.mod edit resolves through the Go toolchain, not the JS package
      // manager — NEAT surfaces the native command rather than spawning npm
      // in the Go service (ADR-186).
      expect(first.followUpInstall).toBe('go mod download')
      const second = await goInstaller.apply(await goInstaller.plan(dir))
      expect(second.outcome).toBe('already-instrumented')
      expect(second.followUpInstall).toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it.runIf(Boolean(process.env.NEAT_GO_BIN))('compiles and captures a real Go user frame', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-go-runtime-'))
    try {
      await fs.writeFile(path.join(dir, 'go.mod'), 'module example.com/runtimeproof\n\ngo 1.23\n')
      await fs.writeFile(path.join(dir, 'main.go'), 'package main\nfunc main() {}\n')
      await goInstaller.apply(await goInstaller.plan(dir))
      await fs.writeFile(path.join(dir, 'neat_otel_test.go'), `package main

import (
  "context"
  "fmt"
  "path/filepath"
  "testing"
  sdktrace "go.opentelemetry.io/otel/sdk/trace"
  "go.opentelemetry.io/otel/trace"
)

type captureExporter struct { span sdktrace.ReadOnlySpan }
func (e *captureExporter) ExportSpans(_ context.Context, spans []sdktrace.ReadOnlySpan) error { e.span = spans[0]; return nil }
func (*captureExporter) Shutdown(context.Context) error { return nil }

func userCall(tracer trace.Tracer) { _, span := tracer.Start(context.Background(), "proof", trace.WithSpanKind(trace.SpanKindClient)); span.End() }

func TestNeatRuntimeAttributes(t *testing.T) {
  exporter := &captureExporter{}
  root, err := filepath.EvalSymlinks("${dir}")
  if err != nil { t.Fatal(err) }
  provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(neatCallSiteSpanProcessor{root: root}), sdktrace.WithSyncer(exporter))
  userCall(provider.Tracer("proof"))
  attrs := map[string]any{}
  for _, kv := range exporter.span.Attributes() { attrs[string(kv.Key)] = kv.Value.AsInterface() }
  if attrs["code.file.path"] == nil || attrs["code.line.number"] == nil || attrs["code.function.name"] == nil { t.Fatalf("missing code attrs: %#v", attrs) }
  fmt.Printf("NEAT_RUNTIME_PROOF file=%v line=%v function=%v\\n", attrs["code.file.path"], attrs["code.line.number"], attrs["code.function.name"])
}
`)
      let stdout: string
      try {
        ;({ stdout } = await execFileAsync(process.env.NEAT_GO_BIN!, ['test', '-mod=mod', '-run', 'TestNeatRuntimeAttributes', '-v'], {
          cwd: dir,
          env: { ...process.env, GOTOOLCHAIN: 'local' },
          timeout: 120_000,
        }))
      } catch (err) {
        const failure = err as Error & { stdout?: string; stderr?: string }
        throw new Error(`${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`)
      }
      expect(stdout).toContain('NEAT_RUNTIME_PROOF')
      expect(stdout).toContain('neat_otel_test.go')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 130_000)
})

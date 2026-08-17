import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, SymbolNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  fileId,
  serviceId,
  symbolId,
} from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'symbols-polyglot')

// ADR-199 — symbol grain reaches Kotlin, the JVM sibling of Java (ADR-197) and the
// seventh language on the same walker pattern ADR-192 built for Python and Go. The
// fixture is a real Gradle-Kotlin service (a `build.gradle.kts`, so discovery keys on
// its `.kt` source, not the manifest) with two source files: `FraudService.kt` declares
// `package com.example.fraud;` carrying a class with a secondary constructor / an
// instance method / a companion-object method, an interface, two objects, an enum, and a
// data class; `Checkout.kt` declares a second package `com.example.checkout;` with a
// class, a nested type, and a top-level function. Every definition becomes a SymbolNode
// owned by its file through a `file ──CONTAINS──▶ symbol` edge, the exact shape ADR-158
// mints for JS/TS. Kotlin writes packages and members with `.`, so the qualname joins
// the file's package and the type nesting with a plain `.` and reduces under ingest's
// `terminalName` (last-`.` split) to the bare function name.
describe('Kotlin symbol extraction (ADR-199)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'fraud-kotlin'
  const FRAUD = 'FraudService.kt'
  const CHECKOUT = 'Checkout.kt'
  const sym = (relPath: string, qualname: string) => symbolId(SVC, relPath, qualname)

  it('mints a SymbolNode per method / constructor / class / interface / enum / object / data class / top-level function', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const expected: [string, string, SymbolNode['kind']][] = [
      [FRAUD, 'com.example.fraud.FraudService', 'class'],
      [FRAUD, 'com.example.fraud.FraudService.FraudService', 'constructor'], // secondary ctor, name = type
      [FRAUD, 'com.example.fraud.FraudService.check', 'method'],
      [FRAUD, 'com.example.fraud.FraudService.defaultRate', 'method'],
      [FRAUD, 'com.example.fraud.FraudService.threshold', 'method'], // companion-object method, reads under the type
      [FRAUD, 'com.example.fraud.FraudRepo', 'class'], // interface mints as a class-kind node
      [FRAUD, 'com.example.fraud.FraudRepo.lookup', 'method'], // abstract method, no body — still a symbol
      [FRAUD, 'com.example.fraud.NoopRepo', 'class'], // object mints as a class-kind node
      [FRAUD, 'com.example.fraud.NoopRepo.lookup', 'method'],
      [FRAUD, 'com.example.fraud.FraudRegistry', 'class'], // object
      [FRAUD, 'com.example.fraud.FraudRegistry.register', 'method'],
      [FRAUD, 'com.example.fraud.Decision', 'class'], // enum class mints as a class-kind node
      [FRAUD, 'com.example.fraud.Score', 'class'], // data class mints as a class-kind node
      [CHECKOUT, 'com.example.checkout.CheckoutService', 'class'], // second file's package threads
      [CHECKOUT, 'com.example.checkout.CheckoutService.total', 'method'],
      [CHECKOUT, 'com.example.checkout.CheckoutService.Receipt', 'class'], // nested type
      [CHECKOUT, 'com.example.checkout.CheckoutService.Receipt.render', 'method'],
      [CHECKOUT, 'com.example.checkout.topLevelHelper', 'function'], // top-level function, not a method
    ]

    for (const [relPath, qualname, kind] of expected) {
      const node = graph.getNodeAttributes(sym(relPath, qualname)) as SymbolNode
      expect(node?.type, `missing symbol ${qualname}`).toBe(NodeType.SymbolNode)
      expect(node.kind, `kind for ${qualname}`).toBe(kind)
      expect(node.qualname).toBe(qualname)
      expect(node.service).toBe(SVC)
      expect(node.relPath).toBe(relPath)
      expect(node.discoveredVia).toBe('static')
    }

    // Each file's own `package` prefixes its types, so CheckoutService lands under
    // com.example.checkout, never com.example.fraud.
    expect(graph.hasNode(sym(CHECKOUT, 'com.example.fraud.CheckoutService'))).toBe(false)
    // The package prefix is always applied — never the bare type name.
    expect(graph.hasNode(sym(FRAUD, 'FraudService'))).toBe(false)
    // A companion-object member reads under its enclosing type, not a synthetic
    // Companion segment.
    expect(graph.hasNode(sym(FRAUD, 'com.example.fraud.FraudService.Companion.threshold'))).toBe(
      false,
    )
    // A nested type reads its parent type into the qualname, never the bare name.
    expect(graph.hasNode(sym(CHECKOUT, 'com.example.checkout.Receipt'))).toBe(false)
  })

  it('records the real definition span and nests members inside their type', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const cls = graph.getNodeAttributes(sym(FRAUD, 'com.example.fraud.FraudService')) as SymbolNode
    expect(cls.span.startLine).toBe(5)

    const ctor = graph.getNodeAttributes(
      sym(FRAUD, 'com.example.fraud.FraudService.FraudService'),
    ) as SymbolNode
    const check = graph.getNodeAttributes(
      sym(FRAUD, 'com.example.fraud.FraudService.check'),
    ) as SymbolNode
    expect(check.span.startLine).toBe(8)
    expect(check.span.endLine).toBe(11)
    // Each member's span sits inside the class's.
    expect(ctor.span.startLine).toBeGreaterThan(cls.span.startLine)
    expect(check.span.endLine).toBeLessThan(cls.span.endLine)

    // The nested Receipt type sits wholly inside CheckoutService.
    const outer = graph.getNodeAttributes(
      sym(CHECKOUT, 'com.example.checkout.CheckoutService'),
    ) as SymbolNode
    const inner = graph.getNodeAttributes(
      sym(CHECKOUT, 'com.example.checkout.CheckoutService.Receipt'),
    ) as SymbolNode
    expect(inner.span.startLine).toBeGreaterThan(outer.span.startLine)
    expect(inner.span.endLine).toBeLessThan(outer.span.endLine)
  })

  it('owns each symbol through an EXTRACTED file ──CONTAINS──▶ symbol edge carrying file:line evidence', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const fnode = fileId(SVC, FRAUD)
    const sid = sym(FRAUD, 'com.example.fraud.FraudService.check')
    const containsId = extractedEdgeId(fnode, sid, EdgeType.CONTAINS)
    expect(graph.hasEdge(containsId)).toBe(true)
    const contains = graph.getEdgeAttributes(containsId) as GraphEdge
    expect(contains.source).toBe(fnode)
    expect(contains.provenance).toBe(Provenance.EXTRACTED)
    expect(contains.evidence?.file).toBe(FRAUD)
    expect(contains.evidence?.line).toBe(
      (graph.getNodeAttributes(sid) as SymbolNode).span.startLine,
    )
  })

  it('discovers the fixture as a kotlin service from its .kt source, not java', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // The Gradle manifest alone is ambiguous; the .kt source is what makes this a
    // kotlin ServiceNode. A .java service in the same shape stays java (see
    // discover-services.test.ts).
    const svc = graph.getNodeAttributes(serviceId(SVC))
    expect(svc?.type).toBe(NodeType.ServiceNode)
    expect((svc as { language?: string }).language).toBe('kotlin')
  })
})

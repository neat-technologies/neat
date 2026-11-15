import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EdgeType, NodeType, Provenance, extractedEdgeId, fileId, frontierEdgeId, serviceId } from '@neat.is/types'
import {
  assessCheckout,
  candidateDelta,
  promoteCandidate,
  readBaseline,
  stageCandidate,
  type AssessmentInput,
} from '../src/extract/assess.js'
import { getBlastRadius } from '../src/traverse.js'
import { makeGraph } from '../src/graph.js'
import { runAssessCommand } from '../src/assess-cli.js'
import { extractFromDirectory } from '../src/extract.js'
import { getGraph, listProjects, resetGraph } from '../src/graph.js'

const SOURCE = 'SOURCE_BYTES_MUST_NOT_REACH_A_VERDICT'
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  resetGraph()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-assess-'))
  roots.push(root)
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'checkout', version: '1.0.0' }),
  )
  await fs.writeFile(
    path.join(root, 'index.js'),
    `export function fix() { return "${SOURCE}"; }\nexport function victim() { return fix(); }\n`,
  )
  const graph = getGraph('test-baseline')
  const result = await extractFromDirectory(graph, root)
  expect(result.extractionErrors).toBe(0)
  const origin = graph.nodes().find((id) => id.endsWith('#fix'))!
  expect(origin).toBeTruthy()
  const input: AssessmentInput = {
    path: root,
    baseline: { graph: graph.export() },
    policies: { version: 1, policies: [] },
    origin,
    maxFiles: 10,
    maxServices: 10,
  }
  return { root, graph, input }
}

describe('sandbox candidate assessment', () => {
  it('assesses real extraction, leaves the registry/baseline untouched, and produces stable source-free output', async () => {
    const { root, graph, input } = await fixture()
    const before = JSON.stringify(graph.export())
    const projects = listProjects()
    await fs.writeFile(
      path.join(root, 'index.js'),
      `export function fix() { return "${SOURCE}_PATCHED"; }\nexport function victim() { return fix(); }\n`,
    )
    const first = await assessCheckout(input)
    const second = await assessCheckout(input)
    expect(first.passed).toBe(true)
    expect(first).toEqual(second)
    expect(first.blastRadius.files).toBe(1)
    expect(first.blastRadius.services).toBe(1)
    expect(JSON.stringify(first)).not.toContain(SOURCE)
    expect(JSON.stringify(graph.export())).toBe(before)
    expect(listProjects()).toEqual(projects)
    expect((await fs.readdir(root)).sort()).toEqual(['index.js', 'package.json'])
  })

  it('accepts the daemon wire graph format', async () => {
    const { graph, input } = await fixture()
    input.baseline = {
      nodes: graph.nodes().map((id) => graph.getNodeAttributes(id)),
      edges: graph.edges().map((id) => graph.getEdgeAttributes(id)),
    }
    expect((await assessCheckout(input)).passed).toBe(true)
  })

  it('retains runtime evidence and traverses the entire radius beyond ten hops', async () => {
    const { graph, input } = await fixture()
    let target = input.origin
    for (let i = 0; i < 12; i++) {
      const source = serviceId(`runtime-${i}`)
      graph.addNode(source, {
        id: source,
        type: NodeType.ServiceNode,
        name: `runtime-${i}`,
        language: 'unknown',
        discoveredVia: 'otel',
      })
      const id = `observed-${i}`
      graph.addDirectedEdgeWithKey(id, source, target, {
        id,
        type: EdgeType.CALLS,
        source,
        target,
        provenance: Provenance.OBSERVED,
        confidence: 1,
      })
      target = source
    }
    input.baseline = { graph: graph.export() }
    input.maxServices = 11
    const result = await assessCheckout(input)
    expect(result.reason).toBe('blast-radius-exceeded')
    expect(result.blastRadius.services).toBe(13)
    expect(result.graphDiff.removed.edges).not.toContain('observed-11')
  })

  it('refuses to resurrect a deleted static endpoint for an old runtime edge', async () => {
    const { graph, root, input } = await fixture()
    const source = graph.nodes().find((id) => id.endsWith('#victim'))!
    const id = 'observed-victim-fix'
    graph.addDirectedEdgeWithKey(id, source, input.origin, {
      id,
      type: EdgeType.CALLS,
      source,
      target: input.origin,
      provenance: Provenance.OBSERVED,
      confidence: 1,
    })
    input.baseline = { graph: graph.export() }
    await fs.writeFile(path.join(root, 'index.js'), 'export function fix() { return 1; }\n')
    expect((await assessCheckout(input)).reason).toBe('runtime-endpoint-removed')
  })

  it('checks authoritative blocking policies even when the patch replaces policy.json', async () => {
    const { input, root } = await fixture()
    input.policies = {
      version: 1,
      policies: [
        {
          id: 'required-owner',
          name: SOURCE,
          description: SOURCE,
          severity: 'critical',
          rule: { type: 'ownership', nodeType: NodeType.ServiceNode, field: 'owner' },
        },
      ],
    }
    await fs.writeFile(path.join(root, 'policy.json'), JSON.stringify({ version: 1, policies: [] }))
    const result = await assessCheckout(input)
    expect(result.reason).toBe('policy-block')
    expect(result.violations[0]?.policyId).toBe('required-owner')
    expect(result.violations[0]?.onViolation).toBe('block')
    expect(JSON.stringify(result)).not.toContain(SOURCE)
  })

  it('does not retain a removed static owner attribute and thereby bypass policy', async () => {
    const { input, graph } = await fixture()
    graph.setNodeAttribute(serviceId('checkout'), 'owner', 'old-owner')
    input.baseline = { graph: graph.export() }
    input.policies = {
      version: 1,
      policies: [
        {
          id: 'required-owner',
          name: 'Owner required',
          severity: 'critical',
          rule: { type: 'ownership', nodeType: NodeType.ServiceNode, field: 'owner' },
        },
      ],
    }
    expect((await assessCheckout(input)).reason).toBe('policy-block')
  })

  it('fails closed on missing origins, invalid graphs, policies, and bounds', async () => {
    const { input } = await fixture()
    expect((await assessCheckout({ ...input, origin: 'missing' })).reason).toBe('missing-origin')
    expect((await assessCheckout({ ...input, maxFiles: 0 })).reason).toBe('invalid-input')
    expect(
      (await assessCheckout({ ...input, policies: { version: 99, policies: [] } })).reason,
    ).toBe('invalid-input')
    expect((await assessCheckout({ ...input, baseline: {} })).reason).toBe('invalid-input')
    const baseline = input.baseline as { graph: { edges: { attributes: { target: string } }[] } }
    baseline.graph.edges[0]!.attributes.target = 'missing'
    expect((await assessCheckout(input)).reason).toBe('invalid-input')
  })

  it('does not pass when extraction cannot run', async () => {
    const { input } = await fixture()
    const result = await assessCheckout({ ...input, path: '/does/not/exist' })
    expect(result.passed).toBe(false)
    expect(JSON.stringify(result)).not.toContain('/does/not/exist')
  })

  it('carries foreign FRONTIER surfaces along untouched and never graduates them', async () => {
    const { graph, input } = await fixture()
    const source = serviceId('checkout')
    const id = frontierEdgeId(source, input.origin, EdgeType.CALLS)
    graph.addDirectedEdgeWithKey(id, source, input.origin, {
      id,
      type: EdgeType.CALLS,
      source,
      target: input.origin,
      provenance: Provenance.FRONTIER,
    })
    input.baseline = { graph: graph.export() }
    const verdict = await assessCheckout(input)
    expect(verdict.passed).toBe(true)
    expect(verdict.graphDiff.removed.edges).not.toContain(id)
    expect(verdict.graphDiff.added.edges).not.toContain(id)
  })

  it('stages added edges as FRONTIER under one candidate id, invisible to traversal until the promoted copy', async () => {
    const { root, graph, input } = await fixture()
    await fs.writeFile(
      path.join(root, 'index.js'),
      `export function fix() { return "${SOURCE}"; }\nexport function victim() { return fix(); }\nexport function caller() { return victim(); }\n`,
    )
    const settled = readBaseline(input.baseline)
    const candidate = makeGraph()
    await extractFromDirectory(candidate, root)
    const ledger = candidateDelta(settled, candidate)
    expect(ledger.candidateId).toMatch(/^candidate:[0-9a-f]{64}$/)
    expect(candidateDelta(settled, candidate).candidateId).toBe(ledger.candidateId)
    expect(ledger.added.nodes.some((id) => id.endsWith('#caller'))).toBe(true)
    expect(ledger.added.edges.length).toBeGreaterThan(0)

    const staged = stageCandidate(settled, candidate, ledger)
    const victim = graph.nodes().find((id) => id.endsWith('#victim'))!
    for (const id of ledger.added.edges) {
      const edge = candidate.getEdgeAttributes(id)
      const frontier = frontierEdgeId(edge.source, edge.target, edge.type)
      expect(staged.getEdgeAttributes(frontier).provenance).toBe(Provenance.FRONTIER)
      expect(staged.hasEdge(id)).toBe(false)
    }
    const stagedReach = getBlastRadius(staged, victim, staged.order).affectedNodes.map((n) => n.nodeId)
    expect(stagedReach.some((id) => id.endsWith('#caller'))).toBe(false)

    const promoted = promoteCandidate(staged, candidate, ledger)
    for (const id of ledger.added.edges) {
      expect(promoted.getEdgeAttributes(id).provenance).toBe(Provenance.EXTRACTED)
      const edge = candidate.getEdgeAttributes(id)
      expect(promoted.hasEdge(frontierEdgeId(edge.source, edge.target, edge.type))).toBe(false)
    }
    const promotedReach = getBlastRadius(promoted, victim, promoted.order).affectedNodes.map((n) => n.nodeId)
    expect(promotedReach.some((id) => id.endsWith('#caller'))).toBe(true)
    // The settled graph the staging started from is never written.
    expect(settled.hasEdge(frontierEdgeId(candidate.getEdgeAttributes(ledger.added.edges[0]!).source, candidate.getEdgeAttributes(ledger.added.edges[0]!).target, candidate.getEdgeAttributes(ledger.added.edges[0]!).type))).toBe(false)
  })

  it('leaves another repository\'s services in the project exactly as the baseline has them', async () => {
    const { graph, input } = await fixture()
    const other = serviceId('other-repo')
    const otherFile = fileId('other-repo', 'src/main.js')
    graph.addNode(other, { id: other, type: NodeType.ServiceNode, name: 'other-repo', language: 'javascript' })
    graph.addNode(otherFile, { id: otherFile, type: NodeType.FileNode, service: 'other-repo', path: 'src/main.js', language: 'javascript' } as never)
    const contains = extractedEdgeId(other, otherFile, EdgeType.CONTAINS)
    graph.addDirectedEdgeWithKey(contains, other, otherFile, { id: contains, type: EdgeType.CONTAINS, source: other, target: otherFile, provenance: Provenance.EXTRACTED })
    input.baseline = { graph: graph.export() }
    const verdict = await assessCheckout(input)
    expect(verdict.passed).toBe(true)
    expect(verdict.graphDiff.removed.nodes).not.toContain(otherFile)
    expect(verdict.graphDiff.removed.nodes).not.toContain(other)
    expect(verdict.graphDiff.removed.edges).not.toContain(contains)
  })

  it('counts the callers of what the candidate removes, read on the settled graph', async () => {
    const { graph, root, input } = await fixture()
    const victim = graph.nodes().find((id) => id.endsWith('#victim'))!
    const caller = serviceId('downstream-caller')
    graph.addNode(caller, { id: caller, type: NodeType.ServiceNode, name: 'downstream-caller', language: 'javascript' })
    const id = extractedEdgeId(caller, victim, EdgeType.CALLS)
    graph.addDirectedEdgeWithKey(id, caller, victim, { id, type: EdgeType.CALLS, source: caller, target: victim, provenance: Provenance.EXTRACTED })
    input.baseline = { graph: graph.export() }
    await fs.writeFile(path.join(root, 'index.js'), `export function fix() { return "${SOURCE}"; }\n`)
    const verdict = await assessCheckout({ ...input, maxServices: 1 })
    expect(verdict.graphDiff.removed.nodes).toContain(victim)
    expect(verdict.blastRadius.nodes).toContain(caller)
    expect(verdict.reason).toBe('blast-radius-exceeded')
  })
})

describe('neat assess CLI', () => {
  it('emits a single source-free JSON record with no snapshot or diagnostic writes', async () => {
    const { input, root } = await fixture()
    const baseline = path.join(root, 'baseline.json')
    const policies = path.join(root, 'policies.json')
    await fs.writeFile(baseline, JSON.stringify(input.baseline))
    await fs.writeFile(policies, JSON.stringify(input.policies))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = await runAssessCommand([
      '--path',
      root,
      '--baseline',
      baseline,
      '--policies',
      policies,
      '--origin',
      input.origin,
      '--max-files',
      '10',
      '--max-services',
      '10',
    ])
    expect(code).toBe(0)
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.parse(log.mock.calls[0]![0] as string).passed).toBe(true)
    expect(log.mock.calls[0]![0]).not.toContain(SOURCE)
    expect((await fs.readdir(root)).sort()).toEqual([
      'baseline.json',
      'index.js',
      'package.json',
      'policies.json',
    ])
  })

  it('rejects duplicate, missing, unknown flags and malformed bounds before extraction', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    for (const argv of [
      [],
      ['--path', 'x', '--path', 'y'],
      ['--wat', SOURCE],
      ['--path'],
      [
        '--path',
        'x',
        '--baseline',
        'x',
        '--policies',
        'x',
        '--origin',
        'x',
        '--max-files',
        '1.5',
        '--max-services',
        '1',
      ],
    ]) {
      expect(await runAssessCommand(argv)).toBe(2)
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain(SOURCE)
  })

  it('returns a structured refusal without raw filesystem or JSON error text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(
      await runAssessCommand([
        '--path',
        '/not/a/checkout',
        '--baseline',
        SOURCE,
        '--policies',
        SOURCE,
        '--origin',
        'x',
        '--max-files',
        '1',
        '--max-services',
        '1',
      ]),
    ).toBe(1)
    expect(JSON.parse(log.mock.calls[0]![0] as string).passed).toBe(false)
    expect(JSON.stringify(log.mock.calls)).not.toContain(SOURCE)
  })

  it('suppresses extractor diagnostics when malformed customer files prevent assessment', async () => {
    const { input, root } = await fixture()
    const baseline = path.join(root, 'baseline.json')
    const policies = path.join(root, 'policies.json')
    await fs.writeFile(baseline, JSON.stringify(input.baseline))
    await fs.writeFile(policies, JSON.stringify(input.policies))
    await fs.writeFile(path.join(root, 'package.json'), `{malformed ${SOURCE}`)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(
      await runAssessCommand([
        '--path',
        root,
        '--baseline',
        baseline,
        '--policies',
        policies,
        '--origin',
        input.origin,
        '--max-files',
        '10',
        '--max-services',
        '10',
      ]),
    ).toBe(1)
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(
      SOURCE,
    )
  })
})

describe('neat assess stays hidden', () => {
  it('is in neither usage() nor QUERY_VERBS', async () => {
    const cli = await fs.readFile(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf8')
    const usageBody = cli.match(/function usage\(\)[\s\S]*?\n\}/)?.[0] ?? ''
    expect(usageBody.length).toBeGreaterThan(0)
    expect(usageBody).not.toMatch(/\bassess\b/)
    const { QUERY_VERBS } = await import('../src/cli.js')
    expect([...QUERY_VERBS]).not.toContain('assess')
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import type { GraphEdge, ServerActionNode } from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  extractedEdgeId,
  fileId,
  serverActionId,
} from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures', 'server-actions')

// ADR-168 — Next.js Server Actions become first-class nodes and the client→action
// call path lands. The fixture is a Next.js service (gated on the `next` dep):
// a module-level "use server" file with two exported actions, an in-body-directive
// action alongside a non-action exported async function, and a client component
// that references the imported actions four ways (call, `action={}` JSX,
// `useActionState`, `.bind`).
describe('Next.js Server Action extraction (ADR-168)', () => {
  beforeEach(() => resetGraph())

  const SVC = 'action-svc'
  const ACTIONS_REL = 'src/app/actions.ts'
  const ADMIN_REL = 'src/app/admin/actions.ts'
  const CLIENT_REL = 'src/app/user-form.tsx'
  const action = (rel: string, name: string): string => serverActionId(SVC, rel, name)

  it('mints a ServerActionNode per exported action under a module-level "use server" directive', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const createUser = graph.getNodeAttributes(action(ACTIONS_REL, 'createUser')) as ServerActionNode
    expect(createUser.type).toBe(NodeType.ServerActionNode)
    expect(createUser.name).toBe('createUser')
    expect(createUser.exportName).toBe('createUser')
    expect(createUser.service).toBe(SVC)
    expect(createUser.module).toBe(ACTIONS_REL)
    expect(createUser.path).toBe(ACTIONS_REL)
    expect(createUser.line).toBeGreaterThan(0)
    expect(createUser.discoveredVia).toBe('static')

    // The second exported async function in the same directive-carrying file.
    const deleteUser = graph.getNodeAttributes(action(ACTIONS_REL, 'deleteUser')) as ServerActionNode
    expect(deleteUser.type).toBe(NodeType.ServerActionNode)
    expect(deleteUser.exportName).toBe('deleteUser')
  })

  it('mints an action for an in-body "use server" directive, and nothing for a plain exported async function', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    // updateUser carries its own in-body "use server" — an action.
    const updateUser = graph.getNodeAttributes(action(ADMIN_REL, 'updateUser')) as ServerActionNode
    expect(updateUser.type).toBe(NodeType.ServerActionNode)
    expect(updateUser.module).toBe(ADMIN_REL)

    // logAudit is exported and async but carries no directive — not an action.
    expect(graph.hasNode(action(ADMIN_REL, 'logAudit'))).toBe(false)
  })

  it('owns each action through a file ──CONTAINS──▶ action edge', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const cases: Array<[string, string]> = [
      [ACTIONS_REL, 'createUser'],
      [ACTIONS_REL, 'deleteUser'],
      [ADMIN_REL, 'updateUser'],
    ]
    for (const [rel, name] of cases) {
      const containsId = extractedEdgeId(fileId(SVC, rel), action(rel, name), EdgeType.CONTAINS)
      expect(graph.hasEdge(containsId)).toBe(true)
      const edge = graph.getEdgeAttributes(containsId) as GraphEdge
      expect(edge.source).toBe(fileId(SVC, rel))
      expect(edge.target).toBe(action(rel, name))
      expect(edge.type).toBe(EdgeType.CONTAINS)
      expect(edge.provenance).toBe(Provenance.EXTRACTED)
      expect(edge.evidence?.file).toBe(rel)
    }
  })

  it('stitches file ──CALLS──▶ action on every client reference (call, JSX, useActionState, .bind), resolved through @/* paths', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, FIXTURES)

    const clientFileId = fileId(SVC, CLIENT_REL)
    const referenced: Array<[string, string]> = [
      [ACTIONS_REL, 'createUser'], // call (a) + action={} JSX (b)
      [ACTIONS_REL, 'deleteUser'], // useActionState (c)
      [ADMIN_REL, 'updateUser'], //   .bind (d)
    ]
    for (const [rel, name] of referenced) {
      const callsId = extractedEdgeId(clientFileId, action(rel, name), EdgeType.CALLS)
      expect(graph.hasEdge(callsId)).toBe(true)
      const edge = graph.getEdgeAttributes(callsId) as GraphEdge
      expect(edge.source).toBe(clientFileId)
      expect(edge.target).toBe(action(rel, name))
      expect(edge.provenance).toBe(Provenance.EXTRACTED)
      expect(edge.evidence?.file).toBe(CLIENT_REL)
      expect(edge.evidence?.line).toBeGreaterThan(0)
    }

    // Exactly those three CALLS-to-action edges — the `useActionState` import from
    // `react` resolves to no ServerActionNode, so it stitches nothing.
    const callsToActions: string[] = []
    graph.forEachEdge((_id, attrs) => {
      const e = attrs as GraphEdge
      if (e.type !== EdgeType.CALLS) return
      if (!e.target.startsWith('action:')) return
      callsToActions.push(`${e.source} -> ${e.target}`)
    })
    expect(new Set(callsToActions)).toEqual(
      new Set([
        `${clientFileId} -> ${action(ACTIONS_REL, 'createUser')}`,
        `${clientFileId} -> ${action(ACTIONS_REL, 'deleteUser')}`,
        `${clientFileId} -> ${action(ADMIN_REL, 'updateUser')}`,
      ]),
    )
  })
})

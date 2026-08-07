import { describe, it, expect } from 'vitest'
import { MultiDirectedGraph } from 'graphology'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NodeType, type GraphEdge, type GraphNode, type InfraNode } from '@neat.is/types'
import type { NeatGraph } from '../src/graph.js'
import {
  parseFirestoreRules,
  addFirestoreRules,
  FIRESTORE_COLLECTION_KIND,
} from '../src/extract/firestore-rules.js'
import type { DiscoveredService } from '../src/extract/shared.js'

// ADR-169 — the declared side of the `field-guard` policy. `firestore.rules` is a
// checked-in policy artifact read as text (the same read-polyglot-as-data
// discipline `calls/prisma.ts` follows for `schema.prisma`). The load-bearing
// behaviour is honesty about what the scanner can reduce: an explicit
// `keys().hasAll([...])`-style field list is a determinate guard set; anything
// condition-based or function-indirected leaves the collection indeterminate and
// contributes no `guardedFields`, so the policy stays silent instead of firing a
// false positive.

describe('parseFirestoreRules — explicit field guards vs indeterminate', () => {
  it('reads an explicit hasAll([...]) write guard on /users/{id}', () => {
    const out = parseFirestoreRules(`
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /users/{userId} {
            allow read: if true;
            allow write: if request.resource.data.keys().hasAll(['name', 'email']);
          }
        }
      }
    `)
    expect([...out.keys()]).toEqual(['users'])
    expect(out.get('users')).toEqual(['email', 'name'])
  })

  it('composes a nested subcollection to a full collection path', () => {
    const out = parseFirestoreRules(`
      service cloud.firestore {
        match /databases/{database}/documents {
          match /users/{userId} {
            match /posts/{postId} {
              allow update: if request.resource.data.keys().hasOnly(['title', 'body']);
            }
          }
        }
      }
    `)
    expect(out.get('users/posts')).toEqual(['body', 'title'])
  })

  it('lowercases field names to match how columns are stored', () => {
    const out = parseFirestoreRules(`
      service cloud.firestore {
        match /databases/{database}/documents {
          match /orders/{id} {
            allow create: if request.resource.data.keys().hasAll(['Total', 'CustomerId']);
          }
        }
      }
    `)
    expect(out.get('orders')).toEqual(['customerid', 'total'])
  })

  it('leaves a condition-based write guard indeterminate — omitted, not empty', () => {
    const out = parseFirestoreRules(`
      service cloud.firestore {
        match /databases/{database}/documents {
          match /sessions/{id} {
            allow write: if request.auth != null && request.auth.uid == resource.data.owner;
          }
        }
      }
    `)
    expect(out.has('sessions')).toBe(false)
  })

  it('leaves a function-indirected write guard indeterminate', () => {
    const out = parseFirestoreRules(`
      service cloud.firestore {
        match /databases/{database}/documents {
          function isValid() { return true; }
          match /invoices/{id} {
            allow update: if isValid();
          }
        }
      }
    `)
    expect(out.has('invoices')).toBe(false)
  })

  it('poisons a collection to indeterminate when any write rule is non-reducible', () => {
    // One reducible create guard, one condition-based update guard on the same
    // collection: the unguarded update path means we cannot claim the set is
    // complete, so the collection stays silent rather than risk a false positive.
    const out = parseFirestoreRules(`
      service cloud.firestore {
        match /databases/{database}/documents {
          match /accounts/{id} {
            allow create: if request.resource.data.keys().hasAll(['name']);
            allow update: if request.auth.token.admin == true;
          }
        }
      }
    `)
    expect(out.has('accounts')).toBe(false)
  })

  it('ignores read-only rules — a read guard names no written field', () => {
    const out = parseFirestoreRules(`
      service cloud.firestore {
        match /databases/{database}/documents {
          match /public/{id} {
            allow read: if request.resource.data.keys().hasAll(['a', 'b']);
          }
        }
      }
    `)
    expect(out.has('public')).toBe(false)
  })
})

// The fold half: match the parsed collection keys against the
// `firestore-collection` InfraNodes the F1 recognizer (ADR-167) mints, and set
// `guardedFields` on the ones that line up. F1 isn't a dependency at runtime — if
// no such nodes exist, the fold is inert.
function makeGraph(): NeatGraph {
  return new MultiDirectedGraph<GraphNode, GraphEdge>({ allowSelfLoops: false })
}

function firestoreNode(name: string): InfraNode {
  return {
    id: `infra:${FIRESTORE_COLLECTION_KIND}:${name}`,
    type: NodeType.InfraNode,
    name,
    provider: 'self',
    kind: FIRESTORE_COLLECTION_KIND,
  }
}

function serviceAt(dir: string): DiscoveredService {
  return {
    dir,
    pkg: { name: 'app' },
    node: { id: 'service:app', type: NodeType.ServiceNode, name: 'app', language: 'javascript' },
  } as unknown as DiscoveredService
}

describe('addFirestoreRules — folds guardedFields onto firestore-collection nodes', () => {
  it('sets guardedFields on the matching collection node', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neat-fsrules-'))
    try {
      writeFileSync(
        path.join(dir, 'firestore.rules'),
        `service cloud.firestore {
           match /databases/{database}/documents {
             match /users/{userId} {
               allow write: if request.resource.data.keys().hasAll(['name', 'email']);
             }
           }
         }`,
      )
      const g = makeGraph()
      const users = firestoreNode('users')
      g.addNode(users.id, users)
      // A collection the rules don't guard — must stay untouched (indeterminate).
      const orders = firestoreNode('orders')
      g.addNode(orders.id, orders)

      await addFirestoreRules(g, [serviceAt(dir)])

      expect((g.getNodeAttributes(users.id) as InfraNode).guardedFields).toEqual(['email', 'name'])
      expect((g.getNodeAttributes(orders.id) as InfraNode).guardedFields).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matches a nested-subcollection node by its wildcard-stripped path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neat-fsrules-'))
    try {
      writeFileSync(
        path.join(dir, 'firestore.rules'),
        `service cloud.firestore {
           match /databases/{database}/documents {
             match /users/{userId}/posts/{postId} {
               allow update: if request.resource.data.keys().hasOnly(['title']);
             }
           }
         }`,
      )
      const g = makeGraph()
      // F1 may name a subcollection node with wildcard segments verbatim — the
      // join strips them, so both forms line up.
      const node = firestoreNode('users/{userId}/posts')
      g.addNode(node.id, node)

      await addFirestoreRules(g, [serviceAt(dir)])

      expect((g.getNodeAttributes(node.id) as InfraNode).guardedFields).toEqual(['title'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op when the service has no firestore.rules', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neat-fsrules-'))
    try {
      mkdirSync(path.join(dir, 'src'), { recursive: true })
      const g = makeGraph()
      const users = firestoreNode('users')
      g.addNode(users.id, users)

      const result = await addFirestoreRules(g, [serviceAt(dir)])

      expect(result).toEqual({ nodesAdded: 0, edgesAdded: 0 })
      expect((g.getNodeAttributes(users.id) as InfraNode).guardedFields).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

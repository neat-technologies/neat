import { describe, it, expect } from 'vitest'
import { firestoreEndpointsFromFile } from '../src/extract/calls/firestore.js'
import type { SourceFile } from '../src/extract/calls/shared.js'

// extract/calls/firestore.ts (ADR-167). The collection-grained static twin of a
// Firebase/Next.js app's datastore surface: collections become nodes, written and
// queried fields become columns, and each written field records which SDK wrote it
// (client vs admin) — the seam the field-guard policy (ADR-169) joins on. Firestore
// is EXTRACTED-only (ADR-128), so there is no OBSERVED side to fuse; the recognizer
// scopes to a firebase import and a recognized client, and leaves computed paths
// unclaimed.

const SVC = '/svc'
function file(content: string, p = '/svc/src/orders.ts'): SourceFile {
  return { path: p, content }
}
const eps = (content: string, p?: string) => firestoreEndpointsFromFile(file(content, p), SVC)
const paths = (out: ReturnType<typeof eps>) => out.map((e) => e.name).sort()

describe('firestoreEndpointsFromFile — collection shapes', () => {
  it('recognizes the modular collection() and doc() shapes scoped to a client var', () => {
    const out = eps(`
      import { getFirestore, collection, doc, getDocs } from 'firebase/firestore'
      const db = getFirestore(app)
      export async function list() {
        const snap = await getDocs(collection(db, 'orders'))
        const one = await getDoc(doc(db, 'customers', id))
        return snap
      }
    `)
    expect(paths(out)).toEqual(['customers', 'orders'])
    const orders = out.find((e) => e.name === 'orders')!
    expect(orders.infraId).toBe('infra:firestore-collection:orders')
    expect(orders.kind).toBe('firestore-collection')
    expect(orders.edgeType).toBe('CALLS')
    expect(orders.confidenceKind).toBe('verified-call-site')
    expect(orders.evidence.file).toBe('src/orders.ts')
  })

  it('recognizes the namespaced db.collection().doc() shape', () => {
    const out = eps(`
      import admin from 'firebase-admin'
      const db = admin.firestore()
      export function get(id) {
        return db.collection('orders').doc(id).get()
      }
    `)
    expect(paths(out)).toEqual(['orders'])
    expect(out[0]!.infraId).toBe('infra:firestore-collection:orders')
  })

  it('composes a nested subcollection to a path-template node (modular)', () => {
    const out = eps(`
      import { getFirestore, collection } from 'firebase/firestore'
      const db = getFirestore()
      export function posts(id) {
        return collection(doc(db, 'users', id), 'posts')
      }
    `)
    // The inner doc(db,'users',id) yields the 'users' collection; the outer
    // collection(...,'posts') composes the full 'users/{}/posts' template.
    expect(paths(out)).toEqual(['users', 'users/{}/posts'])
    const nested = out.find((e) => e.name === 'users/{}/posts')!
    expect(nested.infraId).toBe('infra:firestore-collection:users/{}/posts')
  })

  it('composes a nested subcollection to a path-template node (namespaced)', () => {
    const out = eps(`
      import admin from 'firebase-admin'
      const db = admin.firestore()
      export function posts(uid) {
        return db.collection('users').doc(uid).collection('posts').get()
      }
    `)
    expect(paths(out)).toEqual(['users', 'users/{}/posts'])
  })
})

describe('firestoreEndpointsFromFile — fields as columns', () => {
  it('reads .set / query where() fields onto the collection as columns', () => {
    const out = eps(`
      import { getFirestore, collection, doc, setDoc, query, where, orderBy, getDocs } from 'firebase/firestore'
      const db = getFirestore(app)
      export async function upsert(id) {
        await setDoc(doc(db, 'orders', id), { total: 10, status: 'new' })
        const q = query(collection(db, 'orders'), where('status', '==', 'new'), orderBy('createdAt'))
        return getDocs(q)
      }
    `)
    const orders = out.find((e) => e.name === 'orders')!
    // Written keys (total, status) + queried fields (status, createdAt), deduped.
    expect([...orders.columns!].sort()).toEqual(['createdAt', 'status', 'total'])
  })

  it('reads namespaced .set({...}) object keys and .where() field', () => {
    const out = eps(`
      import admin from 'firebase-admin'
      const db = admin.firestore()
      export async function write(id) {
        await db.collection('orders').doc(id).set({ total: 1, note: 'x' })
        return db.collection('orders').where('status', '==', 'open').get()
      }
    `)
    const orders = out.find((e) => e.name === 'orders')!
    expect([...orders.columns!].sort()).toEqual(['note', 'status', 'total'])
  })
})

describe('firestoreEndpointsFromFile — sdkWrites tag (client vs admin)', () => {
  it('tags a firebase/firestore write as client', () => {
    const out = eps(`
      import { getFirestore, doc, setDoc } from 'firebase/firestore'
      const db = getFirestore(app)
      export function save(id) {
        return setDoc(doc(db, 'orders', id), { total: 5, role: 'admin' })
      }
    `)
    const orders = out.find((e) => e.name === 'orders')!
    expect(orders.sdkWrites).toEqual({ total: ['client'], role: ['client'] })
  })

  it('tags a firebase-admin/firestore write as admin', () => {
    const out = eps(`
      import { getFirestore } from 'firebase-admin/firestore'
      const db = getFirestore()
      export function save(id) {
        return db.collection('orders').doc(id).set({ total: 5, role: 'admin' })
      }
    `)
    const orders = out.find((e) => e.name === 'orders')!
    expect(orders.sdkWrites).toEqual({ total: ['admin'], role: ['admin'] })
  })

  it('leaves read-only fields untagged (no sdkWrites for a where-only field)', () => {
    const out = eps(`
      import { getFirestore, collection, query, where, getDocs } from 'firebase/firestore'
      const db = getFirestore(app)
      export function find() {
        return getDocs(query(collection(db, 'orders'), where('status', '==', 'x')))
      }
    `)
    const orders = out.find((e) => e.name === 'orders')!
    expect(orders.columns).toEqual(['status'])
    expect(orders.sdkWrites).toBeUndefined()
  })
})

describe('firestoreEndpointsFromFile — never guess', () => {
  it('returns nothing for a file that does not import firebase', () => {
    expect(
      eps(`
        const db = getFirestore()
        collection(db, 'orders')
      `),
    ).toEqual([])
  })

  it('leaves a computed / interpolated collection path unclaimed', () => {
    const out = eps(`
      import { getFirestore, collection } from 'firebase/firestore'
      const db = getFirestore(app)
      export function dyn(name) {
        return collection(db, \`orders_\${name}\`)
      }
      export function dyn2(name) {
        return collection(db, name)
      }
    `)
    expect(out).toEqual([])
  })

  it('does not claim a bare collection() with no firestore client in scope', () => {
    // A firebase import is present but the collection() call is not scoped to a
    // recognized client var — left unclaimed rather than minting a phantom node.
    const out = eps(`
      import { doc } from 'firebase/firestore'
      import mongoose from 'mongoose'
      const conn = mongoose.connection
      export function q() {
        return conn.collection('orders')
      }
    `)
    expect(out).toEqual([])
  })
})

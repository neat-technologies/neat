import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { firestoreCrossFileEndpoints } from '../src/extract/calls/firestore.js'
import type { SourceFile } from '../src/extract/calls/shared.js'

// #1223 — cross-file Firestore client resolution. Nearly every Firebase app builds the
// client once and exports it, so the per-file pass claimed none of the querying files.
// The resolver hits the filesystem, so these write a real service tree, the same shape
// extract-mongoose-crossfile.test.ts uses for ADR-149.

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function service(files: Record<string, string>): Promise<{ dir: string; sources: SourceFile[] }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-fs-xfile-'))
  const dir = await fs.realpath(base)
  dirs.push(dir)
  const sources: SourceFile[] = []
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
    sources.push({ path: abs, content })
  }
  return { dir, sources }
}

/** "<relative file> → <collection>" pairs, sorted, for compact assertions. */
function attributed(eps: Awaited<ReturnType<typeof firestoreCrossFileEndpoints>>): string[] {
  return eps.map((e) => `${e.evidence.file} → ${e.name}`).sort()
}

const CLIENT_MODULE =
  `import { initializeApp } from 'firebase/app'\n` +
  `import { getFirestore } from 'firebase/firestore'\n` +
  `const app = initializeApp({})\n` +
  `export const db = getFirestore(app)\n`

describe('firestoreCrossFileEndpoints (#1223)', () => {
  it('claims collections in every file importing the shared client', async () => {
    const { dir, sources } = await service({
      'lib/firebase.ts': CLIENT_MODULE,
      'app/orders/page.tsx':
        `import { collection, getDocs } from 'firebase/firestore'\n` +
        `import { db } from '../../lib/firebase'\n` +
        `export async function load() { return getDocs(collection(db, 'orders')) }\n`,
      'app/users/page.tsx':
        `import { collection, getDocs } from 'firebase/firestore'\n` +
        `import { db } from '../../lib/firebase'\n` +
        `export async function load() { return getDocs(collection(db, 'users')) }\n`,
    })
    expect(attributed(await firestoreCrossFileEndpoints(sources, dir))).toEqual([
      'app/orders/page.tsx → orders',
      'app/users/page.tsx → users',
    ])
  })

  it('claims an admin-SDK call in a file that names no firebase package itself', async () => {
    // The importing file has no firebase import at all — the resolved client is the
    // evidence, and the SDK tag comes from the module that built it.
    const { dir, sources } = await service({
      'lib/admin.ts':
        `import admin from 'firebase-admin'\n` + `export const db = admin.firestore()\n`,
      'jobs/nightly.ts':
        `import { db } from '../lib/admin'\n` +
        `export async function run() { await db.collection('invoices').doc('x').set({ total: 1 }) }\n`,
    })
    const eps = await firestoreCrossFileEndpoints(sources, dir)
    expect(attributed(eps)).toEqual(['jobs/nightly.ts → invoices'])
    // The write is tagged admin, which is what the field-guard reads to decide whether a
    // write bypasses security rules. At endpoint stage `columns` is still a name list and
    // `sdkWrites` a parallel map; `foldColumns`/`foldSdkWrites` merge them onto the node.
    expect(eps[0]!.columns?.map((c) => c.toLowerCase())).toEqual(['total'])
    expect(eps[0]!.sdkWrites).toEqual({ total: ['admin'] })
  })

  it('records a client-SDK write so the field guard has something to assert against', async () => {
    // Before this pass, a client-written field on a shared-client layout produced no
    // column at all, so `evaluateFieldGuard` passed vacuously on an app it never read.
    const { dir, sources } = await service({
      'lib/firebase.ts': CLIENT_MODULE,
      'app/actions.ts':
        `import { collection, addDoc } from 'firebase/firestore'\n` +
        `import { db } from '../lib/firebase'\n` +
        `export async function create() { await addDoc(collection(db, 'orders'), { total: 1, ownerId: 'u' }) }\n`,
    })
    const eps = await firestoreCrossFileEndpoints(sources, dir)
    expect(eps).toHaveLength(1)
    expect(eps[0]!.columns?.map((c) => c.toLowerCase()).sort()).toEqual(['ownerid', 'total'])
    // Both fields are client-written, which is exactly what the guard asserts against the
    // rules' guarded set. On the old per-file-only path there were no columns to compare.
    expect(Object.values(eps[0]!.sdkWrites ?? {}).every((v) => v.includes('client'))).toBe(true)
    expect(Object.keys(eps[0]!.sdkWrites ?? {}).length).toBe(2)
  })

  it('follows an aliased import of the client', async () => {
    const { dir, sources } = await service({
      'lib/firebase.ts': CLIENT_MODULE,
      'app/page.tsx':
        `import { collection } from 'firebase/firestore'\n` +
        `import { db as store } from '../lib/firebase'\n` +
        `export const q = collection(store, 'orders')\n`,
    })
    expect(attributed(await firestoreCrossFileEndpoints(sources, dir))).toEqual([
      'app/page.tsx → orders',
    ])
  })

  it('composes a subcollection through an imported client', async () => {
    const { dir, sources } = await service({
      'lib/firebase.ts': CLIENT_MODULE,
      'app/posts.ts':
        `import { collection, doc } from 'firebase/firestore'\n` +
        `import { db } from '../lib/firebase'\n` +
        `export const q = collection(doc(db, 'users', id), 'posts')\n`,
    })
    expect(attributed(await firestoreCrossFileEndpoints(sources, dir))).toContain(
      'app/posts.ts → users/{}/posts',
    )
  })

  it('does not double-count a file that builds its own client', async () => {
    // That file is already fully covered by the per-file pass; claiming it here too would
    // hand the orchestrator the same endpoint twice.
    const { dir, sources } = await service({
      'lib/firebase.ts': CLIENT_MODULE,
      'scripts/seed.ts':
        `import { getFirestore, collection } from 'firebase/firestore'\n` +
        `import { db } from '../lib/firebase'\n` +
        `const own = getFirestore()\n` +
        `export const q = collection(own, 'seeds')\n`,
    })
    expect(await firestoreCrossFileEndpoints(sources, dir)).toEqual([])
  })

  it('claims nothing for a non-client named export of the same module', async () => {
    const { dir, sources } = await service({
      'lib/firebase.ts': CLIENT_MODULE + `export const appName = 'rheos'\n`,
      'app/page.tsx':
        `import { collection } from 'firebase/firestore'\n` +
        `import { appName } from '../lib/firebase'\n` +
        `export const q = collection(appName, 'orders')\n`,
    })
    expect(await firestoreCrossFileEndpoints(sources, dir)).toEqual([])
  })

  it('claims nothing when the specifier does not resolve inside the service', async () => {
    const { dir, sources } = await service({
      'app/page.tsx':
        `import { collection } from 'firebase/firestore'\n` +
        `import { db } from 'some-published-sdk'\n` +
        `export const q = collection(db, 'orders')\n`,
    })
    expect(await firestoreCrossFileEndpoints(sources, dir)).toEqual([])
  })

  it('claims nothing when no module exports a client', async () => {
    const { dir, sources } = await service({
      'app/page.tsx':
        `import { collection } from 'firebase/firestore'\n` +
        `import { db } from '../lib/nope'\n` +
        `export const q = collection(db, 'orders')\n`,
    })
    expect(await firestoreCrossFileEndpoints(sources, dir)).toEqual([])
  })
})

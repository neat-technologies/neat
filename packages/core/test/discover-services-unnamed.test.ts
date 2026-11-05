import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serviceId } from '@neat.is/types'
import { discoverServices } from '../src/extract/services.js'

// #1557: a package.json with no `name` is still a service when it is an app.
const dirs: string[] = []

async function tree(files: Record<string, unknown>, rootName = 'shop'): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-1557-'))
  dirs.push(base)
  const root = path.join(base, rootName)
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body))
  }
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

const nextApp = {
  private: true,
  scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
  dependencies: { next: '15.0.0', react: '19.0.0' },
}

describe('discoverServices: package.json without a name (#1557)', () => {
  it('discovers a nameless Next.js app at the root under the directory basename', async () => {
    const root = await tree({ 'package.json': nextApp, 'app/page.tsx': 'export default function Page() {}' })
    const services = await discoverServices(root)
    expect(services).toHaveLength(1)
    const [svc] = services
    expect(svc!.node.name).toBe('shop')
    expect(svc!.node.id).toBe(serviceId('shop'))
    expect(svc!.node.framework).toBe('next')
    expect(svc!.node.repoPath).toBe('')
  })

  it('gives the same id on every pass', async () => {
    const root = await tree({ 'apps/web/package.json': nextApp })
    const first = (await discoverServices(root)).map((s) => s.node.id)
    const second = (await discoverServices(root)).map((s) => s.node.id)
    expect(first).toEqual([serviceId('web')])
    expect(second).toEqual(first)
  })

  it('leaves the name to a sibling that declares it, whichever sorts first', async () => {
    const root = await tree({
      'apps/web/package.json': nextApp,
      'packages/web/package.json': { name: 'web', main: 'index.js' },
    })
    const services = await discoverServices(root)
    const byPath = new Map(services.map((s) => [s.node.repoPath, s.node]))
    expect(byPath.get(path.join('packages', 'web'))!.name).toBe('web')
    expect(byPath.get(path.join('apps', 'web'))!.name).toBe('apps/web')
    expect(byPath.get(path.join('apps', 'web'))!.id).toBe(serviceId('apps/web'))
    expect(new Set(services.map((s) => s.node.id)).size).toBe(2)
  })

  it('keeps two nameless apps with the same basename apart', async () => {
    const root = await tree({
      'apps/web/package.json': nextApp,
      'legacy/web/package.json': { scripts: { start: 'node server.js' } },
    })
    const names = (await discoverServices(root)).map((s) => s.node.name).sort()
    expect(names).toEqual(['legacy/web', 'web'])
  })

  it('skips a nameless root that clashes with a declared child, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = await tree({ 'package.json': nextApp, 'api/package.json': { name: 'shop', main: 'index.js' } })
    const services = await discoverServices(root)
    expect(services.map((s) => s.node.repoPath)).toEqual(['api'])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('does not treat a module-type marker or a tooling-only root as a service', async () => {
    const root = await tree({
      'package.json': { private: true, devDependencies: { prettier: '3.0.0' }, scripts: { format: 'prettier -w .' } },
      'src/esm/package.json': { type: 'module' },
      'svc/package.json': { name: 'svc', main: 'index.js' },
    })
    expect((await discoverServices(root)).map((s) => s.node.name)).toEqual(['svc'])
  })

  it('still lets a declared root name win, unchanged', async () => {
    const root = await tree({ 'package.json': { ...nextApp, name: 'storefront' } })
    const [svc] = await discoverServices(root)
    expect(svc!.node.name).toBe('storefront')
    expect(svc!.nameFromDir).toBeUndefined()
  })
})

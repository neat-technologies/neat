import { describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { NodeType, serviceId } from '@neat.is/types'
import type { ServiceNode } from '@neat.is/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ADR-252 (#1412) — a C# service is named from its directory, not the `.csproj`
// assembly name. The otel-demo `accounting` service ships a PascalCase
// `Accounting.csproj` at its root yet deploys as the lowercase `service.name`
// `accounting`; the assembly-name convention minted `service:Accounting`, which never
// fused with the runtime `service:accounting` (166 spans, zero edges). The directory
// matches the deployed name, like every other manifest reader.
describe('C# service name from directory (ADR-252, #1412)', () => {
  beforeEach(() => resetGraph())

  it('names a flat service with a PascalCase .csproj from its lowercase directory', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, path.resolve(__dirname, 'fixtures', 'csharp-accounting-flat'))

    // The directory `accounting` names the service, matching the deployed service.name.
    expect(graph.hasNode(serviceId('accounting'))).toBe(true)
    const svc = graph.getNodeAttributes(serviceId('accounting')) as ServiceNode
    expect(svc.type).toBe(NodeType.ServiceNode)
    expect(svc.language).toBe('csharp')
    // The PascalCase assembly name never becomes the id — that was the fusion bug.
    expect(graph.hasNode(serviceId('Accounting'))).toBe(false)
  })

  it('folds a nested src/ + tests/ layout onto one service, never a bogus src / tests node', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-csharp-nested-'))
    try {
      // The otel-demo `cart` shape: a `.sln` at the service root, the project under
      // `src/`, a test project under `tests/`. resolveProjectDir pins the root via the
      // `.sln`, so `src/` and `tests/` surface as their own candidates and must fold
      // back onto `orders` rather than mint bogus `src` / `tests` services.
      await fs.mkdir(path.join(dir, 'orders', 'src'), { recursive: true })
      await fs.mkdir(path.join(dir, 'orders', 'tests'), { recursive: true })
      await fs.writeFile(path.join(dir, 'orders', 'Orders.sln'), '# sln\n')
      await fs.writeFile(
        path.join(dir, 'orders', 'src', 'Orders.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
      )
      await fs.writeFile(path.join(dir, 'orders', 'src', 'Program.cs'), 'class P {}\n')
      await fs.writeFile(
        path.join(dir, 'orders', 'tests', 'Orders.Tests.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
      )

      const graph = getGraph()
      await extractFromDirectory(graph, dir)

      expect(graph.hasNode(serviceId('orders'))).toBe(true)
      // No service minted from the conventional subdirectories.
      expect(graph.hasNode(serviceId('src'))).toBe(false)
      expect(graph.hasNode(serviceId('tests'))).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

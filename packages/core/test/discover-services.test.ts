import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServiceNode, SymbolNode } from '@neat.is/types'
import { NodeType, serviceId, symbolId } from '@neat.is/types'
import { discoverServices } from '../src/extract/services.js'
import { extractFromDirectory } from '../src/extract.js'
import { getGraph, resetGraph } from '../src/graph.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, 'fixtures')

describe('discoverServices', () => {
  const originalScanDepth = process.env.NEAT_SCAN_DEPTH

  beforeEach(() => {
    delete process.env.NEAT_SCAN_DEPTH
  })

  afterEach(() => {
    if (originalScanDepth === undefined) delete process.env.NEAT_SCAN_DEPTH
    else process.env.NEAT_SCAN_DEPTH = originalScanDepth
    vi.restoreAllMocks()
  })

  it('walks the tree recursively and finds nested package.jsons', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'monorepo'))
    const names = services.map((s) => s.node.name).sort()
    expect(names).toEqual(['fixture-app-a', 'fixture-lib', 'fixture-service-b'])
  })

  it('records repoPath relative to scan path', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'monorepo'))
    const byName = new Map(services.map((s) => [s.node.name, s.node.repoPath]))
    expect(byName.get('fixture-app-a')).toBe(path.join('apps', 'a'))
    expect(byName.get('fixture-service-b')).toBe(path.join('services', 'b'))
    expect(byName.get('fixture-lib')).toBe(path.join('packages', 'lib'))
  })

  it('honours package.json#workspaces globs and ignores paths outside them', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'monorepo-workspaces'))
    const names = services.map((s) => s.node.name).sort()
    expect(names).toEqual(['fixture-ws-lib'])
  })

  it('warns on duplicate package names and keeps only the first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const services = await discoverServices(path.join(FIXTURES, 'monorepo-duplicates'))
    expect(services).toHaveLength(1)
    expect(services[0]!.node.name).toBe('fixture-dup')
    expect(warn).toHaveBeenCalledOnce()
    const message = warn.mock.calls[0]![0] as string
    expect(message).toContain('fixture-dup')
    expect(message).toContain(path.join('apps', 'a'))
    expect(message).toContain(path.join('services', 'a'))
  })

  it('skips directories matched by the root .gitignore', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'monorepo-gitignore'))
    const names = services.map((s) => s.node.name).sort()
    expect(names).toEqual(['fixture-included'])
  })

  it('respects NEAT_SCAN_DEPTH=0 (root only)', async () => {
    process.env.NEAT_SCAN_DEPTH = '0'
    const services = await discoverServices(path.join(FIXTURES, 'monorepo'))
    expect(services).toEqual([])
  })

  it('marks a service with a tsconfig.json as typescript', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'service-language'))
    const byName = new Map(services.map((s) => [s.node.name, s.node.language]))
    expect(byName.get('fixture-ts-tsconfig')).toBe('typescript')
  })

  it('marks a service depending on typescript as typescript', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'service-language'))
    const byName = new Map(services.map((s) => [s.node.name, s.node.language]))
    expect(byName.get('fixture-ts-dep')).toBe('typescript')
  })

  it('marks a plain JS service (no tsconfig, no typescript dep) as javascript', async () => {
    const services = await discoverServices(path.join(FIXTURES, 'service-language'))
    const byName = new Map(services.map((s) => [s.node.name, s.node.language]))
    expect(byName.get('fixture-plain-js')).toBe('javascript')
  })

  describe('root manifest, no package.json', () => {
    let tmp: string

    afterEach(async () => {
      if (tmp) await fs.rm(tmp, { recursive: true, force: true })
    })

    it('discovers a Python project whose pyproject.toml sits at the root', async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-py-root-'))
      await fs.writeFile(
        path.join(tmp, 'pyproject.toml'),
        '[tool.poetry]\nname = "fixture-py-root"\nversion = "1.2.3"\n',
      )
      await fs.mkdir(path.join(tmp, 'app'))
      await fs.writeFile(path.join(tmp, 'app', 'main.py'), 'def handler():\n    return 1\n')

      const services = await discoverServices(tmp)
      expect(services).toHaveLength(1)
      expect(services[0]!.node.name).toBe('fixture-py-root')
      expect(services[0]!.node.language).toBe('python')
    })

    it('still discovers a JS project from its root package.json', async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-js-root-'))
      await fs.writeFile(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'fixture-js-root', version: '0.1.0' }),
      )

      const services = await discoverServices(tmp)
      expect(services).toHaveLength(1)
      expect(services[0]!.node.name).toBe('fixture-js-root')
      expect(services[0]!.node.language).toBe('javascript')
    })
  })
})

// ADR-194 — a directory with a Dockerfile plus source but no language manifest is
// discovered as a service, language inferred from the primary top-level source.
// The `dockerfile-service` fixture holds the load-generator shape and three
// file-based negatives under one scan root; the ignored-dir negative is built in
// a tmp tree so it can use a real `node_modules` boundary.
describe('Dockerfile-declared service discovery (ADR-194)', () => {
  const ROOT = path.join(FIXTURES, 'dockerfile-service')
  let tmp: string | undefined

  beforeEach(() => {
    delete process.env.NEAT_SCAN_DEPTH
    tmp = undefined
  })

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  })

  it('mints exactly one JS ServiceNode for a Dockerfile + source dir with no manifest', async () => {
    const services = await discoverServices(ROOT)
    const lg = services.filter((s) => s.node.name === 'load-generator')
    expect(lg, 'exactly one load-generator service').toHaveLength(1)
    expect(lg[0]!.node.language).toBe('javascript')
    expect(lg[0]!.node.repoPath).toBe('load-generator')
    expect(lg[0]!.node.dependencies).toEqual({})
    expect(lg[0]!.node.id).toBe(serviceId('load-generator'))
  })

  it('mints nothing for a Dockerfile alone (no source)', async () => {
    const names = (await discoverServices(ROOT)).map((s) => s.node.name)
    expect(names).not.toContain('dockerfile-only')
  })

  it('mints nothing for source alone (no Dockerfile, no manifest)', async () => {
    const names = (await discoverServices(ROOT)).map((s) => s.node.name)
    expect(names).not.toContain('source-only')
  })

  it('lets the manifest win, without double-minting, when a dir has both', async () => {
    const services = await discoverServices(ROOT)
    // Discovered under its package.json name, never the basename `with-manifest`.
    expect(services.some((s) => s.node.name === 'with-manifest')).toBe(false)
    const wm = services.filter((s) => s.node.name === 'fixture-with-manifest')
    expect(wm, 'exactly one node for the manifest dir').toHaveLength(1)
    expect(wm[0]!.node.language).toBe('javascript')
    expect(wm[0]!.dir.endsWith(path.join('dockerfile-service', 'with-manifest'))).toBe(true)
  })

  it('discovers exactly the two real services under the scan root', async () => {
    const names = (await discoverServices(ROOT)).map((s) => s.node.name).sort()
    expect(names).toEqual(['fixture-with-manifest', 'load-generator'])
  })

  it('mints nothing inside an ignored (vendored) directory', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-docker-ignored-'))
    const svc = path.join(tmp, 'node_modules', 'vendored-svc')
    await fs.mkdir(svc, { recursive: true })
    await fs.writeFile(
      path.join(svc, 'Dockerfile'),
      'FROM node:20-alpine\nCMD ["node", "script.js"]\n',
    )
    await fs.writeFile(
      path.join(svc, 'script.js'),
      'function handler() {\n  return 1\n}\nmodule.exports = { handler }\n',
    )

    const services = await discoverServices(tmp)
    expect(services).toEqual([])
  })

  it('symbol-grains the discovered JS service — script.js becomes SymbolNodes', async () => {
    resetGraph()
    const graph = getGraph()
    await extractFromDirectory(graph, ROOT)

    // The service exists as a real static node.
    const svcId = serviceId('load-generator')
    expect(graph.hasNode(svcId)).toBe(true)
    expect((graph.getNodeAttributes(svcId) as ServiceNode).language).toBe('javascript')

    // And script.js grained into symbols (JS is a symbol grammar, ADR-158/192),
    // so the manifest-less service reaches symbol grain with no extra wiring.
    for (const qualname of ['setup', 'loadTest', 'placeOrder']) {
      const sid = symbolId('load-generator', 'script.js', qualname)
      expect(graph.hasNode(sid), `missing symbol ${qualname}`).toBe(true)
      expect((graph.getNodeAttributes(sid) as SymbolNode).type).toBe(NodeType.SymbolNode)
    }
  })
})

// ADR-196 — a C#/.NET service is a directory that ships an MSBuild project. Its
// marker is a glob (`*.csproj` / `*.sln`), not a fixed filename, so discovery reads
// the directory; the `.csproj` names the service (its basename), `PackageReference`
// items become the dependency map, and a `.sln`-only directory falls back to the
// directory basename.
describe('C#/.NET service discovery (ADR-196)', () => {
  let tmp: string

  beforeEach(() => {
    delete process.env.NEAT_SCAN_DEPTH
  })

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  })

  const CSPROJ = [
    '<Project Sdk="Microsoft.NET.Sdk.Web">',
    '  <ItemGroup>',
    '    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8.0.0" />',
    '    <PackageReference Include="Npgsql" Version="8.0.3" />',
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\n')

  it('mints one csharp ServiceNode named after the .csproj, with PackageReference deps', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cs-'))
    const dir = path.join(tmp, 'services', 'cart')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'Cart.csproj'), CSPROJ)
    await fs.writeFile(path.join(dir, 'Program.cs'), 'class Program { static void Main() {} }\n')

    const services = await discoverServices(tmp)
    const cart = services.filter((s) => s.node.name === 'Cart')
    expect(cart, 'exactly one Cart service').toHaveLength(1)
    expect(cart[0]!.node.language).toBe('csharp')
    expect(cart[0]!.node.id).toBe(serviceId('Cart'))
    expect(cart[0]!.node.repoPath).toBe(path.join('services', 'cart'))
    expect(cart[0]!.node.dependencies).toEqual({
      'Microsoft.AspNetCore.OpenApi': '8.0.0',
      Npgsql: '8.0.3',
    })
  })

  it('discovers a .NET project whose .csproj sits at the scan root', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cs-root-'))
    await fs.writeFile(path.join(tmp, 'Accounting.csproj'), CSPROJ)
    await fs.mkdir(path.join(tmp, 'src'))
    await fs.writeFile(
      path.join(tmp, 'src', 'Worker.cs'),
      'namespace Accounting;\npublic class Worker { public void Run() {} }\n',
    )

    const services = await discoverServices(tmp)
    expect(services).toHaveLength(1)
    expect(services[0]!.node.name).toBe('Accounting')
    expect(services[0]!.node.language).toBe('csharp')
  })

  it('falls back to the directory basename for a .sln-only directory', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cs-sln-'))
    const dir = path.join(tmp, 'shop')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'Shop.sln'), 'Microsoft Visual Studio Solution File\n')
    await fs.writeFile(path.join(dir, 'entry.cs'), 'class Entry {}\n')

    const services = await discoverServices(tmp)
    const shop = services.filter((s) => s.node.name === 'shop')
    expect(shop, 'one service named after the .sln directory').toHaveLength(1)
    expect(shop[0]!.node.language).toBe('csharp')
    expect(shop[0]!.node.dependencies).toEqual({})
  })

  // The flat layout: the `.csproj` and every `.cs` sit directly in the service
  // directory (the otel-demo `accounting` shape). Discovery reads the directory,
  // so this is the base case — the guard is that it stays one node named after the
  // project with its source rooted right there.
  it('discovers a flat-layout service — .csproj and .cs directly in the service dir', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cs-flat-'))
    const dir = path.join(tmp, 'src', 'accounting')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'Accounting.csproj'), CSPROJ)
    for (const f of ['Program.cs', 'Consumer.cs', 'Entities.cs']) {
      await fs.writeFile(path.join(dir, f), `namespace Accounting;\npublic class ${f.replace('.cs', '')} {}\n`)
    }

    const services = await discoverServices(tmp)
    const acc = services.filter((s) => s.node.name === 'Accounting')
    expect(acc, 'exactly one Accounting service').toHaveLength(1)
    expect(acc[0]!.node.language).toBe('csharp')
    expect(acc[0]!.node.repoPath).toBe(path.join('src', 'accounting'))
  })

  // The nested layout: the `.csproj` and `.cs` live one `src/` level down from the
  // service root (the otel-demo `cart` shape). Scanning the service root directly
  // at depth 0 leaves the root as the only candidate, so the broadened lookup has
  // to reach into `src/` — on the old top-level-only check this found nothing.
  it('discovers a nested-src service scanned at its own root (depth 0)', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cs-nested-'))
    await fs.mkdir(path.join(tmp, 'src'), { recursive: true })
    await fs.writeFile(path.join(tmp, 'src', 'Cart.csproj'), CSPROJ)
    await fs.writeFile(path.join(tmp, 'src', 'Program.cs'), 'class Program { static void Main() {} }\n')

    process.env.NEAT_SCAN_DEPTH = '0'
    const services = await discoverServices(tmp)
    delete process.env.NEAT_SCAN_DEPTH

    const cart = services.filter((s) => s.node.language === 'csharp')
    expect(cart, 'exactly one nested-src service').toHaveLength(1)
    expect(cart[0]!.node.name).toBe('Cart')
    expect(cart[0]!.node.repoPath).toBe('src')
    expect(cart[0]!.node.dependencies).toEqual({
      'Microsoft.AspNetCore.OpenApi': '8.0.0',
      Npgsql: '8.0.3',
    })
  })

  // A whole-repo walk reaches both the service root and its `src/` project, so both
  // resolve to the same project directory. That must collapse to one node with no
  // duplicate-name warning — the nested case never double-mints.
  it('mints one node, no duplicate warning, when the walk reaches the root and its src/ project', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-cs-both-'))
    const svc = path.join(tmp, 'services', 'cart')
    await fs.mkdir(path.join(svc, 'src'), { recursive: true })
    await fs.writeFile(path.join(svc, 'src', 'Cart.csproj'), CSPROJ)
    await fs.writeFile(path.join(svc, 'src', 'Program.cs'), 'class Program {}\n')

    const services = await discoverServices(tmp)
    const cart = services.filter((s) => s.node.name === 'Cart')
    expect(cart, 'exactly one Cart node').toHaveLength(1)
    expect(cart[0]!.node.repoPath).toBe(path.join('services', 'cart', 'src'))
    const dupWarns = warn.mock.calls.filter((c) => String(c[0]).includes('duplicate'))
    expect(dupWarns, 'no duplicate-name warning for the root/src pair').toHaveLength(0)
  })
})

// ADR-197 — a Java service is a directory that ships a build manifest: a Maven
// `pom.xml` or a Gradle `build.gradle` / `build.gradle.kts`. Unlike C#, the marker is
// a fixed filename, so discovery rides the same `exists` predicate the Ruby/PHP/Go
// readers use. A Maven POM names the service (its `<artifactId>`, with `<parent>`
// stripped so the parent's artifactId can't be mistaken for it); a Gradle build has
// no name here, so it falls back to the directory basename. Declared dependencies
// register as `groupId:artifactId` gates.
describe('Java service discovery (ADR-197)', () => {
  let tmp: string

  beforeEach(() => {
    delete process.env.NEAT_SCAN_DEPTH
  })

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  })

  const POM = (artifactId: string) =>
    [
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      '  <modelVersion>4.0.0</modelVersion>',
      '  <parent>',
      '    <groupId>org.springframework.boot</groupId>',
      '    <artifactId>spring-boot-starter-parent</artifactId>',
      '    <version>3.2.0</version>',
      '  </parent>',
      '  <groupId>com.example</groupId>',
      `  <artifactId>${artifactId}</artifactId>`,
      '  <version>1.0.0</version>',
      '  <dependencies>',
      '    <dependency>',
      '      <groupId>org.springframework.boot</groupId>',
      '      <artifactId>spring-boot-starter-web</artifactId>',
      '    </dependency>',
      '    <dependency>',
      '      <groupId>org.postgresql</groupId>',
      '      <artifactId>postgresql</artifactId>',
      '      <version>42.7.1</version>',
      '    </dependency>',
      '  </dependencies>',
      '</project>',
      '',
    ].join('\n')

  it('mints one java ServiceNode named after the pom <artifactId>, with groupId:artifactId deps', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-java-'))
    const dir = path.join(tmp, 'services', 'cart')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'pom.xml'), POM('cart'))
    await fs.writeFile(
      path.join(dir, 'CartApplication.java'),
      'package com.example.cart;\npublic class CartApplication {}\n',
    )

    const services = await discoverServices(tmp)
    const cart = services.filter((s) => s.node.name === 'cart')
    expect(cart, 'exactly one cart service').toHaveLength(1)
    expect(cart[0]!.node.language).toBe('java')
    expect(cart[0]!.node.id).toBe(serviceId('cart'))
    expect(cart[0]!.node.repoPath).toBe(path.join('services', 'cart'))
    // The parent's artifactId is stripped, so the project name is not
    // spring-boot-starter-parent; a managed (version-less) dependency registers at ''.
    expect(cart[0]!.node.dependencies).toEqual({
      'org.springframework.boot:spring-boot-starter-web': '',
      'org.postgresql:postgresql': '42.7.1',
    })
  })

  it('discovers a Java project whose pom.xml sits at the scan root', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-java-root-'))
    await fs.writeFile(path.join(tmp, 'pom.xml'), POM('accounting'))
    await fs.mkdir(path.join(tmp, 'src'))
    await fs.writeFile(
      path.join(tmp, 'src', 'Worker.java'),
      'package com.example.accounting;\npublic class Worker { public void run() {} }\n',
    )

    const services = await discoverServices(tmp)
    expect(services).toHaveLength(1)
    expect(services[0]!.node.name).toBe('accounting')
    expect(services[0]!.node.language).toBe('java')
  })

  it('discovers a Gradle service, naming it after its directory, with implementation deps', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-gradle-'))
    const dir = path.join(tmp, 'ad')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'build.gradle'),
      [
        "plugins {",
        "    id 'java'",
        "    id 'org.springframework.boot' version '3.2.0'",
        "}",
        "",
        "dependencies {",
        "    implementation 'org.springframework.boot:spring-boot-starter-web:3.2.0'",
        "    implementation 'org.postgresql:postgresql:42.7.1'",
        "    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'",
        "}",
        "",
      ].join('\n'),
    )
    await fs.writeFile(path.join(dir, 'Ad.java'), 'package oteldemo;\npublic class Ad {}\n')

    const services = await discoverServices(tmp)
    const ad = services.filter((s) => s.node.name === 'ad')
    expect(ad, 'one service named after the Gradle directory').toHaveLength(1)
    expect(ad[0]!.node.language).toBe('java')
    // The plugins block's `id`/`version` lines are not dependency configurations.
    expect(ad[0]!.node.dependencies).toEqual({
      'org.springframework.boot:spring-boot-starter-web': '3.2.0',
      'org.postgresql:postgresql': '42.7.1',
      'org.junit.jupiter:junit-jupiter': '5.10.0',
    })
  })

  it('reads the Kotlin-DSL build.gradle.kts implementation("…") form', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-gradle-kts-'))
    const dir = path.join(tmp, 'billing')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'build.gradle.kts'),
      [
        'plugins {',
        '    id("org.springframework.boot") version "3.2.0"',
        '}',
        '',
        'dependencies {',
        '    implementation("org.springframework.boot:spring-boot-starter-web:3.2.0")',
        '    implementation("com.google.cloud:google-cloud-pubsub:1.125.0")',
        '}',
        '',
      ].join('\n'),
    )
    await fs.writeFile(path.join(dir, 'Billing.java'), 'package oteldemo;\npublic class Billing {}\n')

    const services = await discoverServices(tmp)
    const billing = services.filter((s) => s.node.name === 'billing')
    expect(billing, 'one Gradle-Kotlin service').toHaveLength(1)
    expect(billing[0]!.node.language).toBe('java')
    expect(billing[0]!.node.dependencies).toEqual({
      'org.springframework.boot:spring-boot-starter-web': '3.2.0',
      'com.google.cloud:google-cloud-pubsub': '1.125.0',
    })
  })
})

// ADR-199 — Kotlin is Java's JVM sibling and shares its whole build toolchain: a
// Kotlin service carries the same Maven `pom.xml` or Gradle `build.gradle` /
// `build.gradle.kts` a Java one does. The manifest can't tell them apart, so the
// `.kt`-vs-`.java` source decides: a JVM-manifest directory whose source is `.kt` is
// a `kotlin` ServiceNode (the otel-demo `fraud-detection` shape — `build.gradle.kts`
// plus `src/main/kotlin/frauddetection/*.kt`), one whose source is `.java` stays
// `java` exactly as before. Naming and dependency gates are reused from the Java
// reader, so a Maven POM still names the service after its `<artifactId>` and a Gradle
// build after its directory.
describe('Kotlin service discovery (ADR-199)', () => {
  let tmp: string

  beforeEach(() => {
    delete process.env.NEAT_SCAN_DEPTH
  })

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  })

  it('discovers a Gradle service whose source is Kotlin as a kotlin ServiceNode, source nested under src/main/kotlin', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-kotlin-'))
    const dir = path.join(tmp, 'fraud-detection')
    // The .kt source sits several levels below the manifest, the real Gradle layout —
    // the discriminator has to descend to find it, not just read the top level.
    const src = path.join(dir, 'src', 'main', 'kotlin', 'frauddetection')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'build.gradle.kts'),
      [
        'plugins {',
        '    id("org.springframework.boot") version "3.2.0"',
        '    kotlin("jvm") version "1.9.22"',
        '}',
        '',
        'dependencies {',
        '    implementation("org.springframework.boot:spring-boot-starter-web:3.2.0")',
        '    implementation("org.postgresql:postgresql:42.7.1")',
        '}',
        '',
      ].join('\n'),
    )
    await fs.writeFile(
      path.join(src, 'FraudService.kt'),
      'package frauddetection\n\nclass FraudService {\n    fun check(): Boolean = true\n}\n',
    )

    const services = await discoverServices(tmp)
    const fraud = services.filter((s) => s.node.name === 'fraud-detection')
    expect(fraud, 'one kotlin service named after the Gradle directory').toHaveLength(1)
    expect(fraud[0]!.node.language).toBe('kotlin')
    expect(fraud[0]!.node.id).toBe(serviceId('fraud-detection'))
    expect(fraud[0]!.node.repoPath).toBe('fraud-detection')
    expect(fraud[0]!.node.dependencies).toEqual({
      'org.springframework.boot:spring-boot-starter-web': '3.2.0',
      'org.postgresql:postgresql': '42.7.1',
    })
  })

  it('keys on the source, not the build DSL: a Groovy build.gradle with .kt source is still kotlin', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-kotlin-groovy-'))
    const dir = path.join(tmp, 'shipping')
    const src = path.join(dir, 'src', 'main', 'kotlin')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'build.gradle'),
      [
        'plugins {',
        "    id 'org.jetbrains.kotlin.jvm' version '1.9.22'",
        '}',
        '',
        'dependencies {',
        "    implementation 'io.ktor:ktor-server-core:2.3.7'",
        '}',
        '',
      ].join('\n'),
    )
    await fs.writeFile(path.join(src, 'Shipping.kt'), 'package shipping\n\nobject Shipping\n')

    const services = await discoverServices(tmp)
    const shipping = services.filter((s) => s.node.name === 'shipping')
    expect(shipping, 'a Groovy-DSL Gradle build with Kotlin source is kotlin').toHaveLength(1)
    expect(shipping[0]!.node.language).toBe('kotlin')
    expect(shipping[0]!.node.dependencies).toEqual({ 'io.ktor:ktor-server-core': '2.3.7' })
  })

  it('does not regress Java: a Gradle build.gradle with .java source stays java', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-jvm-java-'))
    const dir = path.join(tmp, 'ad')
    const src = path.join(dir, 'src', 'main', 'java', 'oteldemo')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'build.gradle'),
      [
        'plugins {',
        "    id 'java'",
        '}',
        '',
        'dependencies {',
        "    implementation 'org.springframework.boot:spring-boot-starter-web:3.2.0'",
        '}',
        '',
      ].join('\n'),
    )
    await fs.writeFile(path.join(src, 'Ad.java'), 'package oteldemo;\npublic class Ad {}\n')

    const services = await discoverServices(tmp)
    const ad = services.filter((s) => s.node.name === 'ad')
    expect(ad, 'one service').toHaveLength(1)
    // A .java Gradle service is claimed by the Java reader, not Kotlin.
    expect(ad[0]!.node.language).toBe('java')
  })

  it('resolves a mixed JVM tree to the dominant source: more .java than .kt stays java', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-jvm-mixed-'))
    const dir = path.join(tmp, 'legacy')
    const javaSrc = path.join(dir, 'src', 'main', 'java', 'legacy')
    const ktSrc = path.join(dir, 'src', 'main', 'kotlin', 'legacy')
    await fs.mkdir(javaSrc, { recursive: true })
    await fs.mkdir(ktSrc, { recursive: true })
    await fs.writeFile(path.join(dir, 'build.gradle'), 'dependencies {\n}\n')
    await fs.writeFile(path.join(javaSrc, 'A.java'), 'package legacy;\npublic class A {}\n')
    await fs.writeFile(path.join(javaSrc, 'B.java'), 'package legacy;\npublic class B {}\n')
    await fs.writeFile(path.join(ktSrc, 'C.kt'), 'package legacy\n\nobject C\n')

    const services = await discoverServices(tmp)
    const legacy = services.filter((s) => s.node.name === 'legacy')
    expect(legacy).toHaveLength(1)
    // Two .java to one .kt — the Java reader wins.
    expect(legacy[0]!.node.language).toBe('java')
  })

  it('names a Maven Kotlin service after its <artifactId>', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-kotlin-maven-'))
    const dir = path.join(tmp, 'checkout')
    const src = path.join(dir, 'src', 'main', 'kotlin', 'checkout')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'pom.xml'),
      [
        '<project xmlns="http://maven.apache.org/POM/4.0.0">',
        '  <modelVersion>4.0.0</modelVersion>',
        '  <groupId>com.example</groupId>',
        '  <artifactId>checkout-kt</artifactId>',
        '  <version>1.0.0</version>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>org.jetbrains.kotlin</groupId>',
        '      <artifactId>kotlin-stdlib</artifactId>',
        '      <version>1.9.22</version>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
        '',
      ].join('\n'),
    )
    await fs.writeFile(
      path.join(src, 'Checkout.kt'),
      'package checkout\n\nclass Checkout {\n    fun place() {}\n}\n',
    )

    const services = await discoverServices(tmp)
    const checkout = services.filter((s) => s.node.name === 'checkout-kt')
    expect(checkout, 'a Maven Kotlin service named after its artifactId').toHaveLength(1)
    expect(checkout[0]!.node.language).toBe('kotlin')
    expect(checkout[0]!.node.dependencies).toEqual({
      'org.jetbrains.kotlin:kotlin-stdlib': '1.9.22',
    })
  })
})

// ADR-201 — a Rust service is a directory that ships a `Cargo.toml`, the same
// fixed-filename marker the Go/Ruby/Java readers key on. Cargo's `[package] name`
// names the service; a virtual-workspace manifest (a `[workspace]` with no
// `[package]`) carries no name, so it falls back to the directory basename the way a
// Gradle build does. Each `[dependencies]` entry becomes a gate, whether it takes the
// bare-string version form or the inline-table form.
describe('Rust service discovery (ADR-201)', () => {
  let tmp: string

  beforeEach(() => {
    delete process.env.NEAT_SCAN_DEPTH
  })

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  })

  const CARGO = (name: string) =>
    [
      '[package]',
      `name = "${name}"`,
      'version = "0.1.0"',
      'edition = "2021"',
      '',
      '[dependencies]',
      'axum = "0.7"',
      'sqlx = { version = "0.7", features = ["postgres"] }',
      'anyhow = { git = "https://github.com/dtolnay/anyhow" }',
      '',
    ].join('\n')

  it('mints one rust ServiceNode named after the Cargo [package] name, with [dependencies] gates', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-rust-'))
    const dir = path.join(tmp, 'services', 'shipping')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'Cargo.toml'), CARGO('shipping'))
    await fs.writeFile(path.join(dir, 'shipping.rs'), 'pub fn ship() -> u32 { 0 }\n')

    const services = await discoverServices(tmp)
    const shipping = services.filter((s) => s.node.name === 'shipping')
    expect(shipping, 'exactly one shipping service').toHaveLength(1)
    expect(shipping[0]!.node.language).toBe('rust')
    expect(shipping[0]!.node.id).toBe(serviceId('shipping'))
    expect(shipping[0]!.node.repoPath).toBe(path.join('services', 'shipping'))
    // A bare-string dependency keeps its version; an inline-table dependency reads its
    // `version`, and a git-only source (no version) registers at ''.
    expect(shipping[0]!.node.dependencies).toEqual({
      axum: '0.7',
      sqlx: '0.7',
      anyhow: '',
    })
  })

  it('discovers a Rust project whose Cargo.toml sits at the scan root', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-rust-root-'))
    await fs.writeFile(path.join(tmp, 'Cargo.toml'), CARGO('quoter'))
    await fs.mkdir(path.join(tmp, 'src'))
    await fs.writeFile(path.join(tmp, 'src', 'main.rs'), 'fn main() {}\n')

    const services = await discoverServices(tmp)
    expect(services).toHaveLength(1)
    expect(services[0]!.node.name).toBe('quoter')
    expect(services[0]!.node.language).toBe('rust')
  })

  it('falls back to the directory basename for a virtual-workspace manifest with no [package]', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-rust-ws-'))
    const dir = path.join(tmp, 'shipping-workspace')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'Cargo.toml'),
      ['[workspace]', 'members = ["crates/*"]', ''].join('\n'),
    )
    await fs.writeFile(path.join(dir, 'lib.rs'), 'pub fn nothing() {}\n')

    const services = await discoverServices(tmp)
    const ws = services.filter((s) => s.node.name === 'shipping-workspace')
    expect(ws, 'a nameless workspace manifest takes the directory basename').toHaveLength(1)
    expect(ws[0]!.node.language).toBe('rust')
    expect(ws[0]!.node.dependencies).toEqual({})
  })

  it('does not shadow a sibling language: a Go service beside a Rust one still discovers', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neat-rust-go-'))
    const rustDir = path.join(tmp, 'shipping')
    const goDir = path.join(tmp, 'orders')
    await fs.mkdir(rustDir, { recursive: true })
    await fs.mkdir(goDir, { recursive: true })
    await fs.writeFile(path.join(rustDir, 'Cargo.toml'), CARGO('shipping'))
    await fs.writeFile(path.join(rustDir, 'lib.rs'), 'pub fn ship() {}\n')
    await fs.writeFile(path.join(goDir, 'go.mod'), 'module orders\n\ngo 1.22\n')
    await fs.writeFile(path.join(goDir, 'main.go'), 'package main\n\nfunc main() {}\n')

    const services = await discoverServices(tmp)
    const byName = new Map(services.map((s) => [s.node.name, s.node.language]))
    expect(byName.get('shipping')).toBe('rust')
    expect(byName.get('orders')).toBe('go')
  })
})

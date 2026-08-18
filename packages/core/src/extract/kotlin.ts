import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServiceNode } from '@neat.is/types'
import { NodeType, serviceId } from '@neat.is/types'
import { exists, IGNORED_DIRS, type DiscoveredService, type PackageJson } from './shared.js'
import {
  JAVA_MANIFESTS,
  parseGradle,
  parsePomXml,
  hasJavaManifest,
  type JavaManifest,
} from './java.js'

// Kotlin service discovery (ADR-199). Kotlin is the JVM sibling of Java (ADR-197)
// and shares its entire build toolchain: a Kotlin service is a directory with the
// *same* Maven `pom.xml` or Gradle `build.gradle` / `build.gradle.kts` a Java
// service carries — the manifest alone can't tell the two apart. So the marker is
// the source, not the manifest: a JVM manifest directory whose source is `.kt` is
// Kotlin, one whose source is `.java` is Java. This reader keys on that
// discriminator, running ahead of `discoverJavaService` in the chain so a
// `.kt`-dominant Gradle directory (the otel-demo `fraud-detection` shape —
// `build.gradle.kts` plus `src/main/kotlin/frauddetection/*.kt`) mints a **kotlin**
// ServiceNode, while a `.java`-dominant one falls through untouched and Java claims
// it exactly as before. The manifest parsing (POM `<artifactId>` naming, Gradle
// basename fallback, `groupId:artifactId` dependency gates) is reused verbatim from
// `extract/java.ts` — only the language label and the source-based discriminator
// differ.

// Kotlin source files. A `.kt` under the service tree is what tells a JVM-manifest
// directory apart from a Java one; the Gradle Kotlin-DSL build script is `.kts`
// (a manifest, not service source), so it never counts here.
export const KOTLIN_SOURCE_EXT = '.kt'
const JAVA_SOURCE_EXT = '.java'

// How deep to look for source under a service directory when deciding Kotlin vs
// Java. Kotlin conventionally lives at `src/main/kotlin/<pkg>/…`, several levels
// below the manifest, so a top-level-only look (the Dockerfile fallback's precision
// knob) would miss it — the discriminator has to descend, but bounded so a large
// tree doesn't turn discovery into a full walk.
const SOURCE_PROBE_MAX_DEPTH = 8

// The JVM source language a manifest directory actually holds. A bounded recursive
// count of `.kt` vs `.java` files under the directory (`IGNORED_DIRS` skipped, so
// `build/` output and vendored trees don't sway it): Kotlin wins when it is present
// and at least ties Java, so a pure-Kotlin service resolves to `kotlin`, a pure-Java
// one to `java`, and a mixed tree to whichever source dominates (ties to Kotlin,
// the more specific case). `undefined` when the directory carries neither, which
// leaves the JVM readers to fall through on a manifest with no JVM source yet.
export async function dominantJvmSourceLanguage(
  dir: string,
): Promise<'kotlin' | 'java' | undefined> {
  let kt = 0
  let java = 0

  async function recurse(current: string, depth: number): Promise<void> {
    if (depth > SOURCE_PROBE_MAX_DEPTH) return
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await recurse(path.join(current, entry.name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (ext === KOTLIN_SOURCE_EXT) kt++
      else if (ext === JAVA_SOURCE_EXT) java++
    }
  }
  await recurse(dir, 0)

  if (kt > 0 && kt >= java) return 'kotlin'
  if (java > 0) return 'java'
  return undefined
}

// Read the JVM build manifest a directory ships, with the same precedence
// `discoverJavaService` uses (a `pom.xml` next to a `build.gradle` is a Maven
// project with a Gradle wrapper checked in, so Maven wins; then Gradle Groovy, then
// the Kotlin DSL). Reused so a Kotlin service is named and gated the same way its
// Java sibling is.
async function readJvmManifest(dir: string): Promise<JavaManifest | null> {
  const pomPath = path.join(dir, JAVA_MANIFESTS[0])
  const gradlePath = path.join(dir, JAVA_MANIFESTS[1])
  const gradleKtsPath = path.join(dir, JAVA_MANIFESTS[2])
  if (await exists(pomPath)) {
    return parsePomXml(await fs.readFile(pomPath, 'utf8').catch(() => ''))
  }
  if (await exists(gradlePath)) {
    return parseGradle(await fs.readFile(gradlePath, 'utf8').catch(() => ''))
  }
  if (await exists(gradleKtsPath)) {
    return parseGradle(await fs.readFile(gradleKtsPath, 'utf8').catch(() => ''))
  }
  return null
}

export async function discoverKotlinService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  // Kotlin and Java both mark a service with a Maven/Gradle manifest — the source
  // decides which. Only claim the directory when a JVM manifest is present *and*
  // Kotlin is the dominant source; otherwise fall through so `discoverJavaService`
  // handles a Java (or source-less) manifest directory exactly as it did before.
  if (!(await hasJavaManifest(dir))) return null
  if ((await dominantJvmSourceLanguage(dir)) !== 'kotlin') return null

  const manifest = await readJvmManifest(dir)
  if (!manifest) return null

  // A Maven `<artifactId>` names the service; a Gradle build carries no name here,
  // so it takes the directory basename the Go/Ruby/PHP readers use.
  const name = manifest.name?.trim() || path.basename(dir)
  const dependencies = manifest.dependencies

  const pkg: PackageJson = { name, dependencies }
  const node: ServiceNode = {
    id: serviceId(name),
    type: NodeType.ServiceNode,
    name,
    language: 'kotlin',
    dependencies,
    repoPath: path.relative(scanPath, dir),
  }
  return { pkg, dir, node }
}

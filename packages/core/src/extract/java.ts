import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServiceNode } from '@neat.is/types'
import { NodeType, serviceId } from '@neat.is/types'
import { exists, type DiscoveredService, type PackageJson } from './shared.js'

// Java service discovery (ADR-197), the build-manifest analog of extract/ruby.ts's
// Gemfile reader, extract/php.ts's composer.json reader, and extract/go.ts's go.mod
// reader. A Java service is a directory that ships a build manifest — a Maven
// `pom.xml` or a Gradle `build.gradle` / `build.gradle.kts`. Unlike C# (ADR-196),
// the marker is a fixed filename, so it rides the same `exists` predicate the
// Ruby/PHP/Go readers use rather than a directory glob. Maven's `pom.xml` names the
// project (its `<artifactId>`); a Gradle build has no name in `build.gradle` (the
// canonical `rootProject.name` lives in `settings.gradle`), so it falls back to the
// directory basename — the same basename-as-service-name convention the Gemfile and
// go.mod readers use. Declared dependencies (`groupId:artifactId`) become the gates
// a later Spring / JPA recognizer keys on, the way a go.mod `require` block does.

// The build manifests that mark a Java service directory. Maven keys on `pom.xml`;
// Gradle on `build.gradle` (Groovy DSL) or `build.gradle.kts` (Kotlin DSL). Any one
// is an explicit "this is a Java service" marker, a fixed filename, not a glob.
export const JAVA_MANIFESTS = ['pom.xml', 'build.gradle', 'build.gradle.kts'] as const

export interface JavaManifest {
  // The project name a Maven `pom.xml` declares (`<artifactId>`), if any. Gradle
  // builds carry no name here, so this is undefined and discovery uses the dir.
  name?: string
  dependencies: Record<string, string>
}

// Cheap predicate the discovery walk and the Dockerfile fallback share: does this
// directory carry a Maven or Gradle build manifest? A fixed-filename `exists`
// check, the same shape `hasGoManifest` uses (extract/services.ts) — the Java
// marker is a filename, not the directory glob C# needs (ADR-196).
export async function hasJavaManifest(dir: string): Promise<boolean> {
  for (const manifest of JAVA_MANIFESTS) {
    if (await exists(path.join(dir, manifest))) return true
  }
  return false
}

// Read a Maven `pom.xml`. A line/regex scan for the project `<artifactId>` and the
// `<dependency>` coordinates, the same discipline go.ts's go.mod reader and ruby.ts's
// Gemfile reader use for polyglot manifest data — not a full POM model with property
// or parent-inheritance resolution. The project name is the first `<artifactId>`
// once `<parent>` / `<dependencyManagement>` / `<dependencies>` / `<build>` blocks
// are stripped, so the parent's or a dependency's artifactId can't be mistaken for
// it. Each `<dependency>` registers as `groupId:artifactId` → version (version is
// optional under a managed BOM, so it falls back to ''); `org.springframework.boot:*`
// in the map is the gate a later Spring route recognizer reads.
export function parsePomXml(source: string): JavaManifest {
  const dependencies: Record<string, string> = {}
  const depBlock = /<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g
  let d: RegExpExecArray | null
  while ((d = depBlock.exec(source)) !== null) {
    const body = d[1] ?? ''
    const groupId = body.match(/<groupId>\s*([^<]+?)\s*<\/groupId>/)?.[1]
    const artifactId = body.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1]
    if (!groupId || !artifactId) continue
    const version = body.match(/<version>\s*([^<]+?)\s*<\/version>/)?.[1]
    dependencies[`${groupId}:${artifactId}`] = version ?? ''
  }

  const withoutBlocks = source
    .replace(/<parent\b[^>]*>[\s\S]*?<\/parent>/g, '')
    .replace(/<dependencyManagement\b[^>]*>[\s\S]*?<\/dependencyManagement>/g, '')
    .replace(/<dependencies\b[^>]*>[\s\S]*?<\/dependencies>/g, '')
    .replace(/<build\b[^>]*>[\s\S]*?<\/build>/g, '')
  const name = withoutBlocks.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1]
  return { name, dependencies }
}

// The Gradle configurations that declare a runtime/compile dependency. A `gem`-line
// equivalent for `build.gradle` — the string-notation coordinate is what a later
// recognizer gates on, so the map form (`group:`, `name:`, `version:`) is out of
// scope for a v1 line scan, the same way ruby.ts skips option-only `gem` forms.
const GRADLE_CONFIGS =
  'implementation|api|compileOnly|runtimeOnly|compileOnlyApi|testImplementation|testRuntimeOnly|testCompileOnly|annotationProcessor|developmentOnly|runtimeClasspath'

// Read a Gradle `build.gradle` / `build.gradle.kts`. A line scan for
// `implementation 'group:artifact:version'` (and the Kotlin-DSL `implementation("…")`
// form) — the same discipline the Gemfile reader uses. The coordinate's first two
// `:`-separated segments are the `groupId:artifactId` key; the remainder (version,
// or version+classifier) is the value, '' when the coordinate names no version.
export function parseGradle(source: string): JavaManifest {
  const dependencies: Record<string, string> = {}
  const re = new RegExp(`\\b(?:${GRADLE_CONFIGS})\\s*\\(?\\s*(['"])([^'"]+)\\1`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const coord = m[2] ?? ''
    const parts = coord.split(':')
    if (parts.length < 2 || !parts[0] || !parts[1]) continue
    const key = `${parts[0]}:${parts[1]}`
    dependencies[key] = parts.slice(2).join(':')
  }
  return { dependencies }
}

export async function discoverJavaService(
  scanPath: string,
  dir: string,
): Promise<DiscoveredService | null> {
  // Maven wins on a mixed dir (a `pom.xml` next to a `build.gradle` is a Maven
  // project with a Gradle wrapper checked in), then Gradle Groovy, then Kotlin DSL.
  const pomPath = path.join(dir, 'pom.xml')
  const gradlePath = path.join(dir, 'build.gradle')
  const gradleKtsPath = path.join(dir, 'build.gradle.kts')

  let manifest: JavaManifest | null = null
  if (await exists(pomPath)) {
    manifest = parsePomXml(await fs.readFile(pomPath, 'utf8').catch(() => ''))
  } else if (await exists(gradlePath)) {
    manifest = parseGradle(await fs.readFile(gradlePath, 'utf8').catch(() => ''))
  } else if (await exists(gradleKtsPath)) {
    manifest = parseGradle(await fs.readFile(gradleKtsPath, 'utf8').catch(() => ''))
  }
  if (!manifest) return null

  // The Maven `<artifactId>` names the service; a Gradle build has no name here, so
  // it takes the directory basename the Go/Ruby/PHP readers use for name-less
  // manifests.
  const name = manifest.name?.trim() || path.basename(dir)
  const dependencies = manifest.dependencies

  const pkg: PackageJson = { name, dependencies }
  const node: ServiceNode = {
    id: serviceId(name),
    type: NodeType.ServiceNode,
    name,
    language: 'java',
    dependencies,
    repoPath: path.relative(scanPath, dir),
  }
  return { pkg, dir, node }
}

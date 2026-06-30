import path from 'node:path'
import type {
  CompatibleDriver,
  ConfigNode,
  DatabaseNode,
  GraphEdge,
  GraphNode,
  ServiceNode,
} from '@neat.is/types'
import {
  EdgeType,
  NodeType,
  Provenance,
  configId,
  databaseId,
  confidenceForExtracted,
} from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import {
  checkCompatibility,
  checkDeprecatedApi,
  checkNodeEngineConstraint,
  checkPackageConflict,
  compatPairs,
  deprecatedApis,
  nodeEngineConstraints,
  packageConflicts,
} from '../../compat.js'
import {
  cleanVersion,
  isConfigFile,
  makeEdgeId,
  type DiscoveredService,
} from '../shared.js'
import { ensureFileNode, toPosix } from '../calls/shared.js'
import { dbConfigYamlParser } from './db-config-yaml.js'
import { dotenvParser } from './dotenv.js'
import { prismaParser } from './prisma.js'
import { drizzleParser } from './drizzle.js'
import { knexParser } from './knex.js'
import { ormconfigParser } from './ormconfig.js'
import { typeormParser } from './typeorm.js'
import { sequelizeParser } from './sequelize.js'
import { dockerComposeParser } from './docker-compose.js'
import type { DbConfig } from './shared.js'

export type { DbConfig } from './shared.js'

export interface DbParser {
  name: string
  parse(serviceDir: string): Promise<DbConfig[]>
}

// Registry — order is for tie-breaking only (first wins on identical host).
// db-config.yaml stays first so the canonical demo behaviour matches today's
// extraction byte-for-byte.
export const DB_PARSERS: DbParser[] = [
  dbConfigYamlParser,
  dotenvParser,
  prismaParser,
  drizzleParser,
  knexParser,
  ormconfigParser,
  typeormParser,
  sequelizeParser,
  dockerComposeParser,
]

function compatibleDriversFor(engine: string): CompatibleDriver[] {
  return compatPairs()
    .filter((p) => p.engine === engine)
    .map((p) => ({ name: p.driver, minVersion: p.minDriverVersion }))
}

function toDatabaseNode(config: DbConfig): DatabaseNode {
  return {
    id: databaseId(config.host),
    type: NodeType.DatabaseNode,
    name: config.database || config.host,
    engine: config.engine,
    engineVersion: config.engineVersion,
    compatibleDrivers: compatibleDriversFor(config.engine),
    host: config.host,
    port: config.port,
  }
}

export function attachIncompatibilities(
  service: DiscoveredService,
  configs: DbConfig[],
): void {
  const deps = { ...(service.pkg.dependencies ?? {}), ...(service.pkg.devDependencies ?? {}) }
  const incompatibilities: NonNullable<ServiceNode['incompatibilities']> = []
  const seen = new Set<string>()

  // 1. driver-engine — original behaviour. Per (db config, configured driver
  // pair) check that the declared driver version meets the engine threshold.
  for (const config of configs) {
    for (const pair of compatPairs()) {
      if (pair.engine !== config.engine) continue
      const declaredVersion = cleanVersion(deps[pair.driver])
      if (!declaredVersion) continue
      const result = checkCompatibility(
        pair.driver,
        declaredVersion,
        config.engine,
        config.engineVersion,
      )
      if (!result.compatible && result.reason) {
        const key = `driver-engine|${pair.driver}@${declaredVersion}|${config.engine}@${config.engineVersion}`
        if (seen.has(key)) continue
        seen.add(key)
        incompatibilities.push({
          kind: 'driver-engine',
          driver: pair.driver,
          driverVersion: declaredVersion,
          engine: config.engine,
          engineVersion: config.engineVersion,
          reason: result.reason,
        })
      }
    }
  }

  // 2. node-engine — service's `engines.node` vs each declared dep that has a
  // matrix-recorded minimum.
  const serviceNodeEngine = service.node.nodeEngine ?? service.pkg.engines?.node
  for (const constraint of nodeEngineConstraints()) {
    const declared = cleanVersion(deps[constraint.package])
    if (!declared) continue
    const result = checkNodeEngineConstraint(constraint, declared, serviceNodeEngine)
    if (!result.compatible && result.reason) {
      const key = `node-engine|${constraint.package}@${declared}|${serviceNodeEngine ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      incompatibilities.push({
        kind: 'node-engine',
        package: constraint.package,
        packageVersion: declared,
        requiredNodeVersion: result.requiredNodeVersion ?? constraint.minNodeVersion,
        ...(serviceNodeEngine ? { declaredNodeEngine: serviceNodeEngine } : {}),
        reason: result.reason,
      })
    }
  }

  // 3. package-conflict — pair like react-query 5+ requiring react 18+.
  for (const conflict of packageConflicts()) {
    const declared = cleanVersion(deps[conflict.package])
    if (!declared) continue
    const requiredVersion = cleanVersion(deps[conflict.requires.name])
    const result = checkPackageConflict(conflict, declared, requiredVersion)
    if (!result.compatible && result.reason) {
      const key = `package-conflict|${conflict.package}@${declared}|${conflict.requires.name}@${requiredVersion ?? 'missing'}`
      if (seen.has(key)) continue
      seen.add(key)
      incompatibilities.push({
        kind: 'package-conflict',
        package: conflict.package,
        packageVersion: declared,
        requires: conflict.requires,
        ...(requiredVersion ? { foundVersion: requiredVersion } : {}),
        reason: result.reason,
      })
    }
  }

  // 4. deprecated-api — flag presence of a known-deprecated package.
  for (const rule of deprecatedApis()) {
    const declared = cleanVersion(deps[rule.package])
    if (declared === undefined) continue
    const result = checkDeprecatedApi(rule, declared)
    if (!result.compatible && result.reason) {
      const key = `deprecated-api|${rule.package}@${declared}`
      if (seen.has(key)) continue
      seen.add(key)
      incompatibilities.push({
        kind: 'deprecated-api',
        package: rule.package,
        packageVersion: declared,
        reason: result.reason,
      })
    }
  }

  if (incompatibilities.length > 0) service.node.incompatibilities = incompatibilities
}

// Phase 2 — for each service, run every parser and merge their DbConfigs by
// host. Each unique host produces one DatabaseNode + CONNECTS_TO edge from the
// service. The parser registry decides priority on tie; the demo's
// db-config.yaml stays first so its `engineVersion: 15` continues to win.
export async function addDatabasesAndCompat(
  graph: NeatGraph,
  services: DiscoveredService[],
  scanPath: string,
): Promise<{ nodesAdded: number; edgesAdded: number }> {
  let nodesAdded = 0
  let edgesAdded = 0

  for (const service of services) {
    const merged = new Map<string, DbConfig>()
    for (const parser of DB_PARSERS) {
      let configs: DbConfig[]
      try {
        configs = await parser.parse(service.dir)
      } catch (err) {
        console.warn(
          `[neat] ${parser.name} parser failed on ${service.node.name}: ${(err as Error).message}`,
        )
        continue
      }
      for (const config of configs) {
        if (!config.host) continue
        if (!merged.has(config.host)) merged.set(config.host, config)
      }
    }

    const allConfigs = [...merged.values()]
    for (const config of allConfigs) {
      const dbNode = toDatabaseNode(config)
      if (!graph.hasNode(dbNode.id)) {
        graph.addNode(dbNode.id, { ...dbNode, discoveredVia: 'static' })
        nodesAdded++
      } else {
        // OTel ingest may have auto-created a minimal node at this id. Merge
        // per ADR-033: static fields override OTel-derived fields, discoveredVia
        // flips to 'merged' when both layers contributed.
        const existing = graph.getNodeAttributes(dbNode.id) as DatabaseNode
        const mergedDiscoveredVia: 'static' | 'otel' | 'merged' =
          existing.discoveredVia === 'otel' ? 'merged' : 'static'
        graph.replaceNodeAttributes(dbNode.id, {
          ...existing,
          ...dbNode,
          discoveredVia: mergedDiscoveredVia,
        })
      }
      // file-awareness §1 — the connection is declared in a config file; that
      // file is the relationship origin. ensureFileNode creates the FileNode +
      // CONTAINS edge so the CONNECTS_TO lands file-grained, not service-level.
      const relConfigFile = toPosix(path.relative(service.dir, config.sourceFile))
      const { fileNodeId, nodesAdded: fn, edgesAdded: fe } = ensureFileNode(
        graph,
        service.pkg.name,
        service.node.id,
        relConfigFile,
      )
      nodesAdded += fn
      edgesAdded += fe
      const evidenceFile = toPosix(path.relative(scanPath, config.sourceFile))
      const edge: GraphEdge = {
        id: makeEdgeId(fileNodeId, dbNode.id, EdgeType.CONNECTS_TO),
        source: fileNodeId,
        target: dbNode.id,
        type: EdgeType.CONNECTS_TO,
        provenance: Provenance.EXTRACTED,
        confidence: confidenceForExtracted('structural'),
        evidence: { file: evidenceFile },
      }
      if (!graph.hasEdge(edge.id)) {
        graph.addEdgeWithKey(edge.id, edge.source, edge.target, edge)
        edgesAdded++
      }
    }

    // Service-level declared DB target. When a service declares exactly one DB
    // connection in config — a `postgres://…` string in .env, a db-config.yaml,
    // a prisma/drizzle/knex datasource — record where it's pointed on the
    // ServiceNode as `dbConnectionTarget` (host[:port]) and link the service to
    // the config that declared it with an EXTRACTED CONFIGURED_BY edge. This is
    // the service-grained declared intent the host-mismatch divergence compares
    // against the service-grained OBSERVED CONNECTS_TO (file-awareness §7 —
    // compare at the shared grain; a DB OTel span carries no call site, so the
    // comparison is service-level). Without this, `declaredHostFor` reads an
    // unpopulated field and host-mismatch never fires.
    //
    // We hold to a *single* declared target: with two or more distinct hosts
    // the single-target model is ambiguous and would flag every observed host
    // but one as a false mismatch, so we decline rather than guess.
    if (allConfigs.length === 1) {
      const primary = allConfigs[0]!
      service.node.dbConnectionTarget = primary.port
        ? `${primary.host}:${primary.port}`
        : primary.host

      // Link to the config file that declared the connection. Mirror configs.ts's
      // ConfigNode id (Phase 3 runs after this and is idempotent on the node);
      // the CONFIGURED_BY edge is service-grained here, matching the grain of
      // the declared target it backs.
      const relPath = path.relative(scanPath, primary.sourceFile)
      const cfgId = configId(relPath)
      if (!graph.hasNode(cfgId)) {
        const cfgNode: ConfigNode = {
          id: cfgId,
          type: NodeType.ConfigNode,
          name: path.basename(primary.sourceFile),
          path: relPath,
          fileType: isConfigFile(path.basename(primary.sourceFile)).fileType || 'config',
        }
        graph.addNode(cfgId, cfgNode)
        nodesAdded++
      }
      const cfgEdge: GraphEdge = {
        id: makeEdgeId(service.node.id, cfgId, EdgeType.CONFIGURED_BY),
        source: service.node.id,
        target: cfgId,
        type: EdgeType.CONFIGURED_BY,
        provenance: Provenance.EXTRACTED,
        confidence: confidenceForExtracted('structural'),
        evidence: { file: toPosix(relPath) },
      }
      if (!graph.hasEdge(cfgEdge.id)) {
        graph.addEdgeWithKey(cfgEdge.id, cfgEdge.source, cfgEdge.target, cfgEdge)
        edgesAdded++
      }
    }

    // Run all kinds of incompat checks even for services with no db connection
    // — node-engine / package-conflict / deprecated-api don't depend on db.
    attachIncompatibilities(service, allConfigs)
    if (graph.hasNode(service.node.id)) {
      // Merge with whatever's on the node already (aliases from γ #75 land
      // before this phase), so the writeback doesn't drop fields populated by
      // earlier passes.
      const current = graph.getNodeAttributes(service.node.id) as ServiceNode
      const updated: ServiceNode = {
        ...current,
        ...(service.node as ServiceNode),
        ...(current.aliases ? { aliases: current.aliases } : {}),
      }
      // attachIncompatibilities only sets the field when there's something to
      // flag. On a re-extract (`neat watch`, `POST /graph/scan`), a stale
      // entry on `current` would otherwise survive the spread and leave the
      // graph reporting a problem the new manifest no longer has.
      if (!service.node.incompatibilities || service.node.incompatibilities.length === 0) {
        delete (updated as { incompatibilities?: unknown }).incompatibilities
      }
      // Same stale-survivor guard for the declared DB target: if this pass found
      // no single declared connection, a value left on `current` from a prior
      // extract would otherwise survive the spread.
      if (!service.node.dbConnectionTarget) {
        delete (updated as { dbConnectionTarget?: unknown }).dbConnectionTarget
      }
      graph.replaceNodeAttributes(service.node.id, updated as unknown as GraphNode)
    }
  }

  return { nodesAdded, edgesAdded }
}

import { z } from 'zod'
import { NodeType } from './constants.js'

export const CompatibleDriverSchema = z.object({
  name: z.string(),
  minVersion: z.string(),
})
export type CompatibleDriver = z.infer<typeof CompatibleDriverSchema>

// How NEAT first learned of a node. Static-extraction fills in the rich
// fields (language, version, dependencies); OTel ingest can also create a
// minimal node when it sees a span for an unknown peer. When both layers
// recorded the same node, the value is 'merged'. ADR-031 schema growth.
export const DiscoveredViaSchema = z.enum(['static', 'otel', 'merged'])
export type DiscoveredVia = z.infer<typeof DiscoveredViaSchema>

export const ServiceNodeSchema = z.object({
  id: z.string(),
  type: z.literal(NodeType.ServiceNode),
  name: z.string(),
  language: z.string(),
  // Deployment environment from the OTel `deployment.environment.name` attr
  // (with `deployment.environment` and resource-attr fallbacks). The literal
  // `'unknown'` is the honest sentinel when no env signal is present; static
  // extraction never sees env at extract time, so its ServiceNodes carry
  // `undefined` here and the id stays in the env-less wire format
  // `service:<name>`. See ADR-074 §2 and docs/contracts/env-dimension.md.
  env: z.string().optional(),
  // Framework recorded by the static extractor when the install plan
  // dispatches a framework-specific path (Next.js, Remix, SvelteKit, Nuxt,
  // Astro). Optional enrichment — `undefined` for lib-only packages and
  // ambiguous repos. See ADR-074 §3 / docs/contracts/framework-installers.md.
  framework: z.string().optional(),
  discoveredVia: DiscoveredViaSchema.optional(),
  version: z.string().optional(),
  dbConnectionTarget: z.string().optional(),
  repoPath: z.string().optional(),
  owner: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  // Hostnames OTel spans might mention for this service: compose service
  // names, k8s metadata.name (and the cluster-DNS variants), Dockerfile
  // labels, etc. resolveServiceId in ingest.ts checks these before falling
  // back to a FRONTIER placeholder.
  aliases: z.array(z.string()).optional(),
  // Optional. If set, services declare their `engines.node` here so γ #74's
  // node-engine compat check has something to test against.
  nodeEngine: z.string().optional(),
  incompatibilities: z
    .array(
      // Discriminated by `kind`. `driver-engine` is the original shape and
      // stays default for backward compatibility — older snapshots without a
      // `kind` field still parse via the union's `.optional()` discriminator
      // fallback. New kinds came in with γ #74.
      z.union([
        z.object({
          kind: z.literal('driver-engine').optional(),
          driver: z.string(),
          driverVersion: z.string(),
          engine: z.string(),
          engineVersion: z.string(),
          reason: z.string(),
        }),
        z.object({
          kind: z.literal('node-engine'),
          package: z.string(),
          packageVersion: z.string().optional(),
          requiredNodeVersion: z.string(),
          declaredNodeEngine: z.string().optional(),
          reason: z.string(),
        }),
        z.object({
          kind: z.literal('package-conflict'),
          package: z.string(),
          packageVersion: z.string().optional(),
          requires: z.object({
            name: z.string(),
            minVersion: z.string(),
          }),
          foundVersion: z.string().optional(),
          reason: z.string(),
        }),
        z.object({
          kind: z.literal('deprecated-api'),
          package: z.string(),
          packageVersion: z.string().optional(),
          reason: z.string(),
        }),
      ]),
    )
    .optional(),
})
export type ServiceNode = z.infer<typeof ServiceNodeSchema>

export const DatabaseNodeSchema = z.object({
  id: z.string(),
  type: z.literal(NodeType.DatabaseNode),
  name: z.string(),
  engine: z.string(),
  engineVersion: z.string(),
  compatibleDrivers: z.array(CompatibleDriverSchema),
  host: z.string().optional(),
  port: z.number().optional(),
  discoveredVia: DiscoveredViaSchema.optional(),
})
export type DatabaseNode = z.infer<typeof DatabaseNodeSchema>

export const ConfigNodeSchema = z.object({
  id: z.string(),
  type: z.literal(NodeType.ConfigNode),
  name: z.string(),
  path: z.string(),
  fileType: z.string(),
})
export type ConfigNode = z.infer<typeof ConfigNodeSchema>

export const InfraNodeSchema = z.object({
  id: z.string(),
  type: z.literal(NodeType.InfraNode),
  name: z.string(),
  provider: z.string(),
  region: z.string().optional(),
  kind: z.string().optional(),
})
export type InfraNode = z.infer<typeof InfraNodeSchema>

// Placeholder for a span peer the ingest layer couldn't resolve to a known
// ServiceNode. Lives at id `frontier:<host>` and gets replaced by the real
// service once a later extraction round records that host as an alias.
export const FrontierNodeSchema = z.object({
  id: z.string(),
  type: z.literal(NodeType.FrontierNode),
  name: z.string(),
  host: z.string(),
  firstObserved: z.string().datetime().optional(),
  lastObserved: z.string().datetime().optional(),
})
export type FrontierNode = z.infer<typeof FrontierNodeSchema>

// FileNode — the primary node of the file-first graph (ADR-089 /
// docs/contracts/file-awareness.md §1). A source file owned by a service,
// identified by `fileId(service, relPath)` → `file:<service>:<relPath>`. The
// `service` segment scopes the relative path so the same `src/index.ts` across
// two monorepo packages stays distinct. `path` is the service-relative path
// with forward slashes; `language` is the optional extension-derived tag
// (js/ts/py) and stays absent when the discoverer can't name it honestly.
export const FileNodeSchema = z.object({
  id: z.string(),
  type: z.literal(NodeType.FileNode),
  service: z.string(),
  path: z.string(),
  language: z.string().optional(),
  discoveredVia: DiscoveredViaSchema.optional(),
})
export type FileNode = z.infer<typeof FileNodeSchema>

export const GraphNodeSchema = z.discriminatedUnion('type', [
  ServiceNodeSchema,
  DatabaseNodeSchema,
  ConfigNodeSchema,
  InfraNodeSchema,
  FrontierNodeSchema,
  FileNodeSchema,
])
export type GraphNode = z.infer<typeof GraphNodeSchema>

import path from 'node:path'
import { DEFAULT_PROJECT, getGraph } from './graph.js'
import { buildApi } from './api.js'
import { extractFromDirectory } from './extract.js'
import { loadGraphFromDisk, startPersistLoop } from './persist.js'
import { buildOtelReceiver } from './otel.js'
import { registerOtelLogsRoutes } from './otel-logs.js'
import { appendLogEntry } from './logs-store.js'
import { startOtelGrpcReceiver } from './otel-grpc.js'
import { makeSpanHandler, startStalenessLoop } from './ingest.js'
import { buildSearchIndex } from './search.js'
import { Projects, parseExtraProjects, pathsForProject } from './projects.js'
import { assertBindAuthority, readAuthEnv } from './auth.js'

async function bootProject(
  registry: Projects,
  name: string,
  scanPath: string | undefined,
  baseDir: string,
): Promise<void> {
  const paths = pathsForProject(name, baseDir)
  const graph = getGraph(name)
  await loadGraphFromDisk(graph, paths.snapshotPath)

  if (scanPath) {
    const r = await extractFromDirectory(graph, scanPath)
    console.log(
      `[${name}] extract: ${r.nodesAdded} new nodes, ${r.edgesAdded} new edges (graph total ${graph.order}/${graph.size})`,
    )
  } else {
    console.log(`[${name}] loaded ${graph.order} nodes / ${graph.size} edges from snapshot`)
  }

  startPersistLoop(graph, paths.snapshotPath)
  startStalenessLoop(graph, { staleEventsPath: paths.staleEventsPath })

  const searchIndex = await buildSearchIndex(graph, {
    cachePath: paths.embeddingsCachePath,
  }).catch((err) => {
    console.warn(
      `[${name}] semantic_search: index build failed (${(err as Error).message}); falling back to inline substring`,
    )
    return undefined
  })
  if (searchIndex) {
    console.log(`[${name}] semantic_search: ${searchIndex.provider} provider`)
  }

  registry.set(name, {
    scanPath,
    paths,
    searchIndex,
  })
}

async function main(): Promise<void> {
  const baseDirEnv = process.env.NEAT_OUT_DIR
  const legacyOutPath = process.env.NEAT_OUT_PATH
  const baseDir = baseDirEnv
    ? path.resolve(baseDirEnv)
    : legacyOutPath
      ? path.resolve(path.dirname(legacyOutPath))
      : path.resolve('./neat-out')

  const defaultScanPath = path.resolve(process.env.NEAT_SCAN_PATH ?? './demo')
  const registry = new Projects()

  // Default project always exists. NEAT_SCAN_PATH still wires it to a scan
  // root so existing single-project users see no behaviour change.
  await bootProject(registry, DEFAULT_PROJECT, defaultScanPath, baseDir)

  // Extra projects come from NEAT_PROJECTS=a,b,c. Their snapshots load from
  // <baseDir>/<name>.json; they have no scan path by default (callers can
  // POST /projects/<name>/graph/scan after wiring NEAT_PROJECT_SCAN_PATH_<NAME>).
  for (const name of parseExtraProjects(process.env.NEAT_PROJECTS)) {
    const envKey = `NEAT_PROJECT_SCAN_PATH_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
    const projectScan = process.env[envKey]
    await bootProject(registry, name, projectScan ? path.resolve(projectScan) : undefined, baseDir)
  }

  const host = process.env.HOST ?? '0.0.0.0'
  const port = Number(process.env.PORT ?? 8080)
  const otelPort = Number(process.env.OTEL_PORT ?? 4318)

  // ADR-073 §3 — refuse to bind a public address without a token.
  const auth = readAuthEnv()
  assertBindAuthority(host, auth.authToken)

  const app = await buildApi({
    projects: registry,
    authToken: auth.authToken,
    trustProxy: auth.trustProxy,
    publicRead: auth.publicRead,
  })
  await app.listen({ port, host })
  console.log(`neat-core listening on http://${host}:${port}`)
  console.log(`  base dir:      ${baseDir}`)
  console.log(`  projects:      ${registry.list().join(', ')}`)

  // OTel ingest stays single-project for now: spans always land in the
  // default project's graph + errors log. Multi-project routing for spans
  // is a future concern (would need a header / resource attr).
  const defaultCtx = registry.get(DEFAULT_PROJECT)
  if (defaultCtx) {
    const onSpan = makeSpanHandler({
      graph: defaultCtx.graph,
      errorsPath: defaultCtx.paths.errorsPath,
    })
    const otelApp = await buildOtelReceiver({
      onSpan,
      authToken: auth.otelToken,
      trustProxy: auth.trustProxy,
    })
    // /v1/logs (ADR-132) — single-project mode has no routing ambiguity, so
    // every record lands in DEFAULT_PROJECT directly. Never touches the
    // graph; only appendLogEntry (logs-store.ts).
    registerOtelLogsRoutes(otelApp, {
      onLogRecord: (record) => {
        appendLogEntry({
          id: record.id,
          projectName: DEFAULT_PROJECT,
          source: 'native',
          serviceName: record.serviceName,
          timestamp: record.timestamp,
          severity: record.severity,
          message: record.message,
          attributes:
            Object.keys(record.attributes).length > 0 ? record.attributes : undefined,
        })
      },
    })
    await otelApp.listen({ port: otelPort, host })
    console.log(`neat-core OTLP receiver on http://${host}:${otelPort}/v1/traces`)

    if (process.env.NEAT_OTLP_GRPC === 'true') {
      const grpcPort = Number(process.env.NEAT_OTLP_GRPC_PORT ?? 4317)
      const grpcReceiver = await startOtelGrpcReceiver({
        onSpan,
        host,
        port: grpcPort,
        authToken: auth.otelToken,
        trustProxy: auth.trustProxy,
      })
      console.log(`neat-core OTLP/gRPC receiver on ${grpcReceiver.address}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

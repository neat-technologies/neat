import { EdgeType } from '@neat.is/types'
import { knownDatastoreEngine } from '../extract/infra/shared.js'
import type { SpanIngest } from './context.js'
import { ensureObservedFileNode, reconcileObservedRelPath } from './call-site.js'
import { ensureDatabaseNode } from './database.js'
import { upsertObservedEdge } from './edges.js'
import { ensureGrpcMethodNode } from './serving.js'
import {
  ensureFrontierNode,
  ensureServiceNode,
  lookupParentSpan,
  resolveServiceId,
  serviceIdForObservedAddress,
} from './service.js'
import { calleeAddress, isLoopbackHost } from './span.js'

// Every span the typed branches in handleSpan did not claim: a cross-service call,
// an opentracing datastore client, a gRPC client call, or a callee resolved from
// its parent span.
export function ingestPeerSpan(s: SpanIngest): string | undefined {
  const {
    ctx,
    span,
    ts,
    nowMs,
    env,
    sourceId,
    isError,
    durationMs,
    errorDetail,
    callSiteEvidence,
    observedSource,
    mintsFromCallerSide,
  } = s
  let affectedNode: string | undefined
  // Possibly a cross-service call. Resolve the peer; if it matches a known
  // ServiceNode, record an OBSERVED CALLS edge to the typed target. If it
  // matches nothing — pod IP, ingress hostname, AWS PrivateLink endpoint —
  // create a FrontierNode placeholder and record an OBSERVED edge to that
  // FrontierNode so the call carries the same provenance + signal-block +
  // graded confidence as any other OBSERVED edge (ADR-068). The target ref
  // identifies the node-type; provenance describes how the edge was learned.
  // promoteFrontierNodes (run by the extract orchestrator) rewrites the
  // target ref once a later round resolves the host; the edge's provenance
  // stays OBSERVED across promotion.
  // A loopback host (localhost / 127.0.0.0/8 / ::1) is skipped here: it never
  // resolves to a distinct peer, and minting frontier:localhost would double
  // the edge that the callee's parent-span fallback already records for this
  // same call (issues #590, #577). Leaving resolvedViaAddress false hands the
  // call to that fallback instead.
  const host = calleeAddress(span)
  let resolvedViaAddress = false

  // An opentracing datastore client (#1415). A Jaeger-converted datastore span
  // carries no `db.system` — it names the engine in `peer.service` and the host in
  // `peer.hostname` (DeathStarBench `memcached_get_profile`: peer.service=memcached,
  // peer.hostname=memcached-profile). The OTel-native db branch above never fires on
  // it, so resolve it the same way that branch does — a DatabaseNode keyed on the
  // host, engine from `peer.service`, `CONNECTS_TO` — fusing onto the datastore node
  // an OTel-native span would land on. Gated on `peer.service` naming an engine NEAT
  // already recognizes (`knownDatastoreEngine`, the one list `classifyImage` reads),
  // so a `peer.service` that is a service name mints nothing rather than a bogus
  // DatabaseNode; a genuine service-name peer tier stays an unclaimed slot
  // (otel-ingest §peer). Caller-side only, matching the db branch.
  const datastoreEngine = mintsFromCallerSide
    ? knownDatastoreEngine(span.peerService)
    : undefined
  if (datastoreEngine && span.peerHostname) {
    const datastoreId = ensureDatabaseNode(ctx.graph, span.peerHostname, datastoreEngine)
    upsertObservedEdge(
      ctx.graph,
      EdgeType.CONNECTS_TO,
      observedSource(),
      datastoreId,
      ts,
      isError,
      callSiteEvidence,
      durationMs,
      errorDetail,
    )
    affectedNode = datastoreId
    resolvedViaAddress = true
  }

  // Callee resolution is additive across grains, the way the db branch above mints
  // a mongodb-collection / sql-table CALLS alongside the datastore edge, not instead
  // of it:
  //   • gRPC method (#1413) — a CLIENT span names the method it invoked via
  //     `rpc.service` (the fully-qualified FQN) + `rpc.method`, the same pair the
  //     serving branch (#616) and the static `.proto` key their `grpc:<service>/<method>`
  //     node on. Mint an OBSERVED `CALLS` onto it — the invocation dual of the serving
  //     side's `CONTAINS` ownership — a method-grain callee finer than the peer service.
  //   • peer host — `server.address` / `net.peer.name` / url → ServiceNode, else a
  //     bare-host FrontierNode. [#1415 peer.service/peer.hostname and #1411 ClusterIP→
  //     ServiceNode via the k8s connector extend this host tier.]
  // Both edges are minted, so the service→service reachability the host tier records
  // is preserved. The one interaction: when the method node already captured the
  // callee, an in-cluster ClusterIP on `server.address` needs no FrontierNode — the
  // method node (owned by the serving service through its #616 / `.proto` CONTAINS
  // edge) is the better-resolved callee, so caller→method→owner reaches it where an IP
  // placeholder never would.
  let grpcMethodNodeId: string | undefined
  if (
    mintsFromCallerSide &&
    span.rpcSystem === 'grpc' &&
    span.rpcService &&
    span.rpcMethod
  ) {
    grpcMethodNodeId = ensureGrpcMethodNode(ctx.graph, span.rpcService, span.rpcMethod)
    upsertObservedEdge(
      ctx.graph,
      EdgeType.CALLS,
      observedSource(),
      grpcMethodNodeId,
      ts,
      isError,
      callSiteEvidence,
      durationMs,
      errorDetail,
    )
    affectedNode = grpcMethodNodeId
    resolvedViaAddress = true
  }

  if (mintsFromCallerSide && host && host !== span.service && !isLoopbackHost(host)) {
    const targetId =
      resolveServiceId(ctx.graph, host, env) ?? serviceIdForObservedAddress(ctx.graph, host)
    if (targetId && targetId !== sourceId) {
      upsertObservedEdge(
        ctx.graph,
        EdgeType.CALLS,
        observedSource(),
        targetId,
        ts,
        isError,
        callSiteEvidence,
        durationMs,
        errorDetail,
      )
      affectedNode = targetId
      resolvedViaAddress = true
    } else if (!targetId && !grpcMethodNodeId) {
      // No gRPC method node captured this callee, so a bare host (pod IP, ingress
      // hostname, a ClusterIP) still mints a FrontierNode placeholder (ADR-068).
      const frontierNodeId = ensureFrontierNode(ctx.graph, host, ts)
      upsertObservedEdge(
        ctx.graph,
        EdgeType.CALLS,
        observedSource(),
        frontierNodeId,
        ts,
        isError,
        callSiteEvidence,
        durationMs,
        errorDetail,
      )
      affectedNode = frontierNodeId
      resolvedViaAddress = true
    }
  }

  // Parent-span fallback (ADR-033): when address-based resolution didn't
  // produce an edge and the span has a parentSpanId we've cached, the
  // parent's service identifies the caller. The current span is the server
  // side of the call, so the edge direction is parent.service → current.
  // The cached entry carries the parent span's env, so the auto-created
  // parent ServiceNode lands on the env-tagged id the parent advertised.
  if (!resolvedViaAddress && span.parentSpanId) {
    const parent = lookupParentSpan(span.traceId, span.parentSpanId, nowMs)
    if (parent && parent.service !== span.service) {
      const parentId = ensureServiceNode(ctx.graph, parent.service, parent.env)
      // When the parent span carried a `code.*` call site, originate the edge
      // from the parent's FileNode so it anchors to file:line instead of the
      // bare parent ServiceNode (issue #536). Without a cached call site the
      // edge stays service-coarse — never fabricated (file-awareness.md §6).
      const fallbackSource = parent.callSite
        ? ensureObservedFileNode(ctx.graph, parent.service, parentId, parent.callSite)
        : parentId
      const fallbackEvidence: { file: string; line?: number } | undefined =
        parent.callSite
          ? {
              file: reconcileObservedRelPath(
                ctx.graph,
                parent.service,
                parent.callSite.relPath,
              ),
              ...(parent.callSite.line !== undefined
                ? { line: parent.callSite.line }
                : {}),
            }
          : undefined
      upsertObservedEdge(
        ctx.graph,
        EdgeType.CALLS,
        fallbackSource,
        sourceId,
        ts,
        isError,
        fallbackEvidence,
        durationMs,
        errorDetail,
      )
    }
  }
  return affectedNode
}

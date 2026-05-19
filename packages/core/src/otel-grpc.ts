import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import {
  parseOtlpRequest,
  type OtlpTracesRequest,
  type ParsedSpan,
  type SpanHandler,
} from './otel.js'

// OTLP/gRPC receiver. Sits next to buildOtelReceiver (HTTP/JSON) in otel.ts;
// shares the same parseOtlpRequest decoder so a span looks identical to the
// downstream onSpan handler whether it came in over JSON or protobuf.
//
// Default OFF — opts.enabled (typically NEAT_OTLP_GRPC=true) decides whether
// server.ts wires this up. We keep gRPC behind a flag so existing HTTP-only
// deployments don't get a surprise port binding on upgrade.

export interface BuildOtelGrpcReceiverOptions {
  onSpan: SpanHandler
  // ADR-073 §4 — bearer required in the gRPC call's `authorization` metadata
  // when set. Same precedence as the HTTP receiver: NEAT_OTEL_TOKEN ?? NEAT_AUTH_TOKEN.
  authToken?: string
  // Skip the request-side check when an upstream proxy already authenticated.
  trustProxy?: boolean
}

// proto-loader output for the trace service has fields like resource_spans,
// scope_spans, span_id, etc. (snake_case keys, since we leave keepCase: true
// when loading). The HTTP path uses camelCase JSON, so we shape-shift the
// gRPC payload onto the HTTP shape and let parseOtlpRequest do the rest.
//
// All `bytes` fields arrive as Buffers; the HTTP wire format encodes them as
// hex strings, so we hex-encode for consistency.

interface GrpcAnyValue {
  string_value?: string
  bool_value?: boolean
  int_value?: string | number
  double_value?: number
  array_value?: { values?: GrpcAnyValue[] }
  // bytes/kvlist fields exist in the proto but the demo doesn't use them.
}

interface GrpcKeyValue {
  key?: string
  value?: GrpcAnyValue
}

interface GrpcStatus {
  code?: number
  message?: string
}

interface GrpcEvent {
  name?: string
  time_unix_nano?: string | number
  attributes?: GrpcKeyValue[]
}

interface GrpcSpan {
  trace_id?: Buffer
  span_id?: Buffer
  parent_span_id?: Buffer
  name?: string
  kind?: number
  start_time_unix_nano?: string | number
  end_time_unix_nano?: string | number
  attributes?: GrpcKeyValue[]
  events?: GrpcEvent[]
  status?: GrpcStatus
}

interface GrpcScopeSpans {
  spans?: GrpcSpan[]
}

interface GrpcResourceSpans {
  resource?: { attributes?: GrpcKeyValue[] }
  scope_spans?: GrpcScopeSpans[]
}

interface GrpcExportRequest {
  resource_spans?: GrpcResourceSpans[]
}

function bytesToHex(buf: Buffer | undefined): string {
  if (!buf) return ''
  return Buffer.isBuffer(buf) ? buf.toString('hex') : ''
}

function nanosToString(n: string | number | undefined): string {
  if (n === undefined || n === null) return '0'
  return typeof n === 'string' ? n : String(n)
}

function reshapeAttributes(
  attrs: GrpcKeyValue[] | undefined,
): OtlpTracesRequest['resourceSpans'] extends Array<infer R>
  ? R extends { resource?: { attributes?: infer A } }
    ? A
    : never
  : never {
  // Map snake_case oneof fields to the camelCase the JSON path expects.
  const out = (attrs ?? []).map((kv) => ({
    key: kv.key ?? '',
    value: kv.value
      ? {
          stringValue: kv.value.string_value,
          boolValue: kv.value.bool_value,
          intValue: kv.value.int_value,
          doubleValue: kv.value.double_value,
          arrayValue: kv.value.array_value
            ? {
                values: (kv.value.array_value.values ?? []).map((v) => ({
                  stringValue: v.string_value,
                  boolValue: v.bool_value,
                  intValue: v.int_value,
                  doubleValue: v.double_value,
                })),
              }
            : undefined,
        }
      : undefined,
  }))
  return out as never
}

export function reshapeGrpcRequest(req: GrpcExportRequest): OtlpTracesRequest {
  return {
    resourceSpans: (req.resource_spans ?? []).map((rs) => ({
      resource: rs.resource ? { attributes: reshapeAttributes(rs.resource.attributes) } : undefined,
      scopeSpans: (rs.scope_spans ?? []).map((ss) => ({
        spans: (ss.spans ?? []).map((s) => ({
          traceId: bytesToHex(s.trace_id),
          spanId: bytesToHex(s.span_id),
          parentSpanId: s.parent_span_id ? bytesToHex(s.parent_span_id) : undefined,
          name: s.name,
          kind: s.kind,
          startTimeUnixNano: nanosToString(s.start_time_unix_nano),
          endTimeUnixNano: nanosToString(s.end_time_unix_nano),
          attributes: reshapeAttributes(s.attributes),
          events: (s.events ?? []).map((e) => ({
            name: e.name,
            timeUnixNano: nanosToString(e.time_unix_nano),
            attributes: reshapeAttributes(e.attributes),
          })),
          status: s.status ? { code: s.status.code, message: s.status.message } : undefined,
        })),
      })),
    })),
  }
}

// Find the bundled .proto tree at packages/core/proto/. The dev server runs
// from the source tree (tsx); the built bundles run from dist/. tsup keeps
// source layout, so __dirname-relative resolution works for both — we look two
// levels up from this file.
function resolveProtoRoot(): string {
  // Built output (CJS) sets __dirname natively; ESM build is bundled by tsup
  // and keeps a dirname injection. import.meta.url is the safe bet.
  const here = path.dirname(fileURLToPath(import.meta.url))
  // src/ → packages/core/proto/, dist/ → packages/core/proto/.
  return path.resolve(here, '..', 'proto')
}

function loadTraceService(): grpc.ServiceDefinition {
  const protoRoot = resolveProtoRoot()
  const def = protoLoader.loadSync(
    'opentelemetry/proto/collector/trace/v1/trace_service.proto',
    {
      keepCase: true,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
      includeDirs: [protoRoot],
    },
  )
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    opentelemetry: {
      proto: {
        collector: {
          trace: {
            v1: {
              TraceService: { service: grpc.ServiceDefinition }
            }
          }
        }
      }
    }
  }
  return pkg.opentelemetry.proto.collector.trace.v1.TraceService.service
}

export interface OtelGrpcReceiver {
  // Bound address (host:port) once .start() has resolved. Useful for tests.
  address: string
  // Stop accepting new requests, shut down the server.
  stop: () => Promise<void>
}

export async function startOtelGrpcReceiver(
  opts: BuildOtelGrpcReceiverOptions & { host?: string; port?: number },
): Promise<OtelGrpcReceiver> {
  const server = new grpc.Server()
  const service = loadTraceService()

  const requiresAuth = !opts.trustProxy && !!opts.authToken && opts.authToken.length > 0
  const expectedHeader = requiresAuth ? `Bearer ${opts.authToken}` : ''

  server.addService(service, {
    Export: (
      call: grpc.ServerUnaryCall<GrpcExportRequest, unknown>,
      callback: grpc.sendUnaryData<{ partial_success: object }>,
    ) => {
      // ADR-073 §4 — same bearer shape as the HTTP receiver, carried in the
      // `authorization` gRPC metadata header. Constant-time comparison.
      if (requiresAuth) {
        const meta = call.metadata.get('authorization')
        const got = meta.length > 0 ? String(meta[0]) : ''
        const a = Buffer.from(got, 'utf8')
        const b = Buffer.from(expectedHeader, 'utf8')
        const ok = a.length === b.length && timingSafeEqual(a, b)
        if (!ok) {
          callback({ code: grpc.status.UNAUTHENTICATED, message: 'unauthorized' })
          return
        }
      }
      void (async () => {
        try {
          const reshaped = reshapeGrpcRequest(call.request ?? {})
          const spans: ParsedSpan[] = parseOtlpRequest(reshaped)
          for (const span of spans) {
            await opts.onSpan(span)
          }
          callback(null, { partial_success: {} })
        } catch (err) {
          callback({
            code: grpc.status.INTERNAL,
            message: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    },
  })

  const host = opts.host ?? '0.0.0.0'
  const port = opts.port ?? 4317

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err, p) => {
      if (err) return reject(err)
      resolve(p)
    })
  })

  return {
    address: `${host}:${boundPort}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.tryShutdown(() => resolve())
      }),
  }
}

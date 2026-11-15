// OTLP trace wire shapes, plus the reshape that maps the gRPC/protobuf decode
// (snake_case keys, bytes as Buffers) onto the JSON shape parseOtlpRequest reads.
// A leaf module: otel.ts (HTTP receiver, protobuf body) and otel-grpc.ts (gRPC
// receiver) both import it, so neither has to import the other for the reshape.

export interface OtlpKeyValue {
  key: string
  value?: OtlpAnyValue
}

export interface OtlpAnyValue {
  stringValue?: string
  intValue?: string | number
  doubleValue?: number
  boolValue?: boolean
  arrayValue?: { values?: OtlpAnyValue[] }
  // kvlistValue / bytesValue are skipped — neither is on the demo path.
}

export interface OtlpStatus {
  code?: number
  message?: string
}

export interface OtlpEvent {
  name?: string
  timeUnixNano?: string
  attributes?: OtlpKeyValue[]
}

export interface OtlpSpan {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  name?: string
  kind?: number
  startTimeUnixNano?: string
  endTimeUnixNano?: string
  attributes?: OtlpKeyValue[]
  events?: OtlpEvent[]
  status?: OtlpStatus
}

export interface OtlpScopeSpans {
  spans?: OtlpSpan[]
}

export interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] }
  scopeSpans?: OtlpScopeSpans[]
}

export interface OtlpTracesRequest {
  resourceSpans?: OtlpResourceSpans[]
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
  trace_id?: Buffer | Uint8Array
  span_id?: Buffer | Uint8Array
  parent_span_id?: Buffer | Uint8Array
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

export interface GrpcExportRequest {
  resource_spans?: GrpcResourceSpans[]
}

function bytesToHex(buf: Buffer | Uint8Array | undefined): string {
  if (!buf) return ''
  if (Buffer.isBuffer(buf)) return buf.toString('hex')
  // protobufjs hands back plain Uint8Arrays in environments where its Buffer
  // detection misses; hex-encode those too rather than silently emptying the
  // span's identity (#468 — empty traceId/spanId killed every protobuf span).
  if (buf instanceof Uint8Array) return Buffer.from(buf).toString('hex')
  return ''
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

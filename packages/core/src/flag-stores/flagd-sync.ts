import http2 from 'node:http2'
import type { FlagDefinition } from '@neat.is/types'
import { parseFlagDocument } from '../flags.js'

// flagd's sync service (ADR-242): `flagd.sync.v1.FlagSyncService/FetchAllFlags`,
// one unary gRPC call that returns every flag flagd is serving as a JSON document
// in `flag_configuration` (field 1). It describes the flags; it does not evaluate
// them, so a targeting change reads as the definition that changed rather than
// as whatever variant one caller's context happened to get. The service has no
// auth. Hand-rolled over Node's http2 because the whole exchange is one empty
// request and one string field: no gRPC or protobuf dependency.

const FETCH_ALL_PATH = '/flagd.sync.v1.FlagSyncService/FetchAllFlags'
const DEFAULT_TIMEOUT_MS = 5_000

// An empty FetchAllFlagsRequest, length-prefixed: uncompressed, zero bytes.
const EMPTY_REQUEST = Buffer.from([0, 0, 0, 0, 0])

function readVarint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  let i = at
  for (;;) {
    if (i >= buf.length) throw new Error('truncated varint')
    const b = buf[i++]!
    value += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return { value, next: i }
}

// FetchAllFlagsResponse → its `flag_configuration` string. Unknown fields are
// skipped by wire type, so a newer flagd that adds fields still decodes.
export function decodeFetchAllFlagsResponse(message: Buffer): string {
  let i = 0
  while (i < message.length) {
    const tag = readVarint(message, i)
    i = tag.next
    const field = Math.floor(tag.value / 8)
    const wire = tag.value & 7
    if (wire === 2) {
      const len = readVarint(message, i)
      const start = len.next
      const end = start + len.value
      if (end > message.length) throw new Error('truncated field')
      if (field === 1) return message.subarray(start, end).toString('utf8')
      i = end
    } else if (wire === 0) {
      i = readVarint(message, i).next
    } else if (wire === 1) {
      i += 8
    } else if (wire === 5) {
      i += 4
    } else {
      throw new Error(`unsupported wire type ${wire}`)
    }
  }
  throw new Error('no flag_configuration in response')
}

// One gRPC response body (possibly several length-prefixed frames) → the first
// message's bytes.
function firstMessage(body: Buffer): Buffer {
  if (body.length < 5) throw new Error('empty gRPC response')
  if (body[0] !== 0) throw new Error('compressed gRPC response not supported')
  const len = body.readUInt32BE(1)
  if (5 + len > body.length) throw new Error('truncated gRPC message')
  return body.subarray(5, 5 + len)
}

// `host:port` (or a full http:// URL) → the definitions flagd is serving.
export async function fetchFlagdFlags(
  endpoint: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Map<string, FlagDefinition>> {
  const authority = /^https?:\/\//.test(endpoint) ? endpoint : `http://${endpoint}`
  const body = await new Promise<Buffer>((resolve, reject) => {
    const client = http2.connect(authority)
    const timer = setTimeout(() => {
      client.destroy()
      reject(new Error(`flagd sync at ${endpoint} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const fail = (err: Error): void => {
      clearTimeout(timer)
      client.destroy()
      reject(err)
    }
    client.on('error', fail)
    const req = client.request({
      ':method': 'POST',
      ':path': FETCH_ALL_PATH,
      'content-type': 'application/grpc',
      te: 'trailers',
    })
    const chunks: Buffer[] = []
    let grpcStatus: string | undefined
    let grpcMessage: string | undefined
    req.on('response', (headers) => {
      // A trailers-only error response carries the status in the headers.
      if (headers['grpc-status'] !== undefined) grpcStatus = String(headers['grpc-status'])
      if (headers['grpc-message'] !== undefined) grpcMessage = String(headers['grpc-message'])
    })
    req.on('trailers', (trailers) => {
      if (trailers['grpc-status'] !== undefined) grpcStatus = String(trailers['grpc-status'])
      if (trailers['grpc-message'] !== undefined) grpcMessage = String(trailers['grpc-message'])
    })
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('error', fail)
    req.on('end', () => {
      clearTimeout(timer)
      client.close()
      if (grpcStatus !== undefined && grpcStatus !== '0') {
        reject(new Error(`flagd sync returned grpc-status ${grpcStatus}${grpcMessage ? `: ${grpcMessage}` : ''}`))
        return
      }
      resolve(Buffer.concat(chunks))
    })
    req.end(EMPTY_REQUEST)
  })
  const doc: unknown = JSON.parse(decodeFetchAllFlagsResponse(firstMessage(body)))
  return parseFlagDocument(doc) ?? new Map()
}

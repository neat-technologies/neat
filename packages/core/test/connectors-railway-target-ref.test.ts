import { describe, it, expect } from 'vitest'
import { decodeRailwayTargetRef } from '../src/connectors/railway/target-ref.js'

// The encode side lives in neat-infra (RailwayConnectDriver.listProjects); this mirrors it locally so the
// round-trip is asserted without a cross-repo dependency — the ref format is the contract both sides hold.
function encode(fields: { environmentId: string; serviceId: string; serviceName?: string }): string {
  return Buffer.from(JSON.stringify(fields)).toString('base64url')
}

describe('decodeRailwayTargetRef', () => {
  it('round-trips an (environmentId, serviceId, serviceName) composite ref', () => {
    const ref = encode({ environmentId: 'env_1', serviceId: 'svc_9', serviceName: 'api' })
    expect(decodeRailwayTargetRef(ref)).toEqual({
      environmentId: 'env_1',
      serviceId: 'svc_9',
      serviceName: 'api',
    })
  })

  it('decodes when serviceName is absent — the daemon only needs the two ids', () => {
    const ref = encode({ environmentId: 'env_1', serviceId: 'svc_9' })
    expect(decodeRailwayTargetRef(ref)).toEqual({ environmentId: 'env_1', serviceId: 'svc_9' })
  })

  it('drops a non-empty serviceName that is not a string, keeping the ids', () => {
    const ref = Buffer.from(
      JSON.stringify({ environmentId: 'e', serviceId: 's', serviceName: 42 }),
    ).toString('base64url')
    expect(decodeRailwayTargetRef(ref)).toEqual({ environmentId: 'e', serviceId: 's' })
  })

  it('returns null for a ref missing either id', () => {
    expect(decodeRailwayTargetRef(encode({ environmentId: 'e', serviceId: '' }))).toBeNull()
    expect(
      decodeRailwayTargetRef(Buffer.from(JSON.stringify({ serviceId: 's' })).toString('base64url')),
    ).toBeNull()
  })

  it('returns null for a ref whose ids are the wrong type', () => {
    const ref = Buffer.from(JSON.stringify({ environmentId: 1, serviceId: 2 })).toString('base64url')
    expect(decodeRailwayTargetRef(ref)).toBeNull()
  })

  it('returns null for non-base64 / non-JSON / empty input, never throwing', () => {
    expect(decodeRailwayTargetRef('')).toBeNull()
    // base64url of a plain (non-JSON) string.
    expect(decodeRailwayTargetRef(Buffer.from('not json at all').toString('base64url'))).toBeNull()
    // base64url of a JSON primitive, not an object.
    expect(decodeRailwayTargetRef(Buffer.from('"just-a-string"').toString('base64url'))).toBeNull()
  })
})

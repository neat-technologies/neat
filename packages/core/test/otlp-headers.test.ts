import { describe, it, expect } from 'vitest'
import { otlpBearerHeader, OTLP_BEARER_PREFIX } from '../src/otlp-headers.js'
import { renderOtelEnvBlock as deployEnvBlock } from '../src/deploy/detect.js'
import { renderOtelEnvBlock as summaryEnvBlock } from '../src/summary.js'
import { OTEL_OTLP_HEADERS_JS } from '../src/installers/templates.js'

// #1339 — OTEL_EXPORTER_OTLP_HEADERS values are URL-encoded per the OTLP
// exporter spec. A raw space after `Bearer` is dropped by a strict parser (the
// Python SDK's liberal=False), so the exporter sends no Authorization and the
// daemon answers 401. Every place NEAT prints or sets the header uses %20.

describe('otlpBearerHeader', () => {
  it('encodes the space and the token', () => {
    expect(otlpBearerHeader('abc123')).toBe('Authorization=Bearer%20abc123')
    expect(otlpBearerHeader('a+b/c=')).toBe('Authorization=Bearer%20a%2Bb%2Fc%3D')
    expect(OTLP_BEARER_PREFIX).toBe('Authorization=Bearer%20')
  })
})

describe('printed OTEL_EXPORTER_OTLP_HEADERS lines', () => {
  it('neat deploy prints the encoded form', () => {
    const block = deployEnvBlock('tok-1', 'neat.example.com')
    expect(block).toContain('OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20tok-1')
    expect(block).not.toMatch(/Bearer /)
  })

  it('the orchestrator summary prints the encoded form', () => {
    const block = summaryEnvBlock()
    expect(block).toContain('OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<NEAT_AUTH_TOKEN>')
    expect(block).not.toMatch(/Bearer </)
  })

  it('the generated otel-init sets the encoded form', () => {
    const env: Record<string, string | undefined> = { NEAT_OTEL_TOKEN: 'a+b' }
    new Function('process', OTEL_OTLP_HEADERS_JS)({ env })
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=Bearer%20a%2Bb')
  })
})

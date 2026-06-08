import { describe, expect, it } from 'vitest'
import { resolveBaseUrl } from '../src/base-url.js'

// #488 — the MCP server read only NEAT_CORE_URL, but `neat skill --apply` wrote
// NEAT_API_URL into the generated config. On the default port it worked by
// accident (fallback to localhost:8080); it broke silently the moment the
// daemon wasn't at that default — the hosted-customer case. The server now
// honors both names.

describe('resolveBaseUrl', () => {
  it('reads NEAT_API_URL when NEAT_CORE_URL is unset (the skill-generated case)', () => {
    expect(resolveBaseUrl({ NEAT_API_URL: 'http://daemon.internal:9000' })).toBe(
      'http://daemon.internal:9000',
    )
  })

  it('NEAT_CORE_URL wins when both are set', () => {
    expect(
      resolveBaseUrl({
        NEAT_CORE_URL: 'http://core.internal:9000',
        NEAT_API_URL: 'http://api.internal:9001',
      }),
    ).toBe('http://core.internal:9000')
  })

  it('falls back to localhost:8080 when neither is set', () => {
    expect(resolveBaseUrl({})).toBe('http://localhost:8080')
  })
})

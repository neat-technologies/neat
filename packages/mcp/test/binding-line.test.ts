import { afterEach, describe, expect, it } from 'vitest'
import {
  formatEmptyResponse,
  formatErrorResponse,
  formatToolResponse,
  setBindingLine,
} from '../src/format.js'

// The §6 binding line is server-wide state, so reset it after every case so the
// cases don't leak into each other or into the rest of the MCP test suite.
afterEach(() => setBindingLine(undefined))

const LINE = 'project=newdryve (prj_01JB6K3Z8Q9W2N4R5T7V8X0Y1A) · binding=local · daemon=http://localhost:8080'

describe('setBindingLine (project-identity.md §6)', () => {
  it('appends the binding line directly under the footer of a normal result', () => {
    setBindingLine(LINE)
    const text = formatToolResponse({
      summary: 'checkout depends on payments-db',
      confidence: 0.9,
      provenance: 'OBSERVED',
    }).content[0].text
    expect(text).toContain('confidence: 0.90 · provenance: OBSERVED')
    // Rides one newline under the footer, as the last line of the response.
    expect(text.endsWith(`confidence: 0.90 · provenance: OBSERVED\n${LINE}`)).toBe(true)
  })

  it('carries the binding line on an error result too (error path inherits it)', () => {
    setBindingLine(LINE)
    const res = formatErrorResponse('daemon unreachable')
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain(LINE)
  })

  it('carries the binding line on an empty result too', () => {
    setBindingLine(LINE)
    expect(formatEmptyResponse('no root cause found').content[0].text).toContain(LINE)
  })

  it('leaves the output exactly as before when no binding line is set', () => {
    const text = formatToolResponse({ summary: 'ok' }).content[0].text
    expect(text).toContain('confidence: n/a · provenance: n/a')
    expect(text).not.toContain('binding=')
  })
})

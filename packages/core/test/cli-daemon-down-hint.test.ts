import { describe, it, expect } from 'vitest'
import { isLoopbackEndpoint } from '../src/cli.js'

// docs/contracts/cli-surface.md §REST-only data path — a query verb that can't
// reach its daemon still exits 3 with the "is the daemon running?" message. It
// now also names the command that starts one, but only when the daemon is on
// this machine: a hosted or remote endpoint is not the user's to start, and
// `neat watch` against one would build a graph in the wrong place (#1250).

describe('isLoopbackEndpoint — gates the "start one" hint', () => {
  it('is true for a daemon on this machine', () => {
    expect(isLoopbackEndpoint('http://localhost:8080')).toBe(true)
    expect(isLoopbackEndpoint('http://127.0.0.1:8080')).toBe(true)
    expect(isLoopbackEndpoint('http://127.0.0.1:18080/')).toBe(true)
    expect(isLoopbackEndpoint('http://[::1]:8080')).toBe(true)
  })

  it('is false for a hosted or remote daemon — not ours to start', () => {
    expect(isLoopbackEndpoint('https://neat-acme.run.app')).toBe(false)
    expect(isLoopbackEndpoint('https://api.neat.is')).toBe(false)
    expect(isLoopbackEndpoint('http://10.0.0.5:8080')).toBe(false)
    expect(isLoopbackEndpoint('http://neat.internal:8080')).toBe(false)
  })

  it('is false for anything that is not a parseable absolute URL, rather than guessing', () => {
    expect(isLoopbackEndpoint('')).toBe(false)
    expect(isLoopbackEndpoint('localhost:8080')).toBe(false)
    expect(isLoopbackEndpoint('not a url')).toBe(false)
  })
})

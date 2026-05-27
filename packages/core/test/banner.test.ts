import { describe, it, expect, vi } from 'vitest'
import { printBanner, readPackageVersion } from '../src/cli.js'

describe('printBanner', () => {
  it('prints the installed package version, not a hardcoded literal', () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      lines.push(String(msg ?? ''))
    })
    try {
      printBanner()
    } finally {
      spy.mockRestore()
    }

    const versionLine = lines.find((l) => l.includes('neat.is'))
    expect(versionLine).toBeDefined()
    // The banner must reflect whatever version the package ships at — the same
    // single source `neat version` reads — so a release bump can't leave it stale.
    expect(versionLine).toContain(`v${readPackageVersion()}`)
  })
})

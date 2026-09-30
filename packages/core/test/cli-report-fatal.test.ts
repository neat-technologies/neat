import { describe, expect, it } from 'vitest'
import { reportFatal } from '../src/cli.js'
import { RegistryError, RegistryLockError } from '../src/registry.js'

// #1241 — a registry lock held by a live process is a condition with a fix, and
// its message says both. It reached the terminal as an uncaught throw, buried
// under frames of the bundled CLI. The boundary prints the message on its own.

describe('reportFatal', () => {
  it('prints a held registry lock as one line, no stack', () => {
    const lines: unknown[] = []
    const err = new RegistryLockError(
      "Another neat command (pid 4242) is holding the registry lock. Wait for it to finish, or check `ps` if you're not sure what's running.",
    )
    expect(reportFatal(err, (l) => lines.push(l))).toBe(1)
    expect(lines).toEqual([`neat: ${err.message}`])
    expect(String(lines[0])).not.toContain('    at ')
  })

  it('does the same for any registry error', () => {
    const lines: unknown[] = []
    reportFatal(new RegistryError('no project named "ghost"'), (l) => lines.push(l))
    expect(lines).toEqual(['neat: no project named "ghost"'])
  })

  it('keeps the stack for an error nobody expected', () => {
    const lines: unknown[] = []
    const bug = new TypeError('x is not a function')
    expect(reportFatal(bug, (l) => lines.push(l))).toBe(1)
    expect(lines).toEqual([bug])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIngestFaultHandlers } from '../src/neatd.js'

// Daemon fault model (daemon contract §Fault containment, ADR-112): an ingest
// unhandledRejection is contained (the daemon keeps serving), while an
// uncaughtException stays fatal (the process exits non-zero, so supervision
// restarts it clean rather than serving from an undefined state).
describe('neatd ingest fault containment (ADR-112)', () => {
  let consoleErr: ReturnType<typeof vi.spyOn>
  let priorRejection: NodeJS.UnhandledRejectionListener[]
  let priorUncaught: NodeJS.UncaughtExceptionListener[]

  beforeEach(() => {
    consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    priorRejection = process.listeners('unhandledRejection')
    priorUncaught = process.listeners('uncaughtException')
  })

  afterEach(() => {
    // Remove only the handlers this test installed, restoring the pre-test set.
    for (const l of process.listeners('unhandledRejection')) {
      if (!priorRejection.includes(l)) process.removeListener('unhandledRejection', l)
    }
    for (const l of process.listeners('uncaughtException')) {
      if (!priorUncaught.includes(l)) process.removeListener('uncaughtException', l)
    }
    consoleErr.mockRestore()
  })

  it('contains an unhandledRejection (keeps serving) but exits on uncaughtException', () => {
    const exits: number[] = []
    installIngestFaultHandlers((code) => exits.push(code))

    const added = (
      before: readonly unknown[],
      after: readonly unknown[],
    ): unknown[] => after.filter((l) => !before.includes(l))

    const rejectionHandlers = added(priorRejection, process.listeners('unhandledRejection'))
    const uncaughtHandlers = added(priorUncaught, process.listeners('uncaughtException'))
    expect(rejectionHandlers).toHaveLength(1)
    expect(uncaughtHandlers).toHaveLength(1)

    // A rejected promise escaping the ingest drain loop: logged, no exit.
    ;(rejectionHandlers[0] as NodeJS.UnhandledRejectionListener)(
      new Error('ingest promise boom'),
      Promise.resolve(),
    )
    expect(exits).toEqual([])
    expect(consoleErr).toHaveBeenCalled()

    // A synchronous throw reaching the top of the stack: fatal, exit non-zero.
    ;(uncaughtHandlers[0] as NodeJS.UncaughtExceptionListener)(
      new Error('ingest sync boom'),
      'uncaughtException',
    )
    expect(exits).toEqual([1])
  })
})

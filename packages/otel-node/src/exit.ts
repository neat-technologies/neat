// Flush spans when the instrumented process ends (#1353).
//
// The batch span processor holds spans for up to its schedule delay, so a
// process that finishes its work and exits on its own drops the last batch. For
// a short-lived process (a script, a CLI, a job, a test run) that is every span
// it made. On a natural exit (`beforeExit`) and on SIGTERM/SIGINT the SDK is
// shut down, which exports what's pending, under a bounded wait: an exporter
// that hangs must never hold a CLI open past `timeoutMs`.

interface Shutdownable {
  shutdown: () => Promise<unknown>
}

export const DEFAULT_EXIT_FLUSH_MS = 2000

export function flushOnExit(sdk: Shutdownable, timeoutMs: number = DEFAULT_EXIT_FLUSH_MS): void {
  let flushing: Promise<void> | undefined
  const flush = (): Promise<void> => {
    if (!flushing) {
      flushing = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
        Promise.resolve()
          .then(() => sdk.shutdown())
          .catch(() => {})
          .then(() => {
            clearTimeout(timer)
            resolve()
          })
      })
    }
    return flushing
  }

  // The event loop drained: flush, then finish the exit the app was making. The
  // explicit exit is what stops a hung export socket from keeping it alive.
  process.once('beforeExit', (code) => {
    void flush().then(() => process.exit(process.exitCode ?? code))
  })

  // A signal: flush, then keep the signal's meaning. If the app has its own
  // handler it owns the exit; if ours was the only one, re-raise the signal so
  // the default (terminate with the signal) still happens.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      const alone = process.listenerCount(signal) === 0
      void flush().then(() => {
        if (alone) process.kill(process.pid, signal)
      })
    })
  }
}

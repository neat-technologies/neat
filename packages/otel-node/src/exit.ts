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
  // Resolves true when the flush ran out of time rather than finishing.
  let flushing: Promise<boolean> | undefined
  const flush = (): Promise<boolean> => {
    if (!flushing) {
      flushing = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), timeoutMs)
        timer.unref?.()
        Promise.resolve()
          .then(() => sdk.shutdown())
          .catch(() => {})
          .then(() => {
            clearTimeout(timer)
            resolve(false)
          })
      })
    }
    return flushing
  }

  // The event loop drained: flush. A flush that finishes lets the exit happen
  // the normal way, so an app's own async cleanup in beforeExit still runs. Only
  // a flush that timed out (a hung export socket keeping the loop alive) forces
  // the exit, with the app's exit code.
  process.once('beforeExit', (code) => {
    void flush().then((timedOut) => {
      if (timedOut) process.exit(process.exitCode ?? code)
    })
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

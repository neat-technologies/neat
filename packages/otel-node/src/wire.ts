// Wires NEAT's call-site processor onto a started NodeSDK. The OTel modules are
// injected (not imported here) so the CJS entry can load them synchronously
// (`--require` needs init ordering preserved) and the ESM entry can `await
// import` them (top-level await), without this file having to be built twice.
import { NeatCallSiteSpanProcessor, installFacades } from './processor.js'
import { applyNeatEnv, loadExtraInstrumentations } from './env.js'
import { flushOnExit } from './exit.js'

// Shared with the processor's context wraps; keeps a double `--require` +
// `--import` (or a leftover injected init) from registering twice in one process.
const REGISTERED = Symbol.for('neat.otel.registered')

export interface WireDeps {
  NodeSDK: new (config: { instrumentations: unknown[] }) => { start: () => void; shutdown?: () => Promise<unknown> }
  getNodeAutoInstrumentations: () => unknown
  trace: { getTracerProvider: () => unknown }
}

export function wire(deps: WireDeps): void {
  const g = globalThis as unknown as Record<symbol, unknown>
  if (g[REGISTERED]) return
  g[REGISTERED] = true

  // Endpoint, auth header and protocol, set before the SDK reads them.
  applyNeatEnv()
  const sdk = new deps.NodeSDK({
    instrumentations: [deps.getNodeAutoInstrumentations(), ...loadExtraInstrumentations()],
  })
  sdk.start()
  // Export what's pending when the process ends, bounded (#1353).
  if (typeof sdk.shutdown === 'function') flushOnExit({ shutdown: () => sdk.shutdown!() })

  // NodeSDK keeps its env-configured OTLP exporter; add the call-site processor
  // to the started provider via addSpanProcessor (passing spanProcessors to the
  // constructor would replace the exporter). Assert it attached — a silent
  // wiring miss would ship service-level-only spans (file-awareness.md §4).
  const provider = deps.trace.getTracerProvider() as {
    getDelegate?: () => unknown
  }
  const delegate = (provider && typeof provider.getDelegate === 'function' ? provider.getDelegate() : provider) as {
    addSpanProcessor?: (p: unknown) => void
    _registeredSpanProcessors?: unknown[]
  }
  if (!delegate || typeof delegate.addSpanProcessor !== 'function') {
    throw new Error(
      '[neat] could not resolve a TracerProvider to attach the call-site processor; file-first OBSERVED capture would be silent',
    )
  }
  const processor = new NeatCallSiteSpanProcessor()
  delegate.addSpanProcessor(processor)
  const registered = delegate._registeredSpanProcessors
  if (Array.isArray(registered) && registered.indexOf(processor) === -1) {
    throw new Error('[neat] call-site processor did not attach to the active TracerProvider')
  }

  try {
    installFacades()
  } catch {
    // Facade install is best-effort: the stack-walk + handler-entry floor still
    // attributes the sync-wrapper majority even if an off-stack wrap fails.
  }
}

// Instrumentation is ambient — it must never break the host app. The entry
// shims call this when SDK setup throws, so a missing OTel dep or a wiring fault
// degrades to running WITHOUT observed tracing rather than crashing the process.
export function warnInactive(err: unknown): void {
  const msg = String((err as { message?: string } | undefined)?.message ?? err)
  if (/Cannot find (?:module|package)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(msg)) {
    console.warn(
      '[neat] OpenTelemetry is not active: its packages are not installed, so this app is running without OBSERVED tracing.',
    )
  } else {
    console.warn('[neat] OpenTelemetry failed to start; the app is running without OBSERVED tracing: ' + msg)
  }
}

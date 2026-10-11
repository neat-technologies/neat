// Feature-flag evaluations as OBSERVED data, through OpenFeature.
//
// A flag the app reads at runtime left no trace on its spans: a request that
// failed because `cartFailure` was on showed only the downstream error, never
// the flag. When the app already uses the OpenFeature server SDK, this adds an
// API-level hook that records each evaluation as a `feature_flag.evaluation`
// event on the span active at the time (OTel semconv), so the flag rides along
// with the service and call site that read it. Reason and error type are
// lowercased, as semconv and OpenFeature's own telemetry write them.
//
// Nothing is added to the app: the hook is registered when the app itself loads
// `@openfeature/server-sdk`, and an app without it never loads this path. The
// evaluation context (targeting key, user attributes) is never recorded.

import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation'
import { trace, type Attributes } from '@opentelemetry/api'

const HOOKED = Symbol.for('neat.openfeature.hooked')

export const FLAG_EVENT = 'feature_flag.evaluation'

interface HookContextLike {
  flagKey?: unknown
  defaultValue?: unknown
  providerMetadata?: { name?: unknown }
}

interface DetailsLike {
  value?: unknown
  variant?: unknown
  reason?: unknown
}

interface OpenFeatureLike {
  addHooks: (...hooks: unknown[]) => unknown
}

// A scalar flag value as a string; objects are skipped (they can be large and
// carry config the graph has no use for).
function scalar(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

/** The event's attributes for one evaluation; `err` set when it errored. */
export function flagEventAttributes(ctx: HookContextLike, details?: DetailsLike, err?: unknown): Attributes | undefined {
  if (typeof ctx.flagKey !== 'string' || !ctx.flagKey) return undefined
  const attrs: Attributes = { 'feature_flag.key': ctx.flagKey }
  const provider = ctx.providerMetadata?.name
  if (typeof provider === 'string' && provider) attrs['feature_flag.provider.name'] = provider
  if (err !== undefined) {
    // An errored evaluation hands the caller its code default.
    const code = (err as { code?: unknown })?.code
    attrs['error.type'] = typeof code === 'string' && code ? code.toLowerCase() : 'general'
    attrs['feature_flag.result.reason'] = 'error'
    const value = scalar(ctx.defaultValue)
    if (value !== undefined) attrs['feature_flag.result.value'] = value
    return attrs
  }
  if (typeof details?.variant === 'string' && details.variant) attrs['feature_flag.result.variant'] = details.variant
  if (typeof details?.reason === 'string' && details.reason) attrs['feature_flag.result.reason'] = details.reason.toLowerCase()
  const value = scalar(details?.value)
  if (value !== undefined) attrs['feature_flag.result.value'] = value
  return attrs
}

function record(attrs: Attributes | undefined): void {
  if (!attrs) return
  const span = trace.getActiveSpan()
  // No span in scope (a flag read at boot): there is nothing to attach it to.
  if (!span || !span.isRecording()) return
  span.addEvent(FLAG_EVENT, attrs)
}

/** The OpenFeature hook. `after` runs on success, `error` on a failed evaluation. */
export const flagEvaluationHook = {
  after(ctx: HookContextLike, details: DetailsLike): void {
    try {
      record(flagEventAttributes(ctx, details))
    } catch {
      // never break flag evaluation
    }
  },
  error(ctx: HookContextLike, err: unknown): void {
    try {
      record(flagEventAttributes(ctx, undefined, err))
    } catch {
      // never break flag evaluation
    }
  },
}

/** Adds the hook to the OpenFeature API singleton, once per process. */
export function attachFlagHook(api: OpenFeatureLike | undefined): void {
  if (!api || typeof api.addHooks !== 'function') return
  const marked = api as unknown as Record<symbol, boolean>
  if (marked[HOOKED]) return
  marked[HOOKED] = true
  api.addHooks(flagEvaluationHook)
}

export class OpenFeatureInstrumentation extends InstrumentationBase {
  constructor() {
    super('@neat.is/instrumentation-openfeature', '1.0.0', {})
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition(
        '@openfeature/server-sdk',
        ['>=1 <2'],
        (exports: unknown) => {
          try {
            const mod = exports as { OpenFeature?: OpenFeatureLike; default?: { OpenFeature?: OpenFeatureLike } }
            attachFlagHook(mod.OpenFeature ?? mod.default?.OpenFeature)
          } catch {
            // Instrumentation never breaks the app.
          }
          return exports
        },
        (exports: unknown) => exports,
      ),
    ]
  }
}

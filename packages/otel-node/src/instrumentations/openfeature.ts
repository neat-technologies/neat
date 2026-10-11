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

/** Longest string value recorded, in code points; a longer one is cut. */
export const MAX_FLAG_VALUE_LENGTH = 128

// A scalar flag value as a string; objects are skipped (they can be large and
// carry config the graph has no use for). A string flag can still hold config,
// so it's cut at MAX_FLAG_VALUE_LENGTH; ingest redacts what's left.
function setValue(attrs: Attributes, v: unknown): void {
  if (typeof v === 'number' || typeof v === 'boolean') {
    attrs['feature_flag.result.value'] = String(v)
  } else if (typeof v === 'string') {
    const points = Array.from(v)
    if (points.length > MAX_FLAG_VALUE_LENGTH) {
      attrs['feature_flag.result.value'] = points.slice(0, MAX_FLAG_VALUE_LENGTH).join('')
      attrs['feature_flag.result.value_truncated'] = true
    } else {
      attrs['feature_flag.result.value'] = v
    }
  }
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
    setValue(attrs, ctx.defaultValue)
    return attrs
  }
  if (typeof details?.variant === 'string' && details.variant) attrs['feature_flag.result.variant'] = details.variant
  if (typeof details?.reason === 'string' && details.reason) attrs['feature_flag.result.reason'] = details.reason.toLowerCase()
  setValue(attrs, details?.value)
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

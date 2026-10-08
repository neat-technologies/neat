// Attachment entry: `node --import @neat.is/otel-node/register`.
// ESM apps need the import-in-the-middle loader hook — `--import` of the SDK
// setup alone does NOT patch ESM imports (even node: builtins). Register the
// hook first, then set up the SDK (top-level await blocks the app until ready).
import { register } from 'node:module'

const pick = (m, k) => (m && k in m ? m[k] : m && m.default && m.default[k])

try {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)
} catch (_e) {
  // Older Node without module.register(): the SDK still starts; ESM patching of
  // third-party imports degrades to the stack-walk + context floor.
}

try {
  const NodeSDK = pick(await import('@opentelemetry/sdk-node'), 'NodeSDK')
  const getNodeAutoInstrumentations = pick(
    await import('@opentelemetry/auto-instrumentations-node'),
    'getNodeAutoInstrumentations',
  )
  const trace = pick(await import('@opentelemetry/api'), 'trace')
  const mod = await import('./dist/index.js')
  mod.wire({ NodeSDK, getNodeAutoInstrumentations, trace })
} catch (err) {
  try {
    const mod = await import('./dist/index.js')
    mod.warnInactive(err)
  } catch (_e) {
    console.warn('[neat] OpenTelemetry failed to start; running without OBSERVED tracing: ' + err)
  }
}

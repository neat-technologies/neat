// Attachment entry: `node --import @neat.is/otel-node/register`.
// ESM apps need the import-in-the-middle loader hook — `--import` of the SDK
// setup alone does NOT patch ESM imports (even node: builtins). Register the
// hook first, then set up the SDK (top-level await blocks the app until ready).
import { createRequire, register } from 'node:module'

const pick = (m, k) => (m && k in m ? m[k] : m && m.default && m.default[k])

try {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)
} catch (_e) {
  // Older Node without module.register(): the SDK still starts; ESM patching of
  // third-party imports degrades to the stack-walk + context floor.
}

// The handler-entry and off-stack facades hook modules as the app loads them.
// This build has no `require` of its own, so hand it one. An ESM `import
// express` never passes through require(), so also hand over import-in-the-
// middle's Hook, resolved through @opentelemetry/instrumentation: the hook only
// fires when it is the same copy as the loader registered above.
function moduleLoaders() {
  const req = createRequire(import.meta.url)
  let ImportHook
  try {
    const iitm = createRequire(req.resolve('@opentelemetry/instrumentation'))('import-in-the-middle')
    ImportHook = iitm.Hook || (iitm.default && iitm.default.Hook) || iitm
  } catch (_e) {
    // No import hook: CJS loads are still wrapped; ESM imports fall back to the
    // stack-walk + context floor.
  }
  return { require: req, ImportHook }
}

try {
  const NodeSDK = pick(await import('@opentelemetry/sdk-node'), 'NodeSDK')
  const getNodeAutoInstrumentations = pick(
    await import('@opentelemetry/auto-instrumentations-node'),
    'getNodeAutoInstrumentations',
  )
  const trace = pick(await import('@opentelemetry/api'), 'trace')
  const mod = await import('./dist/index.js')
  mod.wire({ NodeSDK, getNodeAutoInstrumentations, trace, loaders: moduleLoaders() })
} catch (err) {
  try {
    const mod = await import('./dist/index.js')
    mod.warnInactive(err)
  } catch (_e) {
    console.warn('[neat] OpenTelemetry failed to start; running without OBSERVED tracing: ' + err)
  }
}

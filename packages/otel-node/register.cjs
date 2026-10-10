'use strict'
// Attachment entry: `node --require @neat.is/otel-node/register`.
// Loads the OTel SDK synchronously so init ordering is preserved before the app
// module runs, then wires NEAT's call-site processor. Ambient-safe: a missing
// dep or a wiring fault degrades to running without OBSERVED tracing, never a
// crash of the host app.
try {
  const { NodeSDK } = require('@opentelemetry/sdk-node')
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node')
  const { trace } = require('@opentelemetry/api')
  require('./dist/index.cjs').wire({ NodeSDK, getNodeAutoInstrumentations, trace })
} catch (err) {
  try {
    require('./dist/index.cjs').warnInactive(err)
  } catch (_e) {
    console.warn('[neat] OpenTelemetry failed to start; running without OBSERVED tracing: ' + err)
  }
}

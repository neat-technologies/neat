// @neat.is/otel-node — the runtime-attachment form of NEAT's Node call-site
// stamper. Attach it with `node --require @neat.is/otel-node/register` (CJS) or
// `node --import @neat.is/otel-node/register` (ESM); NEAT's OBSERVED spans then
// carry `code.file.path` / `code.line.number` / `code.function.name` and fuse to
// the static symbol graph — with no edit to the app's source.
export { wire, warnInactive } from './wire.js'
export { applyNeatEnv, endpointFromDaemonRecord, loadExtraInstrumentations } from './env.js'
export type { WireDeps } from './wire.js'
export { NeatCallSiteSpanProcessor, pickUserFrame, installFacades } from './processor.js'
export type { UserFrame } from './processor.js'
export { PostgresJsInstrumentation, statementOf } from './instrumentations/postgres-js.js'

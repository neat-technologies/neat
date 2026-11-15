import type { AttributeValue } from './otel.js'

// OpenTelemetry code.* attribute readers. A leaf module so every reader of the
// call-site attributes (ingest, traverse, divergences) shares one definition
// without importing ingest.ts.
export const CODE_FILE_PATH_ATTR = 'code.file.path' // semconv ≥1.33 (stable)
export const CODE_FILEPATH_ATTR = 'code.filepath' // prior convention
export const CODE_LINE_NUMBER_ATTR = 'code.line.number'
export const CODE_LINENO_ATTR = 'code.lineno'
export const CODE_FUNCTION_NAME_ATTR = 'code.function.name'
export const CODE_FUNCTION_ATTR = 'code.function'

// Read the source call site off an attribute bag, accepting the stable
// (semconv ≥1.33) and prior attribute names. Exported so every code.* reader —
// edge attribution here, incident localization in traverse.ts — shares one
// definition and the names can't drift across sites.
export function codeFilepathOf(attrs: Record<string, AttributeValue>): string | undefined {
  const stable = attrs[CODE_FILE_PATH_ATTR]
  if (typeof stable === 'string' && stable.length > 0) return stable
  const prior = attrs[CODE_FILEPATH_ATTR]
  return typeof prior === 'string' && prior.length > 0 ? prior : undefined
}
export function codeLinenoOf(attrs: Record<string, AttributeValue>): number | undefined {
  const stable = attrs[CODE_LINE_NUMBER_ATTR]
  if (typeof stable === 'number' && Number.isFinite(stable)) return stable
  const prior = attrs[CODE_LINENO_ATTR]
  return typeof prior === 'number' && Number.isFinite(prior) ? prior : undefined
}
export function codeFunctionOf(attrs: Record<string, AttributeValue>): string | undefined {
  const stable = attrs[CODE_FUNCTION_NAME_ATTR]
  if (typeof stable === 'string' && stable.length > 0) return stable
  const prior = attrs[CODE_FUNCTION_ATTR]
  return typeof prior === 'string' && prior.length > 0 ? prior : undefined
}

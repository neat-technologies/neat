// The security engine's public entry (ADR-274), for callers outside core: the
// PR gate in neat-action and the CLI. `@neat.is/core/security`.
export { buildSecurityCard, buildSecurityCards, highestLevel, rankSecurityCards } from './security-card.js'
export { isReachable, scanProjectCves, type ScanOptions } from './security-scan.js'
export {
  diffSecurityCards,
  materializeRef,
  resolveRevision,
  scanDiffGraphs,
  scanDiffLocal,
  type ScanDiffOptions,
} from './security-diff.js'
export {
  applyFixAction,
  applyFixes,
  applyAndReverify,
  type ApplyOptions,
  type ApplyOutcome,
  type DepApplyResult,
  type FileEdit,
  type ReverifyResult,
} from './security-apply.js'

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// Issue #434. The multi-project daemon builds an IngestContext at each of its
// handleSpan call sites. relPathForRuntimeFile (ingest.ts) anchors a runtime
// code.filepath against ctx.scanPath to recover the service-root-relative path
// (file-awareness.md §4, issue #430); with no scanPath the absolute path leaks
// into the FileNode key on the multi-project surface every real install runs
// on. watch.ts — the single-project `neat dev` path — already wires scanPath,
// so handleSpan unit tests and `neat dev` look clean while neatd regressed.
//
// This guards the wiring at the source: a dropped scanPath fails CI instead of
// surfacing later as absolute-path FileNode keys in a live graph. A behavioural
// version would have to stand up the daemon's OTLP receiver and drive a span
// through it; the regression lives entirely in the literal, so reading the
// source is the honest, deterministic check.

const HERE = dirname(fileURLToPath(import.meta.url))
const daemonSrc = readFileSync(join(HERE, '..', 'src', 'daemon.ts'), 'utf8')

describe('daemon wires scanPath into every IngestContext (issue #434)', () => {
  it('hands scanPath: slot.entry.path to ingest at each handleSpan call site', () => {
    // Each handleSpan call passes an IngestContext literal followed by `span,`.
    // Slice from each call to that argument boundary and assert the literal
    // wires scanPath. Scoping to the call site keeps the unrelated
    // `scanPath: slot.entry.path` in upsertRegistryFromSlot (the Projects
    // registry mirror) out of the assertion.
    const callBlocks = daemonSrc.split(/await handleSpan\(/).slice(1)
    expect(callBlocks.length).toBeGreaterThan(0)

    for (const block of callBlocks) {
      const boundary = block.indexOf('span,')
      const ctxLiteral = boundary === -1 ? block : block.slice(0, boundary)
      expect(ctxLiteral).toMatch(/scanPath:\s*slot\.entry\.path\b/)
    }
  })
})

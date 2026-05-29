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
    const callSites = daemonSrc.match(/await handleSpan\(/g) ?? []
    expect(callSites.length).toBeGreaterThan(0)

    const scanPathWirings = daemonSrc.match(/scanPath:\s*slot\.entry\.path\b/g) ?? []
    expect(scanPathWirings.length).toBe(callSites.length)
  })
})

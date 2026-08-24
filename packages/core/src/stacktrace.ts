// ──────────────────────────────────────────────────────────────────────────
// Stacktrace code-locus recovery (ADR-216)
//
// An OBSERVED exception span often carries `exception.stacktrace` but no
// `code.*` semconv attributes — Python auto-instrumentation records the
// exception through `record_exception` without stamping a call site, and the
// same is true of many runtimes' exception recording. The declaring file:line
// is still named, plainly, inside the stacktrace text. This module recovers the
// deepest APPLICATION frame from that text so incident localization can join it
// to a FileNode / SymbolNode the graph already carries — turning a service-level
// incident back into the code-grain locus the fusion query needs.
//
// It keys STRICTLY on generic frame syntax and generic vendor-prefix markers,
// never on a language / framework / provider name (ADR-158 §6). A new frame
// shape is a new row in FRAME_SHAPES; a new vendor marker a new row in
// VENDOR_MARKERS. There is no per-language branch anywhere below.
// ──────────────────────────────────────────────────────────────────────────

export interface StackFrame {
  file: string
  line: number
  fn?: string
}

// One frame syntax. `deepest` records where the throw-site frame sits among the
// matches of THIS shape — a property of the syntax, not of any language: the
// `File "…", line N` shape lists most-recent last (the raising line is at the
// bottom of the trace), the `at …` shapes list most-recent first (the throw
// site is at the top). Keying an ordering convention on the frame syntax is
// keying on syntax, which ADR-158 §6 permits; keying on the language that uses
// the syntax is what it forbids.
interface FrameShape {
  re: RegExp
  file: number // capture-group index of the file path
  line: number // capture-group index of the line number
  fn?: number // capture-group index of the function name, when the shape carries one
  deepest: 'first' | 'last'
}

const FRAME_SHAPES: readonly FrameShape[] = [
  // `File "<path>", line <N>, in <func>` — the "most recent call last" shape.
  { re: /File "([^"]+)", line (\d+)(?:, in (\S+))?/, file: 1, line: 2, fn: 3, deepest: 'last' },
  // `at <func> (<path>:<line>:<col>)` — named call frame, most recent first.
  { re: /\bat\s+(.+?)\s+\((.+?):(\d+):\d+\)/, file: 2, line: 3, fn: 1, deepest: 'first' },
  // `at <path>:<line>:<col>` — anonymous call frame, most recent first.
  { re: /\bat\s+(.+?):(\d+):\d+/, file: 1, line: 2, deepest: 'first' },
  // `at <qualified.method>(<File.ext>:<line>)` — JVM-style, most recent first.
  { re: /\bat\s+(.+?)\((\S+\.\w+):(\d+)\)/, file: 2, line: 3, fn: 1, deepest: 'first' },
]

// Generic markers for a non-application (runtime / vendor / dependency) frame —
// directory conventions and synthetic-frame forms, no language or provider name.
// A frame whose file path contains any of these is dependency / runtime code,
// not the application's own. The graph join stays the ultimate arbiter: even if
// a frame slips through, incident localization attributes to a code node ONLY
// when the frame resolves to a FileNode the graph carries — so this list picks
// the right application frame, it does not gate honesty.
const VENDOR_MARKERS: readonly string[] = [
  'node_modules', // dependency root
  'site-packages', // installed-package root
  'dist-packages', // distro-packaged root
  'node:', // runtime-internal module scheme (a stdlib/runtime-root frame)
]

interface OrientedFrame {
  frame: StackFrame
  deepest: 'first' | 'last'
}

function matchFrame(line: string): OrientedFrame | null {
  for (const shape of FRAME_SHAPES) {
    const m = shape.re.exec(line)
    if (!m) continue
    const file = m[shape.file]
    const lineNo = Number(m[shape.line])
    if (!file || !Number.isFinite(lineNo)) continue
    const fn = shape.fn !== undefined ? m[shape.fn] : undefined
    return { frame: { file, line: lineNo, ...(fn ? { fn } : {}) }, deepest: shape.deepest }
  }
  return null
}

function isApplicationFrame(file: string): boolean {
  // Synthetic frames (`<frozen importlib._bootstrap>`, `<anonymous>`, `<string>`)
  // name no real source file, so they are never application code.
  if (file.startsWith('<')) return false
  const norm = file.split('\\').join('/')
  for (const marker of VENDOR_MARKERS) {
    if (norm.includes(marker)) return false
  }
  return true
}

// Recover the deepest application frame — the frame nearest the throw site that
// is not runtime / vendor code. Returns null when the stacktrace names no
// application frame at all: an all-vendor trace recovers nothing, so the caller
// keeps its honest service attribution and nothing is fabricated (ADR-158 §6).
export function deepestApplicationFrame(stacktrace: string | undefined): StackFrame | null {
  if (!stacktrace) return null

  const appFrames: OrientedFrame[] = []
  for (const raw of stacktrace.split('\n')) {
    const matched = matchFrame(raw)
    if (!matched) continue
    if (!isApplicationFrame(matched.frame.file)) continue
    appFrames.push(matched)
  }
  if (appFrames.length === 0) return null

  // Orientation is a property of the frame syntax, and a real trace is written
  // in one syntax: the `File "…"` shape puts the throw site last, the `at …`
  // shapes put it first. Read the dominant orientation off the frames we matched
  // and pick the throw-site-nearest application frame among that orientation.
  const orientation: 'first' | 'last' = appFrames.some((f) => f.deepest === 'last')
    ? 'last'
    : 'first'
  const oriented = appFrames.filter((f) => f.deepest === orientation)
  const chosen = orientation === 'last' ? oriented[oriented.length - 1] : oriented[0]
  return chosen ? chosen.frame : null
}
